import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_THEME, FONT_PRESETS, normalizeTheme, THEME_SECTION_TYPES,
  themeFromSnapshot, themeSnapshot, ThemeRuleError,
} from '../packages/domain/src/theme.js';

const validTheme = () => ({
  brand: { name: '测试店铺', brandLatin: 'Test Store', tagline: '标语', whatsappNumber: '85212345678' },
  tokens: { primaryColor: '#AABBCC', inkColor: '#111111', paperColor: '#FFFFFF', fontPair: 'modern-sans', radius: 12 },
  homeSections: [
    { type: 'hero' },
    { type: 'product_grid', params: { sectionId: 'featured', limit: 8 } },
  ],
});

const code = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    if (error instanceof ThemeRuleError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

test('theme: default theme is complete and renders without any config', () => {
  const t = DEFAULT_THEME;
  assert.ok(t.brand.name);
  assert.match(t.tokens.primaryColor, /^#[0-9a-f]{6}$/i);
  assert.ok((THEME_SECTION_TYPES as readonly string[]).includes(t.homeSections[0]!.type));
  assert.ok((FONT_PRESETS as readonly string[]).includes(t.tokens.fontPair));
});

test('theme: normalize accepts a valid config and normalizes colors', () => {
  const result = normalizeTheme(validTheme());
  assert.equal(result.brand.name, '测试店铺');
  assert.equal(result.tokens.primaryColor, '#aabbcc'); // 小写归一化
  assert.equal(result.homeSections.length, 2);
  assert.deepEqual(result.homeSections[1]!.params, { sectionId: 'featured', limit: 8 });
});

test('theme: section types are a closed registry and duplicates are rejected', () => {
  assert.equal(code(() => normalizeTheme({ ...validTheme(), homeSections: [{ type: 'custom_html' }] })),
    'THEME_SECTION_UNSUPPORTED');
  assert.equal(code(() => normalizeTheme({ ...validTheme(), homeSections: [{ type: 'hero' }, { type: 'hero' }] })),
    'THEME_SECTION_DUPLICATE');
});

test('theme: unsafe colors, unknown fonts and oversized brands are rejected', () => {
  const bad = (tokens: Record<string, unknown>) => ({ ...validTheme(), tokens: { ...validTheme().tokens, ...tokens } });
  assert.equal(code(() => normalizeTheme(bad({ primaryColor: 'red; background:url(x)' }))), 'THEME_COLOR_INVALID');
  assert.equal(code(() => normalizeTheme(bad({ primaryColor: '#FFF' }))), 'THEME_COLOR_INVALID');
  assert.equal(code(() => normalizeTheme(bad({ fontPair: 'http://evil/font' }))), 'THEME_FONT_UNSUPPORTED');
  assert.equal(code(() => normalizeTheme({ ...validTheme(), brand: { name: 'x'.repeat(61) } })), 'THEME_VALIDATION_ERROR');
});

test('theme: section params accept only flat scalars', () => {
  const nested = { ...validTheme(), homeSections: [{ type: 'hero', params: { bad: { nested: true } } }] };
  assert.equal(code(() => normalizeTheme(nested)), 'THEME_VALIDATION_ERROR');
  const clean = normalizeTheme({ ...validTheme(), homeSections: [{ type: 'hero', params: { variant: 'default', show: true } }] });
  assert.deepEqual(clean.homeSections[0]!.params, { variant: 'default', show: true });
});

test('theme: snapshot freezes config and bad snapshots fall back to default', () => {
  const config = normalizeTheme(validTheme());
  const snapshot = themeSnapshot(config, 7, new Date('2026-11-20T00:00:00Z'));
  assert.equal(snapshot.version, 7);
  assert.deepEqual(themeFromSnapshot(snapshot), config);
  // 坏快照绝不把坏数据送到前台。
  assert.deepEqual(themeFromSnapshot(null), DEFAULT_THEME);
  assert.deepEqual(themeFromSnapshot({ config: { brand: {} } }), DEFAULT_THEME);
  assert.deepEqual(themeFromSnapshot('garbage'), DEFAULT_THEME);
});
