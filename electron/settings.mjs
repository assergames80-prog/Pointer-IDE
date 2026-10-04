import { app, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  chatModel: { provider: 'google', model: 'gemini-3-flash-preview' },
  inlineModel: { provider: 'google', model: 'gemini-3-flash-preview' },
  autocompleteModel: { provider: 'groq', model: 'openai/gpt-oss-20b' },
  autocompleteEnabled: true,
  // 'ask'  -> the agent asks before running terminal commands or deleting files
  // 'auto' -> the agent runs everything without asking (full autonomy)
  autoRun: 'ask',
  maxSteps: 50,
  commandTimeout: 300,
  customInstructions: '',
  editor: {
    fontSize: 14,
    fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
    tabSize: 2,
    wordWrap: 'off',
    minimap: true,
    formatOnSave: false,
    autoSave: false,
  },
  terminal: { fontSize: 13 },
};

const KEY_ENV = {
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'],
};

let cache = null;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeRaw(data) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  const tmp = settingsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, settingsPath());
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k], v) : v;
  }
  return out;
}

function load() {
  if (!cache) cache = readRaw();
  return cache;
}

export function getSettings() {
  const raw = load();
  const { keys, ...rest } = raw;
  return deepMerge(DEFAULT_SETTINGS, rest);
}

export function setSettings(patch) {
  const raw = load();
  const { keys } = raw;
  cache = { ...deepMerge(raw, patch), keys };
  writeRaw(cache);
  return getSettings();
}

/**
 * Cleans a pasted API key. Handles stray whitespace, newlines, surrounding quotes and
 * an accidental "KEY=" prefix. Dots are preserved: the new Google "Auth keys" look like
 * `AQ.Ab8RN6...` and the dot is part of the key.
 */
export function normalizeKey(key) {
  if (typeof key !== 'string') return '';
  let k = key.trim().replace(/^['"`]+|['"`]+$/g, '').trim();
  k = k.replace(/^(?:export\s+)?[A-Z_]+\s*=\s*/, '').replace(/^['"`]+|['"`]+$/g, '');
  return k.replace(/\s+/g, '');
}

/**
 * Accepts both Google key formats:
 *  - Standard keys: `AIza...` (legacy, being phased out by Google in 2026)
 *  - Auth keys:     `AQ.Ab...` (the new default in Google AI Studio)
 * Returns a warning string for unusual formats instead of rejecting them, so a future
 * format change never locks the user out.
 */
export function checkKeyFormat(provider, key) {
  if (!key) return null;
  if (provider === 'google') {
    if (/^AQ\.[A-Za-z0-9_\-.]{8,}$/.test(key)) return null;
    if (/^AIza[A-Za-z0-9_\-]{30,}$/.test(key)) return null;
    return 'This does not look like a Google API key (expected it to start with "AQ." or "AIza"). It will still be tried.';
  }
  if (provider === 'groq') {
    if (/^gsk_[A-Za-z0-9]{16,}$/.test(key)) return null;
    return 'This does not look like a Groq API key (expected it to start with "gsk_"). It will still be tried.';
  }
  return null;
}

export function getApiKey(provider) {
  const raw = load();
  const stored = raw.keys?.[provider];
  if (stored) {
    try {
      if (stored.enc === 'safe') return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
      if (stored.enc === 'plain') return Buffer.from(stored.value, 'base64').toString('utf8');
    } catch (err) {
      console.error('Failed to decrypt key for', provider, err);
    }
  }
  for (const env of KEY_ENV[provider] || []) {
    if (process.env[env]) return normalizeKey(process.env[env]);
  }
  return '';
}

export function setApiKey(provider, key) {
  const raw = load();
  const keys = { ...(raw.keys || {}) };
  const k = normalizeKey(key);
  if (!k) delete keys[provider];
  else if (safeStorage.isEncryptionAvailable()) {
    keys[provider] = { enc: 'safe', value: safeStorage.encryptString(k).toString('base64') };
  } else {
    keys[provider] = { enc: 'plain', value: Buffer.from(k, 'utf8').toString('base64') };
  }
  cache = { ...raw, keys };
  writeRaw(cache);
  return k;
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return '•'.repeat(key.length);
  return key.slice(0, key.startsWith('AQ.') ? 5 : 4) + '…' + key.slice(-4);
}

export function registerSettingsIpc(ipcMain) {
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, patch) => setSettings(patch));
  ipcMain.handle('settings:keys', () => {
    const out = {};
    for (const p of ['google', 'groq']) {
      const k = getApiKey(p);
      out[p] = { set: !!k, masked: maskKey(k), warning: checkKeyFormat(p, k) };
    }
    return out;
  });
  ipcMain.handle('settings:setKey', (_e, provider, key) => {
    const k = setApiKey(provider, key);
    return { set: !!k, masked: maskKey(k), warning: checkKeyFormat(provider, k) };
  });
}
