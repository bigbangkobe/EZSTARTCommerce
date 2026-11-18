/**
 * 内容页纯规则层（M04 第一批）。
 *
 * 只回答四件事：页面/语言/区块怎么校验、发布前必须齐全什么、发布快照长什么样、
 * 内容发布标记怎么算。不碰数据库、不碰网络。
 *
 * 安全与一致性不变量（对应 docs/modules/M04_CONTENT_CMS.md 与开发规格 8.1）：
 * 1. 区块类型是**服务端注册表**的闭集：主题没注册的类型直接拒绝，不能静默存下来后在前台失效。
 * 2. 区块配置按类型逐字段白名单校验，拒绝 HTML/脚本字符与未知字段——后台不是任意代码编辑器。
 * 3. 发布要求店铺**已启用的每种语言**都有完整翻译，不静默回退到另一种语言。
 * 4. slug 是小写 ASCII 短横线串，排除空白/大写/路径字符，避免同页两个可索引 URL。
 * 5. 发布快照是不可变 JSON：线上内容只能通过新版本切换，草稿永远不进前台。
 */

export class ContentRuleError extends Error {
  constructor(readonly field: string, readonly code = 'VALIDATION_ERROR') { super(field); }
}

function fail(field: string, code = 'VALIDATION_ERROR'): never { throw new ContentRuleError(field, code); }

/** 页面类型闭集：标准内容页、文章、政策、FAQ、公告。 */
export const CONTENT_PAGE_TYPES = ['standard', 'article', 'policy', 'faq', 'announcement'] as const;
export type ContentPageType = typeof CONTENT_PAGE_TYPES[number];

/**
 * 参考主题注册的区块类型。新增类型必须同时补前台渲染与配置校验，
 * 否则后台能存、前台不会显示——这正是规格禁止的「配置静默失效」。
 */
export const CONTENT_BLOCK_TYPES = ['rich_text', 'faq_list', 'contact_card', 'notice'] as const;
export type ContentBlockType = typeof CONTENT_BLOCK_TYPES[number];

/** 单页区块数量上限：防止一页塞进整站内容导致渲染与预览失控。 */
export const MAX_BLOCKS_PER_PAGE = 40;
/** 定时发布的时间窗：必须晚于当前时间，且不超过一年（超长计划通常是填错年份）。 */
const MAX_SCHEDULE_AHEAD_MS = 365 * 86_400_000;

export const PAGE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
export const PAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const BLOCK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertPageKey(value: unknown): string {
  if (typeof value !== 'string' || !PAGE_KEY_PATTERN.test(value)) fail('pageKey');
  return value;
}

export function assertPageType(value: unknown): ContentPageType {
  if (typeof value !== 'string' || !CONTENT_PAGE_TYPES.includes(value as ContentPageType)) fail('pageType');
  return value as ContentPageType;
}

export function assertPageSlug(value: unknown, field = 'slug'): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 180) fail(field);
  if (!PAGE_SLUG_PATTERN.test(value)) fail(field);
  return value;
}

/** 后台可见文本：拒绝 HTML 标签与 C0/C1 控制字符，长度按字段收敛。 */
function plain(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') fail(field);
  const text = value.trim();
  if (text.length < min || text.length > max) fail(field);
  if (/[<>]/.test(text) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) fail(field);
  return text;
}

function optionalPlain(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return plain(value, field, 1, max);
}

function closedObject(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(field);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!allowed.includes(key)) fail(`${field}.${key}`);
  return object;
}

function arrayOf<T>(value: unknown, field: string, min: number, max: number, each: (item: unknown, field: string) => T): T[] {
  if (!Array.isArray(value)) fail(field);
  if (value.length < min || value.length > max) fail(field);
  return value.map((item, index) => each(item, `${field}[${index}]`));
}

function normalizeRichText(config: Record<string, unknown>): Record<string, unknown> {
  return {
    heading: optionalPlain(config['heading'], 'config.heading', 200),
    paragraphs: arrayOf(config['paragraphs'], 'config.paragraphs', 1, 40, (item, field) => plain(item, field, 1, 2000)),
    footnote: optionalPlain(config['footnote'], 'config.footnote', 500),
  };
}

function normalizeFaqList(config: Record<string, unknown>): Record<string, unknown> {
  return {
    items: arrayOf(config['items'], 'config.items', 1, 50, (item, field) => {
      const entry = closedObject(item, field, ['question', 'answer']);
      return { question: plain(entry['question'], `${field}.question`, 1, 300),
        answer: plain(entry['answer'], `${field}.answer`, 1, 2000) };
    }),
  };
}

function normalizeContactCard(config: Record<string, unknown>): Record<string, unknown> {
  const email = optionalPlain(config['email'], 'config.email', 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('config.email');
  const showWhatsApp = config['showWhatsApp'];
  if (showWhatsApp !== undefined && typeof showWhatsApp !== 'boolean') fail('config.showWhatsApp');
  return {
    heading: optionalPlain(config['heading'], 'config.heading', 120),
    body: optionalPlain(config['body'], 'config.body', 2000),
    email,
    showWhatsApp: showWhatsApp === true,
  };
}

function normalizeNotice(config: Record<string, unknown>): Record<string, unknown> {
  const tone = config['tone'];
  if (tone !== 'info' && tone !== 'warning' && tone !== 'critical') fail('config.tone');
  return { tone, text: plain(config['text'], 'config.text', 1, 1000) };
}

const BLOCK_NORMALIZERS: Record<ContentBlockType, (config: Record<string, unknown>) => Record<string, unknown>> = {
  rich_text: normalizeRichText,
  faq_list: normalizeFaqList,
  contact_card: normalizeContactCard,
  notice: normalizeNotice,
};

/** 按注册表校验并收敛区块配置；未注册的类型直接拒绝（不是存下来后在前台悄悄消失）。 */
export function normalizeBlockConfig(type: ContentBlockType, config: unknown): Record<string, unknown> {
  const allowed: Record<ContentBlockType, readonly string[]> = {
    rich_text: ['heading', 'paragraphs', 'footnote'],
    faq_list: ['items'],
    contact_card: ['heading', 'body', 'email', 'showWhatsApp'],
    notice: ['tone', 'text'],
  };
  return BLOCK_NORMALIZERS[type](closedObject(config, 'config', allowed[type]));
}

export interface ContentBlock {
  id: string;
  type: ContentBlockType;
  visible: boolean;
  position: number;
  config: Record<string, unknown>;
}

/**
 * 区块规范化：按 (position, id) 稳定排序，重复 id 直接拒绝。
 * 顺序是**区块内**的展示顺序，不影响商品全局数据。
 */
export function normalizeBlocks(input: unknown): ContentBlock[] {
  if (!Array.isArray(input)) fail('blocks');
  if (input.length > MAX_BLOCKS_PER_PAGE) fail('blocks');
  const seen = new Set<string>();
  const blocks = input.map((item, index) => {
    const block = closedObject(item, `blocks[${index}]`, ['id', 'type', 'visible', 'position', 'config']);
    const id = block['id'];
    if (typeof id !== 'string' || !BLOCK_ID_PATTERN.test(id)) fail(`blocks[${index}].id`);
    if (seen.has(id)) fail(`blocks[${index}].id`, 'DUPLICATE_BLOCK');
    seen.add(id);
    const type = block['type'];
    if (typeof type !== 'string' || !CONTENT_BLOCK_TYPES.includes(type as ContentBlockType)) fail(`blocks[${index}].type`, 'UNSUPPORTED_BLOCK_TYPE');
    if (typeof block['visible'] !== 'boolean') fail(`blocks[${index}].visible`);
    const position = block['position'];
    if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0 || position > 9999) fail(`blocks[${index}].position`);
    return { id, type: type as ContentBlockType, visible: block['visible'], position,
      config: normalizeBlockConfig(type as ContentBlockType, block['config']) };
  });
  return blocks.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

export interface ContentTranslationInput {
  locale: string;
  title: string;
  slug: string;
  seoTitle: string | null;
  seoDescription: string | null;
  indexable: boolean;
}

/**
 * 翻译规范化。草稿允许只写部分语言（编辑中很正常），
 * 但**发布**前必须补齐店铺已启用的全部语言，见 missingLocales()。
 */
export function normalizePageTranslations(input: unknown, enabledLocales: readonly string[]): ContentTranslationInput[] {
  if (!Array.isArray(input) || input.length === 0) fail('translations');
  const seen = new Set<string>();
  return input.map((item, index) => {
    const entry = closedObject(item, `translations[${index}]`, ['locale', 'title', 'slug', 'seoTitle', 'seoDescription', 'indexable']);
    const locale = entry['locale'];
    if (typeof locale !== 'string' || !enabledLocales.includes(locale)) fail(`translations[${index}].locale`);
    if (seen.has(locale)) fail(`translations[${index}].locale`, 'DUPLICATE_LOCALE');
    seen.add(locale);
    if (typeof entry['indexable'] !== 'boolean') fail(`translations[${index}].indexable`);
    const seoTitle = optionalPlain(entry['seoTitle'], `translations[${index}].seoTitle`, 70);
    const seoDescription = optionalPlain(entry['seoDescription'], `translations[${index}].seoDescription`, 320);
    return { locale, title: plain(entry['title'], `translations[${index}].title`, 1, 200),
      slug: assertPageSlug(entry['slug'], `translations[${index}].slug`), seoTitle, seoDescription,
      indexable: entry['indexable'] };
  });
}

/** 发布前必须齐全的语言；返回缺失列表供后台给出可修复提示（不静默回退）。 */
export function missingLocales(translations: readonly { locale: string }[], enabledLocales: readonly string[]): string[] {
  const have = new Set(translations.map(translation => translation.locale));
  return enabledLocales.filter(locale => !have.has(locale));
}

/** 发布前置校验：三语齐全 + 至少一个可见区块。空页面发布等于发布一张空白首页。 */
export function assertPublishable(translations: readonly { locale: string }[], blocks: readonly ContentBlock[],
  enabledLocales: readonly string[]): { missingLocales: string[]; visibleBlocks: number } {
  const missing = missingLocales(translations, enabledLocales);
  const visibleBlocks = blocks.filter(block => block.visible).length;
  if (!missing.length && !visibleBlocks) fail('blocks', 'NO_VISIBLE_BLOCK');
  return { missingLocales: missing, visibleBlocks };
}

export type PublishMode = 'immediate' | 'scheduled';

export interface PublishPlan {
  mode: PublishMode;
  scheduledAt: Date | null;
}

/**
 * 发布计划规范化：立即发布不接受 scheduledAt；定时发布必须晚于服务端当前时间。
 * 时间由服务端判断（客户端时钟不可信），存的是绝对时刻，展示才用店铺时区。
 */
export function normalizePublishPlan(input: unknown, now: Date): PublishPlan {
  if (input === undefined || input === null) return { mode: 'immediate', scheduledAt: null };
  const value = closedObject(input, 'publish', ['mode', 'scheduledAt']);
  const mode = value['mode'] ?? 'immediate';
  if (mode !== 'immediate' && mode !== 'scheduled') fail('publish.mode');
  const raw = value['scheduledAt'];
  if (mode === 'immediate') {
    if (raw !== undefined && raw !== null) fail('publish.scheduledAt', 'SCHEDULE_NOT_ALLOWED');
    return { mode: 'immediate', scheduledAt: null };
  }
  if (typeof raw !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(raw)) fail('publish.scheduledAt');
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) fail('publish.scheduledAt');
  const delta = at.getTime() - now.getTime();
  if (delta <= 0) fail('publish.scheduledAt', 'SCHEDULE_IN_PAST');
  if (delta > MAX_SCHEDULE_AHEAD_MS) fail('publish.scheduledAt', 'SCHEDULE_TOO_FAR');
  return { mode: 'scheduled', scheduledAt: at };
}

export interface PageSnapshot {
  pageKey: string;
  pageType: ContentPageType;
  translations: ContentTranslationInput[];
  blocks: ContentBlock[];
}

/** 发布快照：写进版本行后不再改写；前台只读它，不读草稿表。 */
export function pageSnapshot(pageKey: string, pageType: string, translations: readonly ContentTranslationInput[],
  blocks: readonly ContentBlock[]): PageSnapshot {
  return {
    pageKey: assertPageKey(pageKey),
    pageType: assertPageType(pageType),
    translations: [...translations].map(translation => ({ ...translation })).sort((left, right) => left.locale.localeCompare(right.locale)),
    blocks: blocks.map(block => ({ ...block, config: { ...block.config } }))
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id)),
  };
}

/** 前台可见区块：隐藏区块不发出去，避免把未完成内容当接口数据泄露。 */
export function visibleBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.filter(block => block.visible);
}

/** 内容发布标记（写进区块事件的 publishVersionId）：单调递增，前台缓存与报表都认它。 */
export function contentReleaseToken(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) fail('releaseSeq');
  return `cr-${seq}`;
}

/** 版本号单调递增：回滚也要建新版本，历史版本不可覆盖。 */
export function nextVersion(current: number, latestPublished: number): number {
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(latestPublished)) fail('version');
  return Math.max(current, latestPublished, 0) + 1;
}
