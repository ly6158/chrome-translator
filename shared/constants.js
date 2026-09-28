/**
 * 共享常量与配置读写。
 * 以普通脚本形式加载（background 通过 importScripts，content script 与配置页直接引入），
 * 统一挂载到全局对象 AIT 上。
 */
(function (global) {
  const STORAGE_KEY = 'settings';

  /** 支持的目标语言：code 用于存储与比较，name 用于界面显示，en 用于拼接提示词 */
  const LANGUAGES = [
    { code: 'zh-CN', name: '简体中文', en: 'Simplified Chinese' },
    { code: 'zh-TW', name: '繁體中文', en: 'Traditional Chinese' },
    { code: 'en', name: 'English', en: 'English' },
    { code: 'ja', name: '日本語', en: 'Japanese' },
    { code: 'ko', name: '한국어', en: 'Korean' },
    { code: 'fr', name: 'Français', en: 'French' },
    { code: 'de', name: 'Deutsch', en: 'German' },
    { code: 'es', name: 'Español', en: 'Spanish' },
    { code: 'pt', name: 'Português', en: 'Portuguese' },
    { code: 'it', name: 'Italiano', en: 'Italian' },
    { code: 'ru', name: 'Русский', en: 'Russian' },
    { code: 'ar', name: 'العربية', en: 'Arabic' },
    { code: 'vi', name: 'Tiếng Việt', en: 'Vietnamese' },
    { code: 'th', name: 'ไทย', en: 'Thai' },
    { code: 'id', name: 'Bahasa Indonesia', en: 'Indonesian' },
  ];

  /** 默认配置；大模型接口统一使用 OpenAI 兼容的 /chat/completions 协议 */
  const DEFAULT_SETTINGS = {
    apiBaseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.3,
    targetLang: 'zh-CN',
    batchChars: 2000,
    concurrency: 3,
    timeout: 60,
    extraPrompt: '',
    showFloatingButton: true,
  };

  function getLanguage(code) {
    return LANGUAGES.find((l) => l.code === code) || null;
  }

  function displayName(code, locale) {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(code) || code;
    } catch (e) {
      return code;
    }
  }

  /** 界面显示用的语言名称 */
  function getLanguageName(code) {
    if (!code) return '未知';
    const lang = getLanguage(code);
    if (lang) return lang.name;
    const normalized = normalizeLang(code);
    return getLanguage(normalized)?.name || displayName(code, 'zh-CN');
  }

  /** 提示词中使用的英文语言名称 */
  function getLanguageEnglishName(code) {
    if (!code) return '';
    const lang = getLanguage(code) || getLanguage(normalizeLang(code));
    return lang ? lang.en : displayName(code, 'en');
  }

  /** 统一语言代码：中文区分简繁，其余语言只保留主语言部分 */
  function normalizeLang(code) {
    if (!code) return '';
    const lower = String(code).toLowerCase().replace('_', '-');
    if (lower.startsWith('zh')) {
      return /hant|tw|hk|mo/.test(lower) ? 'zh-TW' : 'zh-CN';
    }
    return lower.split('-')[0];
  }

  function isSameLanguage(a, b) {
    return !!a && !!b && normalizeLang(a) === normalizeLang(b);
  }

  function isConfigured(settings) {
    return !!(settings && settings.apiBaseUrl && settings.model);
  }

  async function getSettings() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEY] || {}) };
  }

  async function saveSettings(partial) {
    const current = await getSettings();
    const next = { ...current, ...partial };
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  }

  global.AIT = {
    STORAGE_KEY,
    LANGUAGES,
    DEFAULT_SETTINGS,
    getLanguageName,
    getLanguageEnglishName,
    normalizeLang,
    isSameLanguage,
    isConfigured,
    getSettings,
    saveSettings,
  };
})(typeof self !== 'undefined' ? self : globalThis);
