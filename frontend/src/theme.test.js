import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THEME_STORAGE_KEY,
  nextThemeSetting,
  normalizeThemeSetting,
  readThemeSetting,
  resolveTheme,
  storeThemeSetting,
} from './theme.js';

test('normalizes unsupported theme settings to system', () => {
  assert.equal(normalizeThemeSetting('dark'), 'dark');
  assert.equal(normalizeThemeSetting('light'), 'light');
  assert.equal(normalizeThemeSetting('system'), 'system');
  assert.equal(normalizeThemeSetting('sepia'), 'system');
  assert.equal(normalizeThemeSetting(null), 'system');
});

test('cycles through system, light, and dark themes', () => {
  assert.equal(nextThemeSetting('system'), 'light');
  assert.equal(nextThemeSetting('light'), 'dark');
  assert.equal(nextThemeSetting('dark'), 'system');
  assert.equal(nextThemeSetting('unsupported'), 'light');
});

test('resolves system theme from the color scheme preference', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('reads and stores the theme setting', () => {
  const values = new Map([[THEME_STORAGE_KEY, 'dark']]);
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };

  assert.equal(readThemeSetting(storage), 'dark');
  assert.equal(storeThemeSetting('light', storage), 'light');
  assert.equal(values.get(THEME_STORAGE_KEY), 'light');
});

test('falls back safely when storage is unavailable', () => {
  const storage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };

  assert.equal(readThemeSetting(storage), 'dark');
  assert.equal(storeThemeSetting('dark', storage), 'dark');
});
