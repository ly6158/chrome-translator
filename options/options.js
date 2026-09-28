const form = document.getElementById('form');
const $ = (id) => document.getElementById(id);
const fields = {
  apiBaseUrl: $('apiBaseUrl'),
  apiKey: $('apiKey'),
  model: $('model'),
  temperature: $('temperature'),
  targetLang: $('targetLang'),
  extraPrompt: $('extraPrompt'),
  showFloatingButton: $('showFloatingButton'),
  batchChars: $('batchChars'),
  concurrency: $('concurrency'),
  timeout: $('timeout'),
};

function init() {
  fields.targetLang.innerHTML = AIT.LANGUAGES.map((l) => `<option value="${l.code}">${l.name}</option>`).join('');

  fields.temperature.addEventListener('input', updateTemperatureLabel);
  $('toggleKey').addEventListener('click', toggleKeyVisibility);
  $('test').addEventListener('click', testConnection);
  $('reset').addEventListener('click', resetDefaults);
  form.addEventListener('submit', save);

  AIT.getSettings().then(fillForm);
}

function fillForm(settings) {
  fields.apiBaseUrl.value = settings.apiBaseUrl;
  fields.apiKey.value = settings.apiKey;
  fields.model.value = settings.model;
  fields.temperature.value = settings.temperature;
  fields.targetLang.value = settings.targetLang;
  fields.extraPrompt.value = settings.extraPrompt;
  fields.showFloatingButton.checked = !!settings.showFloatingButton;
  fields.batchChars.value = settings.batchChars;
  fields.concurrency.value = settings.concurrency;
  fields.timeout.value = settings.timeout;
  updateTemperatureLabel();
}

function updateTemperatureLabel() {
  $('temperatureValue').textContent = Number(fields.temperature.value).toFixed(1);
}

function toggleKeyVisibility() {
  const visible = fields.apiKey.type === 'text';
  fields.apiKey.type = visible ? 'password' : 'text';
  $('toggleKey').textContent = visible ? '显示' : '隐藏';
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readForm() {
  const d = AIT.DEFAULT_SETTINGS;
  return {
    apiBaseUrl: fields.apiBaseUrl.value.trim(),
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value.trim(),
    temperature: clampNumber(fields.temperature.value, 0, 2, d.temperature),
    targetLang: fields.targetLang.value,
    extraPrompt: fields.extraPrompt.value.trim(),
    showFloatingButton: fields.showFloatingButton.checked,
    batchChars: Math.round(clampNumber(fields.batchChars.value, 200, 20000, d.batchChars)),
    concurrency: Math.round(clampNumber(fields.concurrency.value, 1, 10, d.concurrency)),
    timeout: Math.round(clampNumber(fields.timeout.value, 5, 600, d.timeout)),
  };
}

function validate(settings) {
  if (!settings.apiBaseUrl) return '请填写 API 地址';
  try {
    const url = new URL(settings.apiBaseUrl);
    if (!/^https?:$/.test(url.protocol)) return 'API 地址需以 http:// 或 https:// 开头';
  } catch (e) {
    return 'API 地址格式不正确';
  }
  if (!settings.model) return '请填写模型名称';
  return '';
}

async function save(event) {
  event.preventDefault();
  const settings = readForm();
  const error = validate(settings);
  if (error) return showStatus(error, 'error');
  await chrome.storage.local.set({ [AIT.STORAGE_KEY]: settings });
  fillForm(settings);
  showStatus('设置已保存。', 'success');
}

async function testConnection() {
  const settings = readForm();
  const error = validate(settings);
  if (error) return showStatus(error, 'error');

  const button = $('test');
  button.disabled = true;
  showStatus('正在测试连接…', 'info');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'testConnection', settings });
    if (!res?.ok) throw new Error(res?.error || '后台无响应');
    const { translation, latency } = res.data;
    showStatus(`连接成功（${latency} ms）。测试译文：${translation}`, 'success');
  } catch (err) {
    showStatus(`连接失败：${err.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

function resetDefaults() {
  if (!confirm('确定恢复默认设置吗？当前填写的 API Key 也会被清空（点击「保存」后生效）。')) return;
  fillForm({ ...AIT.DEFAULT_SETTINGS });
  showStatus('已恢复默认值，点击「保存」后生效。', 'info');
}

function showStatus(text, type) {
  const el = $('status');
  el.hidden = !text;
  el.className = `status ${type || ''}`;
  el.textContent = text;
}

init();
