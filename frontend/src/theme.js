export const THEME_STORAGE_KEY = 'workbench.theme';

const THEME_SETTINGS = ['system', 'light', 'dark'];
const THEME_SETTING_SET = new Set(THEME_SETTINGS);

export function normalizeThemeSetting(value) {
  return THEME_SETTING_SET.has(value) ? value : 'system';
}

export function nextThemeSetting(setting) {
  const current = normalizeThemeSetting(setting);
  return THEME_SETTINGS[(THEME_SETTINGS.indexOf(current) + 1) % THEME_SETTINGS.length];
}

export function resolveTheme(setting, prefersDark) {
  const normalized = normalizeThemeSetting(setting);
  if (normalized === 'system') return prefersDark ? 'dark' : 'light';
  return normalized;
}

export function readThemeSetting(storage = globalThis.localStorage) {
  try {
    return normalizeThemeSetting(storage.getItem(THEME_STORAGE_KEY) ?? 'dark');
  } catch {
    return 'dark';
  }
}

export function storeThemeSetting(setting, storage = globalThis.localStorage) {
  const normalized = normalizeThemeSetting(setting);
  try {
    storage.setItem(THEME_STORAGE_KEY, normalized);
  } catch {
    // Keep the setting for this page when browser storage is unavailable.
  }
  return normalized;
}
