import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../apps/api/src/app.js';
import { ContentService } from '../apps/api/src/content/service.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { csrf } from '../apps/api/src/identity/crypto.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { testPostgres } from './helpers/postgres.js';

const LOCALES = ['zh-CN', 'zh-HK', 'en'];
const translation = (locale: string, slug: string) => ({ locale, title: `標題 ${locale}`, slug,
  seoTitle: null, seoDescription: null, indexable: true });
const blocks = [
  { id: 'intro', type: 'rich_text', visible: true, position: 0,
    config: { heading: '關於我們', paragraphs: ['第一段內容。', '第二段內容。'], footnote: null } },
  { id: 'draft-note', type: 'notice', visible: false, position: 1, config: { tone: 'info', text: '內部備註' } },
  { id: 'faq', type: 'faq_list', visible: true, position: 2,
    config: { items: [{ question: '如何聯絡？', answer: 'WhatsApp 聯絡最快。' }] } },
];

/**
 * 内容页的边界全部落在「草稿 → 发布快照 → 前台读取」这条链上，因此直接打真实数据库：
 * 1. 草稿没有公开地址（未发布、撤下、改了 slug 之后都不命中）；
 * 2. 发布是原子切换，三语在同一版本里，发布标记单调递增；
 * 3. 缺语言/空页面/未注册区块类型在发布前就被拒绝；
 * 4. 回滚建新版本并同时恢复草稿，避免下一次发布把旧内容盖回去。
 */
test('content: drafts stay private, publishing is atomic and rollback creates a new version', { timeout: 900_000 }, async t => {
  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  const contracts = new IdentityContracts();
  const origin = 'https://shop.example.test';
  const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
    bootstrapToken: randomBytes(32).toString('base64url') };
  const identity = new IdentityService(db, config, contracts.ownerPermissions);
  let app: INestApplication | undefined;
  let base = '';

  const request = async (method: string, path: string, body: unknown, headers: Record<string, string>, schema?: string) => {
    const response = await fetch(base + '/api/v1/' + path, { method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = response.status === 204 ? null : await response.json();
    if (response.status >= 400) contracts.assert('ErrorEnvelope', data);
    else if (schema) contracts.assert(schema, data);
    return { status: response.status, body: data as any };
  };

  const sessionFor = async (permissions: string[]) => {
    const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
    const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@content.test`, displayName: 'Staff',
      passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
    await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
    const token = randomBytes(32).toString('base64url');
    const tokenCsrf = csrf(token, config);
    await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
      lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
    const call = (method: string, path: string, body?: unknown, opts: { csrf?: string; version?: number; schema?: string } = {}) =>
      request(method, path, body, {
        Cookie: `ez_admin_session=${token}`, Origin: origin,
        'X-CSRF-Token': opts.csrf === undefined ? tokenCsrf : opts.csrf,
        ...(opts.version === undefined ? {} : { 'If-Match': `"${opts.version}"` }),
      }, opts.schema ?? 'SuccessEnvelope');
    return { call, userId: user.id };
  };

  const publicGet = (path: string, schema?: string) => request('GET', `storefront/${path}`, undefined, {}, schema);

  try {
    await identity.initialize();
    app = await createApp(identity); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    await db.storeConfig.create({ data: { id: 1, displayName: 'Content Store', locales: LOCALES,
      defaultLocale: 'zh-HK', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
    const owner = await sessionFor(contracts.ownerPermissions);

    // 1) 建草稿：草稿没有公开地址，前台按任何语言的 slug 都 404。
    const created = await owner.call('POST', 'admin/pages', { pageKey: 'about', pageType: 'standard',
      translations: LOCALES.map(locale => translation(locale, `about-${locale.toLowerCase()}`)), blocks }, { schema: 'SuccessEnvelope' });
    assert.equal(created.status, 201);
    const pageId = created.body.data.id as string;
    assert.equal(created.body.data.status, 'draft');
    assert.equal(created.body.data.version, 1);
    assert.equal(created.body.data.publishedVersion, null);
    for (const locale of LOCALES) {
      assert.equal((await publicGet(`pages/about-${locale}?locale=${locale}`)).status, 404, locale);
    }
    // 公开清单同样为空：草稿不能通过列表接口暴露地址。
    assert.deepEqual((await publicGet('pages?locale=zh-HK')).body.data.items, []);

    // 2) 未注册区块类型在写入阶段就拒绝（不会存下来后在前台静默消失）。
    const unsupported = await owner.call('POST', 'admin/pages', { pageKey: 'custom', pageType: 'standard',
      translations: [translation('zh-HK', 'custom')],
      blocks: [{ id: 'x', type: 'custom_html', visible: true, position: 0, config: {} }] });
    assert.equal(unsupported.status, 422);
    assert.equal(unsupported.body.error.code, 'CONTENT_BLOCK_UNSUPPORTED');

    // 3) 缺语言不能发布：返回可区分的错误码，而不是静默回退到默认语言。
    const partial = await owner.call('POST', 'admin/pages', { pageKey: 'partial', pageType: 'policy',
      translations: [translation('zh-HK', 'partial-hk')],
      blocks: [{ id: 'intro', type: 'rich_text', visible: true, position: 0, config: { paragraphs: ['內容'] } }] });
    const partialId = partial.body.data.id as string;
    const incomplete = await owner.call('POST', `admin/pages/${partialId}/publish`, { expectedVersion: 1 });
    assert.equal(incomplete.status, 422);
    assert.equal(incomplete.body.error.code, 'CONTENT_LOCALE_INCOMPLETE');
    // 缺语言的页面仍未上线。
    assert.equal((await publicGet('pages/partial-hk?locale=zh-HK')).status, 404);

    // 4) 编辑草稿：版本递增；用旧版本发布会被拒绝（版本冲突，不是覆盖）。
    const edited = await owner.call('PATCH', `admin/pages/${pageId}`, { translations: [
      translation('zh-CN', 'about-cn'), translation('zh-HK', 'about-hk'), translation('en', 'about-en')], blocks },
      { version: 1 });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.data.version, 2);
    const stale = await owner.call('POST', `admin/pages/${pageId}/publish`, { expectedVersion: 1 });
    assert.equal(stale.status, 409);

    // 5) 发布：线上切到新版本，发布标记 cr-N 前进；三语同时可用。
    const before = (await publicGet('config?locale=zh-HK')).body.data.contentRelease as string;
    const published = await owner.call('POST', `admin/pages/${pageId}/publish`, { expectedVersion: 2 });
    assert.equal(published.status, 200);
    assert.equal(published.body.data.scheduled, false);
    assert.equal(published.body.data.page.status, 'published');
    assert.equal(published.body.data.page.publishedVersion.version, 2);
    assert.match(published.body.data.releaseToken, /^cr-[0-9]+$/);
    const after = (await publicGet('config?locale=zh-HK')).body.data.contentRelease as string;
    assert.notEqual(after, before);

    const hk = await publicGet('pages/about-hk?locale=zh-HK', 'PublicPageEnvelope');
    assert.equal(hk.status, 200);
    assert.equal(hk.body.data.pageKey, 'about');
    assert.equal(hk.body.data.locale, 'zh-HK');
    assert.equal(hk.body.data.indexable, true);
    // 隐藏区块不下发：接口不是预览通道。
    assert.deepEqual(hk.body.data.blocks.map((block: { id: string }) => block.id), ['intro', 'faq']);
    assert.equal(hk.body.data.alternates.length, 3);
    assert.equal(hk.body.data.contentRelease, after);
    // 别名地址：命中同一页面但不换语言内容。
    const en = await publicGet('pages/about-en?locale=en', 'PublicPageEnvelope');
    assert.equal(en.body.data.locale, 'en');
    assert.equal(en.body.data.title, '標題 en');

    // 6) 公开清单只含已发布页面（缺语言的 partial 仍不在里面）。
    const listed = await publicGet('pages?locale=zh-HK', 'PublicPageListEnvelope');
    assert.deepEqual(listed.body.data.items.map((item: { pageKey: string }) => item.pageKey), ['about']);
    assert.equal(listed.body.data.items[0].indexable, true);

    // 7) 改 slug 后重新发布：旧地址立即失效，新地址命中；草稿改动不影响线上直到发布。
    const renamed = await owner.call('PATCH', `admin/pages/${pageId}`, { translations: [
      translation('zh-CN', 'about-cn'), translation('zh-HK', 'about-us'), translation('en', 'about-en')] },
      { version: 3 });
    assert.equal(renamed.status, 200);
    assert.equal((await publicGet('pages/about-us?locale=zh-HK')).status, 404);
    assert.equal((await publicGet('pages/about-hk?locale=zh-HK')).status, 200);
    const republished = await owner.call('POST', `admin/pages/${pageId}/publish`, { expectedVersion: 4 });
    assert.equal(republished.status, 200);
    assert.equal((await publicGet('pages/about-hk?locale=zh-HK')).status, 404);
    const moved = await publicGet('pages/about-us?locale=zh-HK');
    assert.equal(moved.status, 200);
    assert.equal(moved.body.data.slug, 'about-us');

    // 8) 撤下：公开地址立即失效，版本保留为 withdrawn（可回滚重发）。
    const withdrawn = await owner.call('POST', `admin/pages/${pageId}/unpublish`, { reason: '政策更新中' });
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.body.data.page.status, 'withdrawn');
    assert.equal((await publicGet('pages/about-us?locale=zh-HK')).status, 404);
    assert.deepEqual((await publicGet('pages?locale=zh-HK')).body.data.items, []);
    const versions = await owner.call('GET', `admin/pages/${pageId}`);
    assert.equal(versions.body.data.versions[0].status, 'withdrawn');

    // 9) 回滚到第一版：建新版本、同时把草稿恢复成旧内容，避免下次发布把新草稿盖回来。
    const rollback = await owner.call('POST', `admin/pages/${pageId}/rollback`,
      { sourceVersion: 2, reason: '恢復初版', expectedVersion: versions.body.data.version });
    assert.equal(rollback.status, 201);
    assert.equal(rollback.body.data.page.status, 'published');
    assert.equal(rollback.body.data.page.translations.find((item: { locale: string }) => item.locale === 'zh-HK').publishedSlug,
      'about-hk');
    const restored = await publicGet('pages/about-hk?locale=zh-HK', 'PublicPageEnvelope');
    assert.equal(restored.status, 200);
    assert.equal(restored.body.data.blocks.length, 2);
    const history = await owner.call('GET', `admin/pages/${pageId}`);
    assert.ok(history.body.data.versions.some((version: { status: string }) => version.status === 'superseded'));

    // 10) 定时发布：登记计划不切线上；编辑会取消计划；到点由后台任务发布。
    const promo = await owner.call('POST', 'admin/pages', { pageKey: 'promo', pageType: 'announcement',
      translations: LOCALES.map(locale => translation(locale, `promo-${locale.toLowerCase()}`)),
      blocks: [{ id: 'intro', type: 'notice', visible: true, position: 0, config: { tone: 'info', text: '新品上市' } }] });
    const promoId = promo.body.data.id as string;
    const scheduled = await owner.call('POST', `admin/pages/${promoId}/publish`,
      { expectedVersion: 1, mode: 'scheduled', scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal(scheduled.status, 202);
    assert.equal(scheduled.body.data.scheduled, true);
    assert.equal((await publicGet('pages/promo-zh-hk?locale=zh-HK')).status, 404);
    const editedSchedule = await owner.call('PATCH', `admin/pages/${promoId}`,
      { blocks: [{ id: 'intro', type: 'notice', visible: true, position: 0, config: { tone: 'warning', text: '延後上市' } }] },
      { version: 1 });
    assert.equal(editedSchedule.body.data.status, 'draft');
    assert.equal(editedSchedule.body.data.scheduledAt, null);

    // 重新定时后由 worker 到点执行：这里用未来的时间点直接驱动调度逻辑。
    const rescheduled = await owner.call('POST', `admin/pages/${promoId}/publish`,
      { expectedVersion: 2, mode: 'scheduled', scheduledAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(rescheduled.status, 202);
    const worker = new ContentService(identity);
    assert.equal(await worker.publishDue(new Date(Date.now() + 120_000)), 1);
    const promoLive = await publicGet('pages/promo-zh-hk?locale=zh-HK', 'PublicPageEnvelope');
    assert.equal(promoLive.status, 200);
    assert.equal(promoLive.body.data.blocks[0].type, 'notice');
    const audit = await db.auditLog.findFirst({ where: { action: 'content.page.published', objectId: promoId } });
    assert.ok(audit, 'scheduled publish must leave an audit row');

    // 11) 权限边界：能写草稿不等于能发布；没有 content.read 连列表都看不到。
    const writer = await sessionFor(['content.read', 'content.write']);
    assert.equal((await writer.call('POST', `admin/pages/${pageId}/publish`, { expectedVersion: 1 })).status, 403);
    const stranger = await sessionFor(['reports.view']);
    assert.equal((await stranger.call('GET', 'admin/pages')).status, 403);
    // 跨站请求（Origin 不匹配）不能写：CSRF 边界在控制器上，不在业务层。
    assert.equal((await owner.call('POST', 'admin/pages', { pageKey: 'x', pageType: 'standard',
      translations: [translation('zh-HK', 'x')], blocks: [] }, { csrf: 'wrong-token' })).status, 403);

    t.diagnostic('content: 草稿隔离、原子发布、发布标记、撤下与回滚、定时发布与权限边界均通过');
  } finally {
    if (app) await app.close();
    await db.$disconnect();
    await cluster.stop();
  }
});
