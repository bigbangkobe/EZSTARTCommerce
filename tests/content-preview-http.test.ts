import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { csrf } from '../apps/api/src/identity/crypto.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { testPostgres } from './helpers/postgres.js';

const LOCALES = ['zh-CN', 'zh-HK', 'en'];
const translation = (locale: string, slug: string) => ({ locale, title: `標題 ${locale}`, slug,
  seoTitle: null, seoDescription: null, indexable: true });
const visibleBlock = (text: string) => [{ id: 'intro', type: 'rich_text', visible: true, position: 0,
  config: { heading: '關於我們', paragraphs: [text] } }];

/**
 * 预览外链与 301 的边界（M04 第二批）：
 * 1. 预览必须持 token、限制在签发时的语言/视口/版本，且永远 noindex、不缓存；
 * 2. 预览看到的是草稿，线上页面仍是旧版本——预览不能顺手把内容推上线；
 * 3. 改 slug 发布后旧地址自动 301 到新地址，撤下时清理指向它的跳转；
 * 4. 手工重定向拒绝自跳、成环、遮挡在线页面与重复登记。
 */
test('preview links expose drafts only through tokens and slug changes keep old URLs alive',
  { timeout: 900_000 }, async t => {
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
      else if (schema && response.status !== 204) contracts.assert(schema, data);
      return { status: response.status, body: data as any, headers: response.headers };
    };

    const sessionFor = async (permissions: string[]) => {
      const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
      const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@preview.test`, displayName: 'Staff',
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
      await db.storeConfig.create({ data: { id: 1, displayName: 'Preview Store', locales: LOCALES,
        defaultLocale: 'zh-HK', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
      const owner = await sessionFor(contracts.ownerPermissions);
      // 只给内容读写、不给预览权限：预览是单独的能力，不能靠 content.read 换到草稿外链。
      const writer = await sessionFor(['content.read', 'content.write']);

      const created = await owner.call('POST', 'admin/pages', { pageKey: 'about', pageType: 'standard',
        translations: LOCALES.map(locale => translation(locale, `about-${locale.toLowerCase()}`)),
        blocks: visibleBlock('已發佈的內容') });
      const pageId = created.body.data.id as string;
      await owner.call('POST', `admin/pages/${pageId}/publish`, { expectedVersion: 1 });
      assert.equal((await publicGet('pages/about-zh-hk?locale=zh-HK')).body.data.blocks[0].config.paragraphs[0],
        '已發佈的內容');

      // 1) 权限与版本：没有 content.preview 不能签发；旧版本不能签发（防止预览到未审阅的草稿）。
      const denied = await writer.call('POST', `admin/pages/${pageId}/preview-token`,
        { locale: 'zh-HK', viewport: 'desktop', expectedVersion: 2 });
      assert.equal(denied.status, 403);
      const stale = await owner.call('POST', `admin/pages/${pageId}/preview-token`,
        { locale: 'zh-HK', viewport: 'desktop', expectedVersion: 1 });
      assert.equal(stale.status, 409);

      // 2) 改草稿但不发布：预览看到新内容，公开地址仍是旧内容。
      const current = await owner.call('GET', `admin/pages/${pageId}`);
      const version = current.body.data.version as number;
      await owner.call('PATCH', `admin/pages/${pageId}`, { blocks: visibleBlock('草稿中的新內容') },
        { version, schema: 'SuccessEnvelope' });
      const issued = await owner.call('POST', `admin/pages/${pageId}/preview-token`,
        { locale: 'zh-HK', viewport: 'mobile', expectedVersion: version + 1 }, { schema: 'SuccessEnvelope' });
      assert.equal(issued.status, 201);
      assert.equal(issued.body.data.locale, 'zh-HK');
      assert.equal(issued.body.data.viewport, 'mobile');
      assert.match(issued.body.data.path, /^\/zh-HK\/preview\/[A-Za-z0-9_-]{43}\?viewport=mobile$/);
      const token = issued.body.data.token as string;

      const preview = await publicGet(`preview/${token}`, 'SuccessEnvelope');
      assert.equal(preview.status, 200);
      assert.equal(preview.body.data.preview, true);
      assert.equal(preview.body.data.locale, 'zh-HK');
      assert.equal(preview.body.data.viewport, 'mobile');
      assert.equal(preview.body.data.blocks[0].config.paragraphs[0], '草稿中的新內容');
      // 预览永远不可索引，且必须禁止缓存（草稿会被继续编辑，缓存会把旧草稿钉在链接上）。
      assert.equal(preview.body.data.indexable, false);
      assert.match(String(preview.headers.get('cache-control')), /no-store/);
      assert.match(String(preview.headers.get('x-robots-tag')), /noindex/);
      // 草稿没有进入线上：公开地址仍是发布时的内容。
      assert.equal((await publicGet('pages/about-zh-hk?locale=zh-HK')).body.data.blocks[0].config.paragraphs[0],
        '已發佈的內容');
      // 草稿的 slug 也没变，所以新地址不命中。
      assert.equal((await publicGet('pages/draft-only?locale=zh-HK')).status, 404);

      // 3) 过期与伪造：都当 404，不给探测信号。
      assert.equal((await publicGet(`preview/${'B'.repeat(43)}`)).status, 404);
      assert.equal((await publicGet('preview/short')).status, 404);
      await db.contentPreviewToken.updateMany({ where: { pageId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await publicGet(`preview/${token}`)).status, 404);

      // 4) 改 slug 发布：旧地址自动 301 到新地址，并且链在服务端一次走完。
      const published = await owner.call('GET', `admin/pages/${pageId}`);
      const slugVersion = published.body.data.version as number;
      await owner.call('PATCH', `admin/pages/${pageId}`, {
        translations: LOCALES.map(locale => translation(locale, locale === 'zh-HK' ? 'about-us' : `about-${locale.toLowerCase()}`)),
      }, { version: slugVersion, schema: 'SuccessEnvelope' });
      await owner.call('POST', `admin/pages/${pageId}/publish`, { expectedVersion: slugVersion + 1 });

      const moved = await publicGet('redirect?path=%2Fzh-HK%2Fpages%2Fabout-zh-hk', 'SuccessEnvelope');
      assert.equal(moved.status, 200);
      assert.deepEqual(moved.body.data.redirect, { toPath: '/zh-HK/pages/about-us', statusCode: 301 });
      // 旧地址本身已经 404（前台靠重定向表跳转），新地址正常。
      assert.equal((await publicGet('pages/about-zh-hk?locale=zh-HK')).status, 404);
      assert.equal((await publicGet('pages/about-us?locale=zh-HK')).status, 200);
      const listed = await publicGet('redirects', 'SuccessEnvelope');
      assert.deepEqual(listed.body.data.items, [{ fromPath: '/zh-HK/pages/about-zh-hk', toPath: '/zh-HK/pages/about-us', statusCode: 301 }]);

      // 5) 手工重定向：自跳、成环、重复、遮挡在线页面都拒绝。
      const self = await owner.call('POST', 'admin/redirects',
        { locale: 'zh-HK', fromPath: '/zh-HK/pages/x', toPath: '/zh-HK/pages/x' });
      assert.equal(self.status, 422); assert.equal(self.body.error.code, 'REDIRECT_SELF');
      const shadow = await owner.call('POST', 'admin/redirects',
        { locale: 'zh-HK', fromPath: '/zh-HK/pages/about-us', toPath: '/zh-HK/pages/elsewhere' });
      assert.equal(shadow.status, 409); assert.equal(shadow.body.error.code, 'REDIRECT_SHADOWS_PAGE');
      // 成环用两个都不在线的地址验证：a → b 成功后，b → a 必须被拒绝。
      const first = await owner.call('POST', 'admin/redirects',
        { locale: 'zh-HK', fromPath: '/zh-HK/pages/loop-a', toPath: '/zh-HK/pages/loop-b' }, { schema: 'SuccessEnvelope' });
      assert.equal(first.status, 201);
      const loop = await owner.call('POST', 'admin/redirects',
        { locale: 'zh-HK', fromPath: '/zh-HK/pages/loop-b', toPath: '/zh-HK/pages/loop-a' });
      assert.equal(loop.status, 422); assert.equal(loop.body.error.code, 'REDIRECT_LOOP');
      const duplicate = await owner.call('POST', 'admin/redirects',
        { locale: 'zh-HK', fromPath: '/zh-HK/pages/about-zh-hk', toPath: '/zh-HK/pages/about' });
      assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error.code, 'REDIRECT_EXISTS');
      const manual = await owner.call('POST', 'admin/redirects',
        { locale: 'zh-HK', fromPath: '/zh-HK/pages/legacy', toPath: '/zh-HK/pages/about-us' }, { schema: 'SuccessEnvelope' });
      assert.equal(manual.status, 201);
      // 手工登记也会被解析：链一次走完，不会留下两跳。
      assert.deepEqual((await publicGet('redirect?path=%2Fzh-HK%2Fpages%2Flegacy')).body.data.redirect,
        { toPath: '/zh-HK/pages/about-us', statusCode: 301 });
      const removed = await owner.call('DELETE', `admin/redirects/${manual.body.data.id}`);
      assert.equal(removed.status, 204);
      assert.equal((await publicGet('redirect?path=%2Fzh-HK%2Fpages%2Flegacy')).body.data.redirect, null);

      // 6) 撤下页面：指向它的重定向一起清理，避免 301 把访客送到不存在的地址。
      const latest = await owner.call('GET', `admin/pages/${pageId}`);
      await owner.call('POST', `admin/pages/${pageId}/unpublish`, { reason: '不再需要' });
      assert.equal((await publicGet('redirect?path=%2Fzh-HK%2Fpages%2Fabout-zh-hk')).body.data.redirect, null);
      assert.ok(latest.body.data.version >= 3);
    } finally {
      await app?.close();
      await db.$disconnect();
      await cluster.stop();
    }
  });
