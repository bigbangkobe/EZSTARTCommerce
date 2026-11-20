/**
 * 主题配置纯规则层（配置驱动前台，重做方案 P1）。
 *
 * 主题只有一条链路：草稿 config → 发布快照 → 前台按快照渲染。
 * 这里只回答「主题长什么样、哪些区块可配置、怎么校验、默认是什么」，
 * 不碰数据库、不碰网络、不碰 React。
 *
 * 不变量：
 * 1. 区块类型是服务端闭集（注册表）：未注册的类型在保存时就被拒绝，
 *    不允许存下来后在前台静默失效——与 MerchandisingSectionType 同一纪律。
 * 2. 默认主题是完整可用的：接口不可用/未发布时，前台回退到 DEFAULT_THEME，
 *    保证配置永远不是单点故障（换配置坏掉首页是不可接受的）。
 * 3. 视觉 tokens 走白名单校验：颜色必须是 #RRGGBB，避免注入任意 CSS。
 * 4. 字体组合是预设枚举：不接受任意字体 URL，防止前台加载外部不可控资源。
 * 5. 品牌文案有长度上限：避免后台一次误填把页头撑爆。
 */

export class ThemeRuleError extends Error {
  constructor(readonly field: string, readonly code = 'THEME_VALIDATION_ERROR') { super(field); }
}

function fail(field: string, code = 'THEME_VALIDATION_ERROR'): never { throw new ThemeRuleError(field, code); }

/** 声明式区块注册表：新增区块类型需在此登记，后台表单与前台渲染据此驱动。 */
export const THEME_SECTION_TYPES = ['hero', 'about', 'product_grid', 'rich_text', 'faq', 'content_card'] as const;
export type ThemeSectionType = typeof THEME_SECTION_TYPES[number];

export interface ThemeSection {
  type: ThemeSectionType;
  params?: Record<string, string | number | boolean>;
}

/** 字体组合预设：前台据此加载已批准的自托管/Google 字体，不接受任意 URL。 */
export const FONT_PRESETS = ['editorial-jp', 'modern-sans', 'classic-serif'] as const;
export type FontPreset = typeof FONT_PRESETS[number];

export interface ThemeTokens {
  primaryColor: string;
  inkColor: string;
  paperColor: string;
  fontPair: FontPreset;
  radius: number;
}

export interface ThemeConfigData {
  brand: {
    name: string;
    brandLatin?: string;
    tagline?: string;
    logoMediaId?: string | null;
    faviconMediaId?: string | null;
    whatsappNumber?: string;
    whatsappGreeting?: string;
  };
  tokens: ThemeTokens;
  navigation?: string[];
  homeSections: ThemeSection[];
}

/** 默认主题：与当前 storefront 硬编码外观一致，保证未配置/接口异常时前台零变化。 */
export const DEFAULT_THEME: ThemeConfigData = {
  brand: {
    name: 'EZSTART Store',
    brandLatin: 'EZSTART',
    tagline: '',
  },
  tokens: {
    primaryColor: '#BC002D',
    inkColor: '#1A1A1A',
    paperColor: '#F7F5F0',
    fontPair: 'editorial-jp',
    radius: 16,
  },
  navigation: ['home', 'products', 'categories', 'collections', 'contact'],
  homeSections: [
    { type: 'hero' },
    { type: 'about' },
    { type: 'product_grid', params: { sectionId: 'featured', limit: 6 } },
  ],
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_BRAND_NAME = 60;
const MAX_TAGLINE = 200;
const MAX_SECTIONS = 12;
const MAX_PARAMS = 20;

function normalizeColor(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) fail(field, 'THEME_COLOR_INVALID');
  return value.toLowerCase();
}

function isSectionType(value: unknown): value is ThemeSectionType {
  return typeof value === 'string' && (THEME_SECTION_TYPES as readonly string[]).includes(value);
}

/** 校验并归一化主题配置。任何非法值都会抛出带字段码的 ThemeRuleError，绝不静默吞掉。 */
export function normalizeTheme(input: unknown): ThemeConfigData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('config');
  const raw = input as Record<string, unknown>;

  // 品牌：name 必填，其余可选；全部限长，避免页头/页脚被撑爆。
  const brandRaw = raw.brand;
  if (!brandRaw || typeof brandRaw !== 'object' || Array.isArray(brandRaw)) fail('brand');
  const b = brandRaw as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > MAX_BRAND_NAME) fail('brand.name');
  const optionalText = (value: unknown, field: string, max: number): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || value.length > max) fail(field);
    return value;
  };
  const brand: ThemeConfigData['brand'] = { name: b.name.trim() };
  const brandLatin = optionalText(b.brandLatin, 'brand.brandLatin', MAX_BRAND_NAME);
  const tagline = optionalText(b.tagline, 'brand.tagline', MAX_TAGLINE);
  const whatsappNumber = optionalText(b.whatsappNumber, 'brand.whatsappNumber', 30);
  const whatsappGreeting = optionalText(b.whatsappGreeting, 'brand.whatsappGreeting', MAX_TAGLINE);
  if (brandLatin !== undefined) brand.brandLatin = brandLatin;
  if (tagline !== undefined) brand.tagline = tagline;
  if (whatsappNumber !== undefined) brand.whatsappNumber = whatsappNumber;
  if (whatsappGreeting !== undefined) brand.whatsappGreeting = whatsappGreeting;
  for (const key of ['logoMediaId', 'faviconMediaId'] as const) {
    const value = b[key];
    if (value !== undefined && value !== null && typeof value !== 'string') fail(`brand.${key}`);
  }
  if (typeof b.logoMediaId === 'string') brand.logoMediaId = b.logoMediaId;
  if (typeof b.faviconMediaId === 'string') brand.faviconMediaId = b.faviconMediaId;

  // tokens：颜色白名单 + 字体预设 + 圆角有界。
  const tokensRaw = raw.tokens;
  if (!tokensRaw || typeof tokensRaw !== 'object' || Array.isArray(tokensRaw)) fail('tokens');
  const t = tokensRaw as Record<string, unknown>;
  const tokens: ThemeTokens = {
    primaryColor: normalizeColor(t.primaryColor, 'tokens.primaryColor'),
    inkColor: normalizeColor(t.inkColor, 'tokens.inkColor'),
    paperColor: normalizeColor(t.paperColor, 'tokens.paperColor'),
    fontPair: (FONT_PRESETS as readonly string[]).includes(String(t.fontPair)) ? t.fontPair as FontPreset
      : fail('tokens.fontPair', 'THEME_FONT_UNSUPPORTED'),
    radius: typeof t.radius === 'number' && Number.isFinite(t.radius) && t.radius >= 0 && t.radius <= 64
      ? t.radius : fail('tokens.radius'),
  };

  // 首页区块：注册表闭集 + 数量上限 + 参数都是原始标量（不嵌套对象/数组，避免注入复杂结构）。
  const sectionsRaw = raw.homeSections;
  if (!Array.isArray(sectionsRaw) || sectionsRaw.length > MAX_SECTIONS) fail('homeSections');
  const seen = new Set<ThemeSectionType>();
  const homeSections: ThemeSection[] = sectionsRaw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`homeSections[${index}]`);
    const s = item as Record<string, unknown>;
    if (!isSectionType(s.type)) fail(`homeSections[${index}].type`, 'THEME_SECTION_UNSUPPORTED');
    if (seen.has(s.type)) fail(`homeSections[${index}].type`, 'THEME_SECTION_DUPLICATE');
    seen.add(s.type);
    const section: ThemeSection = { type: s.type };
    if (s.params !== undefined) {
      if (!s.params || typeof s.params !== 'object' || Array.isArray(s.params)) fail(`homeSections[${index}].params`);
      const params = s.params as Record<string, unknown>;
      const entries = Object.entries(params);
      if (entries.length > MAX_PARAMS) fail(`homeSections[${index}].params`);
      const clean: Record<string, string | number | boolean> = {};
      for (const [key, value] of entries) {
        if (!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key)) fail(`homeSections[${index}].params.${key}`);
        if (typeof value === 'string' && value.length <= 200) clean[key] = value;
        else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
        else if (typeof value === 'boolean') clean[key] = value;
        else fail(`homeSections[${index}].params.${key}`);
      }
      section.params = clean;
    }
    return section;
  });

  // 导航：白名单字符串数组，数量有界。
  const navigation = raw.navigation === undefined ? undefined
    : normalizeNavigation(raw.navigation);

  return { brand, tokens, homeSections, ...(navigation ? { navigation } : {}) };
}

function normalizeNavigation(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 12) fail('navigation');
  return value.map((item, i) => {
    if (typeof item !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(item)) fail(`navigation[${i}]`);
    return item;
  });
}

/** 发布快照：把版本号与发布时间固化进对象，前台只读这个不可变结构。 */
export function themeSnapshot(config: ThemeConfigData, version: number, publishedAt: Date): Record<string, unknown> {
  return {
    version,
    publishedAt: publishedAt.toISOString(),
    config,
  };
}

/** 从快照中安全取出配置；任何结构异常都回退默认主题，绝不把坏数据送到前台。 */
export function themeFromSnapshot(snapshot: unknown): ThemeConfigData {
  try {
    if (!snapshot || typeof snapshot !== 'object') return DEFAULT_THEME;
    const config = (snapshot as Record<string, unknown>).config;
    return normalizeTheme(config);
  } catch {
    return DEFAULT_THEME;
  }
}
