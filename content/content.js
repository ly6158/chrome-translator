(() => {
  if (window.__aiTranslatorInjected) return;
  window.__aiTranslatorInjected = true;

  const AIT = self.AIT;
  const HOST_ID = 'ai-translator-sidebar-host';
  const MAX_ITEMS_PER_BATCH = 40;
  const LETTER_RE = /\p{L}/u;
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option',
    'code', 'pre', 'kbd', 'samp', 'var', 'svg', 'math', 'canvas', 'iframe', 'object', 'embed',
    '[translate="no"]', '.notranslate',
    '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    `#${HOST_ID}`,
  ].join(',');

  /** Text 节点 -> { original, translated, lang } */
  const records = new Map();

  const state = {
    settings: { ...AIT.DEFAULT_SETTINGS },
    targetLang: AIT.DEFAULT_SETTINGS.targetLang,
    busy: false,
    abort: false,
    view: 'translated', // 'translated' | 'original'
    detected: null, // { code, reliable }
    open: false,
  };

  let ui = null;

  // -------------------------------------------------------------------------
  // 与 background 通信
  // -------------------------------------------------------------------------

  function callBackground(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res) return reject(new Error('后台无响应'));
          if (!res.ok) {
            const err = new Error(res.error);
            err.status = res.status;
            return reject(err);
          }
          resolve(res.data);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function friendlyError(err) {
    const msg = err?.message || String(err);
    if (/context invalidated/i.test(msg)) return '插件已更新或重新加载，请刷新页面后重试。';
    return msg;
  }

  function isFatal(err) {
    return [401, 402, 403, 404].includes(err?.status) || /context invalidated|尚未配置/i.test(err?.message || '');
  }

  // -------------------------------------------------------------------------
  // 页面文本收集
  // -------------------------------------------------------------------------

  /**
   * 收集页面全部文本节点。
   * 只按结构规则跳过（代码块、输入控件等），不按当前可见性过滤：
   * 滚动入场动画、折叠面板、轮播等在翻译时刻可能处于 visibility: hidden /
   * display: none 状态，若把这些节点跳过，稍后展开时会漏翻。
   */
  function collectTextNodes() {
    const nodes = [];
    if (!document.body) return nodes;
    const skipCache = new Map();
    const isSkipped = (el) => {
      let skipped = skipCache.get(el);
      if (skipped === undefined) {
        skipped = !!el.closest(SKIP_SELECTOR);
        skipCache.set(el, skipped);
      }
      return skipped;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !LETTER_RE.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        return isSkipped(parent) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  /** 取节点的原文（节点当前显示译文时返回记录中的原文） */
  function originalOf(node) {
    const rec = records.get(node);
    const value = node.nodeValue;
    return rec && (value === rec.translated || value === rec.original) ? rec.original : value;
  }

  function pruneRecords() {
    for (const node of records.keys()) {
      if (!node.isConnected) records.delete(node);
    }
  }

  // -------------------------------------------------------------------------
  // 语言检测
  // -------------------------------------------------------------------------

  async function detectLanguage(nodes) {
    let sample = '';
    for (const node of nodes) {
      sample += originalOf(node).trim() + '\n';
      if (sample.length > 4000) break;
    }

    let code = null;
    let reliable = false;
    if (sample.trim()) {
      try {
        const res = await callBackground({ type: 'detectLanguage', text: sample });
        const top = res?.languages?.[0];
        if (top?.language && top.language !== 'und') {
          code = top.language;
          reliable = !!res.isReliable;
        }
      } catch (e) {
        // 忽略，退回 <html lang>
      }
    }
    if (!code && document.documentElement.lang) code = document.documentElement.lang;

    state.detected = { code, reliable };
    renderDetected();
    return state.detected;
  }

  // -------------------------------------------------------------------------
  // 翻译
  // -------------------------------------------------------------------------

  async function translatePage() {
    if (state.busy) {
      state.abort = true;
      setMessage('正在停止，等待进行中的请求结束…');
      return;
    }

    const target = state.targetLang;
    state.busy = true;
    state.abort = false;
    render();
    setMessage('');
    setProgress(0, 0, '正在分析页面…');

    try {
      state.settings = await AIT.getSettings();
      if (!AIT.isConfigured(state.settings)) {
        setMessage('尚未配置大模型 API，请先完成设置。', 'error', true);
        return;
      }

      pruneRecords();
      const nodes = collectTextNodes();
      const detected = await detectLanguage(nodes);
      if (detected.code && AIT.isSameLanguage(detected.code, target)) {
        const ok = window.confirm(`检测到页面语言已是「${AIT.getLanguageName(target)}」，仍要翻译吗？`);
        if (!ok) return;
      }

      state.view = 'translated';
      const groups = buildGroups(nodes, target);
      if (groups.size === 0) {
        setMessage(nodes.length ? '页面内容均已翻译。' : '未找到可翻译的文本。', 'success');
        return;
      }
      const batches = buildBatches([...groups.keys()], Number(state.settings.batchChars) || 2000);
      await runBatches(batches, groups, detected, target);
    } catch (err) {
      setMessage(friendlyError(err), 'error', isFatal(err));
    } finally {
      state.busy = false;
      hideProgress();
      render();
    }
  }

  /**
   * 按去除首尾空白后的原文分组（相同文本只翻译一次）。
   * 已有同语言译文的节点直接复用，不再请求。
   */
  function buildGroups(nodes, target) {
    const groups = new Map();
    for (const node of nodes) {
      const value = node.nodeValue;
      const rec = records.get(node);
      if (rec && rec.lang === target && rec.translated != null) {
        if (value === rec.translated) continue;
        if (value === rec.original) {
          node.nodeValue = rec.translated;
          continue;
        }
      }
      const original = originalOf(node);
      const [, lead, core, trail] = original.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!groups.has(core)) groups.set(core, []);
      groups.get(core).push({ node, original, lead, trail, shown: value });
    }
    return groups;
  }

  function buildBatches(texts, maxChars) {
    const batches = [];
    let current = [];
    let size = 0;
    for (const text of texts) {
      if (current.length && (size + text.length > maxChars || current.length >= MAX_ITEMS_PER_BATCH)) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(text);
      size += text.length;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  async function runBatches(batches, groups, detected, target) {
    const total = batches.length;
    const queue = batches.slice();
    const payload = {
      from: detected.code ? AIT.getLanguageEnglishName(detected.code) : '',
      to: AIT.getLanguageEnglishName(target),
      title: document.title,
    };
    let done = 0;
    let failed = 0;
    let lastError = null;
    let fatalError = null;

    setProgress(0, total);

    const worker = async () => {
      while (queue.length && !state.abort) {
        const texts = queue.shift();
        try {
          const translations = await callBackground({ type: 'translate', texts, ...payload });
          texts.forEach((text, i) => applyTranslation(groups.get(text), translations[i], target));
        } catch (err) {
          failed += 1;
          lastError = err;
          if (isFatal(err)) {
            fatalError = err;
            state.abort = true;
          }
        }
        done += 1;
        setProgress(done, total);
      }
    };

    const concurrency = Math.max(1, Math.min(Number(state.settings.concurrency) || 3, total));
    await Promise.all(Array.from({ length: concurrency }, worker));

    if (fatalError) {
      setMessage(friendlyError(fatalError), 'error', true);
    } else if (state.abort) {
      setMessage(`已停止，完成 ${done}/${total} 批。再次点击「翻译全文」可继续。`, 'info');
    } else if (failed) {
      setMessage(`翻译完成，但有 ${failed} 批失败：${friendlyError(lastError)}。再次点击「翻译全文」可重试失败部分。`, 'error');
    } else {
      setMessage('翻译完成。', 'success');
    }
  }

  function applyTranslation(items, translated, target) {
    const text = typeof translated === 'string' ? translated.trim() : '';
    if (!items || !text) return;
    for (const item of items) {
      // 请求期间页面自行改写了该节点，放弃本次结果
      if (!item.node.isConnected || item.node.nodeValue !== item.shown) continue;
      const full = item.lead + text + item.trail;
      records.set(item.node, { original: item.original, translated: full, lang: target });
      item.node.nodeValue = full;
    }
  }

  function hasTranslations() {
    for (const rec of records.values()) {
      if (rec.translated != null) return true;
    }
    return false;
  }

  function toggleView() {
    if (state.busy) return;
    pruneRecords();
    const toOriginal = state.view === 'translated';
    for (const [node, rec] of records) {
      if (rec.translated == null) continue;
      if (toOriginal && node.nodeValue === rec.translated) node.nodeValue = rec.original;
      if (!toOriginal && node.nodeValue === rec.original) node.nodeValue = rec.translated;
    }
    state.view = toOriginal ? 'original' : 'translated';
    render();
  }

  // -------------------------------------------------------------------------
  // 侧边栏 UI
  // -------------------------------------------------------------------------

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root {
      --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --border: #d0d7de;
      --primary: #2563eb; --primary-hover: #1d4ed8; --soft: #f6f8fa;
      --error: #cf222e; --error-bg: #ffebe9; --success: #1a7f37; --success-bg: #dafbe1;
      --info-bg: #ddf4ff;
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: var(--fg);
    }
    @media (prefers-color-scheme: dark) {
      .root {
        --bg: #1f2328; --fg: #e6edf3; --muted: #9198a1; --border: #3d444d; --soft: #2a3038;
        --error-bg: #3c1e22; --success-bg: #1b3326; --info-bg: #182c44;
        --error: #ff7b72; --success: #3fb950;
      }
    }
    .fab {
      position: fixed; right: 0; top: 50%; transform: translateY(-50%);
      z-index: 2147483646; width: 36px; height: 40px; border: none; cursor: pointer;
      border-radius: 20px 0 0 20px; background: var(--primary); color: #fff;
      font-family: inherit; font-size: 15px; font-weight: 600; line-height: 1; box-shadow: 0 2px 10px rgba(0,0,0,.2);
      opacity: .85; transition: opacity .2s, width .2s;
    }
    .fab:hover { opacity: 1; width: 42px; }
    .fab[hidden] { display: none; }
    .panel {
      position: fixed; top: 0; right: 0; z-index: 2147483647;
      width: 320px; height: 100vh; display: flex; flex-direction: column;
      background: var(--bg); color: var(--fg); border-left: 1px solid var(--border);
      box-shadow: -4px 0 24px rgba(0,0,0,.12);
      transform: translateX(105%); transition: transform .25s ease; visibility: hidden;
    }
    .panel.open { transform: translateX(0); visibility: visible; }
    header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px; border-bottom: 1px solid var(--border);
    }
    .title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; }
    .logo {
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; border-radius: 6px; background: var(--primary); color: #fff; font-size: 13px;
    }
    .icon-btn {
      border: none; background: transparent; color: var(--muted); cursor: pointer;
      font-size: 20px; line-height: 1; padding: 2px 6px; border-radius: 6px;
    }
    .icon-btn:hover { background: var(--soft); color: var(--fg); }
    .body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .label { font-size: 12px; color: var(--muted); }
    .value { padding: 7px 10px; border-radius: 8px; background: var(--soft); }
    .value small { color: var(--muted); }
    select {
      width: 100%; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border);
      background: var(--bg); color: var(--fg); font: inherit;
    }
    button.primary, button.secondary {
      width: 100%; padding: 9px 12px; border-radius: 8px;
      font-family: inherit; font-size: 14px; font-weight: 500; line-height: 1.4;
      cursor: pointer; transition: background .15s;
    }
    button.primary { border: none; background: var(--primary); color: #fff; }
    button.primary:hover { background: var(--primary-hover); }
    button.primary.stop { background: var(--error); }
    button.secondary { border: 1px solid var(--border); background: var(--bg); color: var(--fg); }
    button.secondary:hover:not(:disabled) { background: var(--soft); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .progress { display: flex; flex-direction: column; gap: 6px; }
    .progress[hidden], .message[hidden] { display: none; }
    .bar { height: 6px; border-radius: 3px; background: var(--soft); overflow: hidden; }
    .fill { height: 100%; width: 0; background: var(--primary); transition: width .2s; }
    .progress-text { font-size: 12px; color: var(--muted); }
    .message { padding: 8px 10px; border-radius: 8px; font-size: 13px; background: var(--info-bg); word-break: break-word; }
    .message.error { background: var(--error-bg); color: var(--error); }
    .message.success { background: var(--success-bg); color: var(--success); }
    .message .link { margin-left: 4px; }
    footer {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 12px 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted);
    }
    .model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .model.warn { color: var(--error); }
    .link {
      border: none; background: none; padding: 0; cursor: pointer; color: var(--primary);
      font: inherit; white-space: nowrap;
    }
    .link:hover { text-decoration: underline; }
  `;

  const TEMPLATE = `
    <div class="root">
      <button class="fab" data-action="open" title="AI 网页翻译">译</button>
      <aside class="panel" aria-label="AI 网页翻译">
        <header>
          <div class="title"><span class="logo">译</span>AI 网页翻译</div>
          <button class="icon-btn" data-action="close" title="收起">×</button>
        </header>
        <section class="body">
          <div class="field">
            <span class="label">页面语言（自动检测）</span>
            <div class="value" data-ref="detected">检测中…</div>
          </div>
          <div class="field">
            <label class="label" for="ait-target">翻译为</label>
            <select id="ait-target" data-ref="target"></select>
          </div>
          <button class="primary" data-action="translate" data-ref="translateBtn">翻译全文</button>
          <button class="secondary" data-action="toggleView" data-ref="toggleBtn" disabled>显示原文</button>
          <div class="progress" data-ref="progress" hidden>
            <div class="bar"><div class="fill" data-ref="fill"></div></div>
            <div class="progress-text" data-ref="progressText"></div>
          </div>
          <div class="message" data-ref="message" hidden></div>
        </section>
        <footer>
          <span class="model" data-ref="model"></span>
          <button class="link" data-action="options">设置</button>
        </footer>
      </aside>
    </div>
  `;

  function ensureUI() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${STYLE}</style>${TEMPLATE}`;
    document.documentElement.appendChild(host);

    const refs = {};
    shadow.querySelectorAll('[data-ref]').forEach((el) => (refs[el.dataset.ref] = el));
    refs.fab = shadow.querySelector('.fab');
    refs.panel = shadow.querySelector('.panel');

    refs.target.innerHTML = AIT.LANGUAGES.map((l) => `<option value="${l.code}">${l.name}</option>`).join('');
    refs.target.addEventListener('change', () => {
      state.targetLang = refs.target.value;
      AIT.saveSettings({ targetLang: state.targetLang }).catch(() => {});
    });

    shadow.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      if (action === 'open') openPanel();
      else if (action === 'close') closePanel();
      else if (action === 'translate') translatePage();
      else if (action === 'toggleView') toggleView();
      else if (action === 'options') openOptions();
    });

    ui = { host, shadow, refs };
    render();
    return ui;
  }

  function openPanel() {
    ensureUI();
    state.open = true;
    render();
    if (!state.detected && !state.busy) detectLanguage(collectTextNodes());
  }

  function closePanel() {
    state.open = false;
    render();
  }

  function togglePanel() {
    state.open ? closePanel() : openPanel();
  }

  function openOptions() {
    callBackground({ type: 'openOptions' }).catch((err) => setMessage(friendlyError(err), 'error'));
  }

  function render() {
    if (!ui) return;
    const { refs } = ui;
    refs.panel.classList.toggle('open', state.open);
    refs.fab.hidden = state.open || !state.settings.showFloatingButton;

    refs.target.value = state.targetLang;
    refs.target.disabled = state.busy;

    refs.translateBtn.textContent = state.busy ? '停止翻译' : '翻译全文';
    refs.translateBtn.classList.toggle('stop', state.busy);

    refs.toggleBtn.disabled = state.busy || !hasTranslations();
    refs.toggleBtn.textContent = state.view === 'original' ? '显示译文' : '显示原文';

    const configured = AIT.isConfigured(state.settings);
    refs.model.textContent = configured ? `模型：${state.settings.model}` : '尚未配置大模型';
    refs.model.title = configured ? `${state.settings.model}\n${state.settings.apiBaseUrl}` : '';
    refs.model.classList.toggle('warn', !configured);

    renderDetected();
  }

  function renderDetected() {
    if (!ui) return;
    const el = ui.refs.detected;
    const detected = state.detected;
    if (!detected) {
      el.textContent = '检测中…';
    } else if (!detected.code) {
      el.textContent = '未能识别';
    } else {
      el.textContent = AIT.getLanguageName(detected.code);
      if (!detected.reliable) {
        const hint = document.createElement('small');
        hint.textContent = '（置信度较低）';
        el.appendChild(hint);
      }
    }
  }

  function setProgress(done, total, text) {
    if (!ui) return;
    const { progress, fill, progressText } = ui.refs;
    progress.hidden = false;
    fill.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
    progressText.textContent = text || `正在翻译 ${done}/${total} 批`;
  }

  function hideProgress() {
    if (ui) ui.refs.progress.hidden = true;
  }

  function setMessage(text, type = 'info', withSettingsLink = false) {
    if (!ui) return;
    const el = ui.refs.message;
    el.hidden = !text;
    el.className = `message ${type}`;
    el.textContent = text;
    if (text && withSettingsLink) {
      const link = document.createElement('button');
      link.className = 'link';
      link.dataset.action = 'options';
      link.textContent = '前往设置';
      el.appendChild(link);
    }
  }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'toggleSidebar') togglePanel();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[AIT.STORAGE_KEY]) return;
    state.settings = { ...AIT.DEFAULT_SETTINGS, ...(changes[AIT.STORAGE_KEY].newValue || {}) };
    if (!state.busy) state.targetLang = state.settings.targetLang;
    render();
  });

  AIT.getSettings()
    .then((settings) => {
      state.settings = settings;
      state.targetLang = settings.targetLang;
    })
    .catch(() => {})
    .finally(() => {
      if (document.documentElement) ensureUI();
    });
})();
