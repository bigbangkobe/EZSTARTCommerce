/**
 * 预览外链纯规则（M04 第二批）。
 *
 * 只回答：预览请求怎么校验、链接长什么样、什么时候算失效。不碰数据库、不碰网络。
 *
 * 不变量：
 * 1. 预览绑定「页面 + 语言 + 视口 + 签发时的草稿版本」，不能靠改查询参数跳到别的语言或更新版本。
 * 2. 有效期由服务端判定，客户端时间不可信；最长 24 小时，避免长期可访问的绕过入口。
 * 3. token 是 32 字节随机数的 base64url，只以 SHA-256 入库——库泄漏也拿不到可用链接。
 * 4. 预览只读，不改变线上版本、不产生内容发布标记、不写分析事件。
 */

export class PreviewRuleError extends Error {
  constructor(readonly field: string, readonly code = 'VALIDATION_ERROR') { super(field); }
}

function fail(field: string, code = 'VALIDATION_ERROR'): never { throw new PreviewRuleError(field, code); }

export const PREVIEW_VIEWPORTS = ['desktop', 'mobile'] as const;
export type PreviewViewport = typeof PREVIEW_VIEWPORTS[number];

export const PREVIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PREVIEW_DEFAULT_TTL_MINUTES = 60;
export const PREVIEW_MAX_TTL_MINUTES = 24 * 60;

export interface PreviewPlan {
  locale: string;
  viewport: PreviewViewport;
  expiresAt: Date;
}

/**
 * 预览请求规范化。expectedVersion 由后台传入：只有「后台正在看的那一版」才能签发，
 * 否则两个编辑同时改稿时，A 的预览链接会显示 B 还没看过的内容。
 */
export function normalizePreviewPlan(input: unknown, enabledLocales: readonly string[], now: Date): PreviewPlan {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('preview');
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!['locale', 'viewport', 'ttlMinutes', 'expectedVersion'].includes(key)) fail(`preview.${key}`);
  }
  const locale = body['locale'];
  if (typeof locale !== 'string' || !enabledLocales.includes(locale)) fail('preview.locale');
  const viewport = body['viewport'];
  if (typeof viewport !== 'string' || !PREVIEW_VIEWPORTS.includes(viewport as PreviewViewport)) fail('preview.viewport');
  const ttl = body['ttlMinutes'];
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 5 || ttl > PREVIEW_MAX_TTL_MINUTES)) {
    fail('preview.ttlMinutes');
  }
  return { locale, viewport: viewport as PreviewViewport,
    expiresAt: new Date(now.getTime() + (ttl === undefined ? PREVIEW_DEFAULT_TTL_MINUTES : ttl) * 60_000) };
}

/**
 * 前台预览路由：语言在路径段（复用前台的语言布局与 html lang），视口在查询串。
 * 语言必须在路径里，因为预览页要落在 [locale] 布局下才能拿到正确的字体与页头。
 */
export function previewPath(token: string, plan: PreviewPlan): string {
  if (typeof token !== 'string' || !PREVIEW_TOKEN_PATTERN.test(token)) fail('token');
  return `/${encodeURIComponent(plan.locale)}/preview/${token}?viewport=${plan.viewport}`;
}

/** 失效判定只看服务端时间：过期、或从未存在的 token 都当 404，不区分原因（不给探测留信号）。 */
export function isPreviewLive(expiresAt: Date, now: Date): boolean {
  return expiresAt instanceof Date && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > now.getTime();
}

/** 预览页的 noindex 头：链接本身不该被任何爬虫收录。 */
export const PREVIEW_ROBOTS_HEADER = 'noindex, nofollow, noarchive';
