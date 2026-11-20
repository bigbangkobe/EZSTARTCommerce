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

/**
 * 分类 slug 变更的 301（M04 第六批）：
 * 1. 改 slug 自动登记旧地址 → 新地址的 301，前台按登记跳；没登记的旧地址仍然 404，不猜目标；
 * 2. 连续改两次时入站链接被改编成直达最新地址，不堆成一串 5 跳的链；
 * 3. slug 被清空、语言被删除、或换成无法表达成站内路径的 slug 时，指向该地址的跳转一起清理；
 * 4. 停用分类等于下线：跳转全部摘掉，重新启用时地址由当前 slug 决定；
 * 5. 跳转归属写成 category:<id>，重定向清单里能一眼看出是自动登记还是手工登记。
 */
test('category slug changes leave a 301 behind and clean it up when the address goes dark',
  { timeout: 900_000 }, async () => {
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
      const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@category.test`, displayName: 'Staff',
        passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
      await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
      const token = randomBytes(32).toString('base64url');
      const tokenCsrf = csrf(token, config);
      await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
        lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
      return (method: string, path: string, body?: unknown, opts: { schema?: string; version?: number } = {}) =>
        request(method, path, body, { Cookie: `ez_admin_session=${token}`, Origin: origin, 'X-CSRF-Token': tokenCsrf,
          ...(opts.version !== undefined ? { 'If-Match': `"${opts.version}"` } : {}) },
        opts.schema ?? (method === 'DELETE' ? undefined : 'SuccessEnvelope'));
    };

    const publicGet = (path: string, schema?: string) => request('GET', path, undefined, {}, schema);
    /** 旧地址的去向：返回 null 表示没有登记（前台按 404 处理）。 */
    const redirectOf = async (path: string) => {
      const response = await publicGet(`storefront/redirect?path=${encodeURIComponent(path)}`);
      assert.equal(response.status, 200);
      return response.body.data.redirect as { toPath: string; statusCode: number } | null;
    };
    const categoryAt = (locale: string, slug: string) =>
      publicGet(`storefront/categories/${encodeURIComponent(slug)}?locale=${locale}&marketCode=HK`, 'PublicCategoryEnvelope');

    try {
      await identity.initialize();
      app = await createApp(identity); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
      await db.storeConfig.create({ data: { id: 1, displayName: 'Category Store', locales: LOCALES,
        defaultLocale: 'zh-HK', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
      await db.marketProfile.create({ data: { marketCode: 'HK', enabled: true, reviewStatus: 'approved', eligibleProductIds: [] } });

      const owner = await sessionFor(contracts.ownerPermissions);
      const created = await owner('POST', 'admin/categories', { position: 0, enabled: true, translations: [
        { locale: 'zh-HK', name: '雪茄', slug: 'cigars', description: '手捲雪茄' },
        { locale: 'zh-CN', name: '雪茄', slug: 'cigars-cn' },
        { locale: 'en', name: 'Cigars', slug: 'cigars-en' },
      ] });
      assert.equal(created.status, 201);
      const category = created.body.data;
      assert.equal((await categoryAt('zh-HK', 'cigars')).status, 200);

      // 1. 改 slug：旧地址登记 301，未登记的地址照常 404（不猜目标）。
      const first = await owner('PATCH', `admin/categories/${category.id}`, { translations: [
        { locale: 'zh-HK', name: '雪茄', slug: 'cigars-2026', description: '手捲雪茄' },
        { locale: 'zh-CN', name: '雪茄', slug: 'cigars-cn' },
        { locale: 'en', name: 'Cigars', slug: 'cigars-en' },
      ] }, { version: category.version });
      assert.equal(first.status, 200);
      assert.equal(first.body.data.version, category.version + 1);
      assert.equal((await categoryAt('zh-HK', 'cigars')).status, 404);
      assert.equal((await categoryAt('zh-HK', 'cigars-2026')).status, 200);
      assert.deepEqual(await redirectOf('/zh-HK/categories/cigars'),
        { toPath: '/zh-HK/categories/cigars-2026', statusCode: 301 });
      assert.equal(await redirectOf('/zh-HK/categories/never-existed'), null);

      // 2. 只改了一种语言：其他语言的地址不该凭空多出跳转。
      assert.equal(await redirectOf('/en/categories/cigars-en'), null);

      // 3. 重定向清单里能分辨自动/手工，归属写成陈列作用域的 category:<id>。
      const listed = await owner('GET', 'admin/redirects');
      const entry = listed.body.data.items.find((item: any) => item.fromPath === '/zh-HK/categories/cigars');
      assert.equal(entry.toPath, '/zh-HK/categories/cigars-2026');
      assert.equal(entry.auto, true);
      assert.equal(entry.pageKey, `category:${category.id}`);

      // 4. 再改一次：入站链接被改编成直达最新地址，不堆成链。
      const second = await owner('PATCH', `admin/categories/${category.id}`, { translations: [
        { locale: 'zh-HK', name: '雪茄', slug: 'cigars-2027', description: '手捲雪茄' },
        { locale: 'zh-CN', name: '雪茄', slug: 'cigars-cn' },
        { locale: 'en', name: 'Cigars', slug: 'cigars-en' },
      ] }, { version: first.body.data.version });
      assert.equal(second.status, 200);
      assert.deepEqual(await redirectOf('/zh-HK/categories/cigars'),
        { toPath: '/zh-HK/categories/cigars-2027', statusCode: 301 });
      assert.deepEqual(await redirectOf('/zh-HK/categories/cigars-2026'),
        { toPath: '/zh-HK/categories/cigars-2027', statusCode: 301 });

      // 5. 换成无法表达成站内路径的 slug：更新成功，但旧地址的跳转必须摘掉而不是指向一条永远 404 的地址。
      const asciiFirst = await owner('PATCH', `admin/categories/${category.id}`, { translations: [
        { locale: 'zh-HK', name: '雪茄', slug: 'cigars-2027', description: '手捲雪茄' },
        { locale: 'zh-CN', name: '雪茄', slug: 'cigars-cn' },
        { locale: 'en', name: 'Cigars', slug: 'cigars-2026' },
      ] }, { version: second.body.data.version });
      assert.equal(asciiFirst.status, 200);
      assert.deepEqual(await redirectOf('/en/categories/cigars-en'),
        { toPath: '/en/categories/cigars-2026', statusCode: 301 });
      const nonAscii = await owner('PATCH', `admin/categories/${category.id}`, { translations: [
        { locale: 'zh-HK', name: '雪茄', slug: 'cigars-2027', description: '手捲雪茄' },
        { locale: 'zh-CN', name: '雪茄', slug: 'cigars-cn' },
        { locale: 'en', name: 'Cigars', slug: '雪茄' },
      ] }, { version: asciiFirst.body.data.version });
      assert.equal(nonAscii.status, 200);
      assert.equal(await redirectOf('/en/categories/cigars-en'), null);
      // 中文 slug 本身仍然可以访问：跳转登记不了，不等于分类不可用。
      assert.equal((await categoryAt('en', '雪茄')).status, 200);

      // 6. 清空某语言的 slug：指向该地址的跳转一起清理。
      const cleared = await owner('PATCH', `admin/categories/${category.id}`, { translations: [
        { locale: 'zh-HK', name: '雪茄', slug: 'cigars-2027', description: '手捲雪茄' },
        { locale: 'zh-CN', name: '雪茄', slug: 'cigars-cn' },
        { locale: 'en', name: 'Cigars' },
      ] }, { version: nonAscii.body.data.version });
      assert.equal(cleared.status, 200);
      assert.equal((await categoryAt('en', '雪茄')).status, 404);
      assert.notEqual(await redirectOf('/zh-HK/categories/cigars'), null);

      // 7. 停用分类：前台 404，指向它的跳转全部摘掉（不能把访客从一个 404 送到另一个 404）。
      const disabled = await owner('PATCH', `admin/categories/${category.id}`, { enabled: false },
        { version: cleared.body.data.version });
      assert.equal(disabled.status, 200);
      assert.equal((await categoryAt('zh-HK', 'cigars-2027')).status, 404);
      assert.equal(await redirectOf('/zh-HK/categories/cigars'), null);
      assert.equal(await redirectOf('/zh-HK/categories/cigars-2026'), null);

      // 8. 只读账号能看分类，但不能改（改 slug 会动跳转，必须走写权限）。
      const reader = await sessionFor(['catalog.read']);
      assert.equal((await reader('GET', 'admin/categories')).status, 200);
      assert.equal((await reader('PATCH', `admin/categories/${category.id}`, { position: 1 },
        { version: disabled.body.data.version })).status, 403);
    } finally {
      await app?.close();
      await db.$disconnect();
      await cluster.stop();
    }
  });
