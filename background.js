importScripts('shared/constants.js');

const MAX_RETRIES = 2;

/** 已知不支持 system 角色的接口（endpoint + model），避免每批都先失败一次 */
const noSystemRole = new Set();

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 模型返回内容无法解析为与输入等长的数组 */
class FormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormatError';
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggleSidebar' });
  } catch (e) {
    // 插件安装前已打开的页面没有注入 content script，这里补注入一次
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['shared/constants.js', 'content/content.js'],
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'toggleSidebar' });
    } catch (err) {
      console.warn('[AI 翻译] 当前页面不支持注入侧边栏：', err.message);
    }
  }
});

// ---------------------------------------------------------------------------
// 消息处理
// ---------------------------------------------------------------------------

const handlers = {
  detectLanguage: ({ text }) =>
    new Promise((resolve) => chrome.i18n.detectLanguage(text || '', (result) => resolve(result))),

  translate: async ({ texts, from, to, title }) => {
    const settings = await AIT.getSettings();
    return translateTexts(texts, { from, to, title }, settings);
  },

  testConnection: async ({ settings }) => {
    const merged = { ...AIT.DEFAULT_SETTINGS, ...settings };
    const start = Date.now();
    const [translation] = await translateTexts(
      ['Hello, world! This is a connection test.'],
      { from: 'English', to: AIT.getLanguageEnglishName(merged.targetLang), title: '' },
      merged
    );
    return { translation, latency: Date.now() - start };
  },

  openOptions: () => chrome.runtime.openOptionsPage(),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message, sender))
    .then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: err?.message || String(err), status: err?.status })
    );
  return true; // 异步响应
});

// ---------------------------------------------------------------------------
// 翻译
// ---------------------------------------------------------------------------

/**
 * 翻译一组文本，返回与输入等长的译文数组。
 * 模型输出格式异常时把批次对半拆分重试，直至单条。
 */
async function translateTexts(texts, options, settings) {
  if (!AIT.isConfigured(settings)) {
    throw new ApiError('尚未配置大模型 API，请先在设置页填写接口地址和模型名称。');
  }
  if (!Array.isArray(texts) || texts.length === 0) return [];

  try {
    return await requestTranslation(texts, options, settings);
  } catch (err) {
    if (err instanceof FormatError && texts.length > 1) {
      const mid = Math.ceil(texts.length / 2);
      const left = await translateTexts(texts.slice(0, mid), options, settings);
      const right = await translateTexts(texts.slice(mid), options, settings);
      return left.concat(right);
    }
    if (err instanceof FormatError) return texts; // 单条仍失败：保留原文
    throw err;
  }
}

async function requestTranslation(texts, options, settings) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(options, settings) },
    { role: 'user', content: JSON.stringify(texts) },
  ];
  const content = await callChatAPI(settings, messages);
  return parseTranslations(content, texts.length);
}

function buildSystemPrompt({ from, to, title }, settings) {
  const source = from || 'the source language (detect it automatically)';
  const target = to || 'Simplified Chinese';
  const lines = [
    `You are a professional translation engine. Translate every string in the user's JSON array from ${source} into ${target}.`,
    title ? `The strings are consecutive text fragments from a web page titled "${title}".` : 'The strings are consecutive text fragments from a web page.',
    '',
    'Rules:',
    '1. Reply with ONLY a valid JSON array of strings. No explanations, no markdown code fences.',
    '2. The output array must have exactly the same number of elements as the input, in the same order; element i is the translation of input element i.',
    '3. Use neighbouring elements as context, but never merge, split, drop or reorder elements.',
    '4. Keep URLs, email addresses, code, file paths, numbers and proper nouns unchanged where appropriate.',
    `5. If an element is already in ${target} or has nothing to translate, return it unchanged.`,
    `6. The translation must be fluent and natural, following the punctuation conventions of ${target}.`,
  ];
  if (settings.extraPrompt && settings.extraPrompt.trim()) {
    lines.push('', 'Additional requirements from the user:', settings.extraPrompt.trim());
  }
  return lines.join('\n');
}

function buildEndpoint(baseUrl) {
  const url = String(baseUrl).trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(url) ? url : `${url}/chat/completions`;
}

async function callChatAPI(settings, messages) {
  const endpoint = buildEndpoint(settings.apiBaseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey.trim()}`;

  const roleKey = `${endpoint}|${settings.model}`;
  let withTemperature = true;
  let attempt = 0;

  for (;;) {
    const finalMessages = noSystemRole.has(roleKey) ? mergeSystemMessages(messages) : messages;
    const body = { model: settings.model, messages: finalMessages, stream: false };
    if (withTemperature) body.temperature = Number(settings.temperature);

    try {
      return await postJSON(endpoint, headers, body, settings.timeout);
    } catch (err) {
      // 部分接口只接受 user/assistant 角色，把 system 提示词并入 user 消息后重试。
      // 只判断本次请求是否带了 system：并发批次可能在其他批次已记录该接口后才失败返回
      if (
        err.status === 400 &&
        finalMessages.some((m) => m.role === 'system') &&
        /role|system/i.test(err.message)
      ) {
        noSystemRole.add(roleKey);
        continue;
      }
      // 部分推理模型不支持自定义 temperature，去掉后重试一次
      if (withTemperature && err.status === 400 && /temperature/i.test(err.message)) {
        withTemperature = false;
        continue;
      }
      const retryable = err.status === 429 || err.status >= 500 || err.status === undefined;
      if (!retryable || attempt >= MAX_RETRIES) throw err;
      attempt += 1;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

function mergeSystemMessages(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  if (!system) return rest;
  const index = rest.findIndex((m) => m.role === 'user');
  if (index === -1) return [{ role: 'user', content: system }, ...rest];
  return rest.map((m, i) =>
    i === index ? { ...m, content: `${system}\n\nInput JSON array:\n${m.content}` } : m
  );
}

async function postJSON(url, headers, body, timeoutSeconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5, Number(timeoutSeconds) || 60) * 1000);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (err) {
    throw new ApiError(err.name === 'AbortError' ? '请求超时，请检查网络或调大超时时间' : `网络请求失败：${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new ApiError(`${describeStatus(res.status)}（HTTP ${res.status}）${detail ? '：' + detail : ''}`, res.status);
  }

  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new ApiError('接口返回格式异常，请确认接口兼容 OpenAI Chat Completions 协议', res.status);
  }
  return content;
}

async function readErrorDetail(res) {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    return String(json?.error?.message || json?.message || json?.error || text).slice(0, 300);
  } catch (e) {
    return text.slice(0, 300);
  }
}

function describeStatus(status) {
  if (status === 401) return 'API Key 无效或未填写';
  if (status === 403) return '无权访问该接口或模型';
  if (status === 404) return '接口地址或模型名称错误';
  if (status === 429) return '请求过于频繁或额度不足';
  if (status >= 500) return '模型服务暂时不可用';
  return '请求失败';
}

/** 从模型输出中解析出译文数组 */
function parseTranslations(content, expected) {
  let text = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch (err) {
        parsed = undefined;
      }
    }
  }

  // 兼容 {"translations": [...]} 之类的包裹结构
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    parsed = Object.values(parsed).find(Array.isArray);
  }

  if (Array.isArray(parsed) && parsed.length === expected) {
    return parsed.map((v) => (typeof v === 'string' ? v : v == null ? '' : String(v)));
  }

  if (expected === 1) {
    if (typeof parsed === 'string') return [parsed];
    if (Array.isArray(parsed)) return [parsed.map(String).join('')];
    if (parsed === undefined && text) return [text];
  }

  throw new FormatError(`模型返回的译文数量不匹配（期望 ${expected} 条）`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
