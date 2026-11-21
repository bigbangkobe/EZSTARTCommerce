import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { passwordHash } from '../apps/api/src/identity/crypto.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { testPostgres } from './helpers/postgres.js';

/**
 * 私有部署的店主可能只要「账号 + 密码」：账号名不是邮箱、也不要每次输六位码。
 * 这两件事都必须由实例配置决定，不能改死模板默认值 —— 默认仍然是强制 MFA。
 */
test('自由账号名登录，且 ADMIN_REQUIRE_MFA=false 时密码通过即发会话', { timeout: 120_000 }, async t => {
  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  const contracts = new IdentityContracts();
  const origin = 'https://shop.example.test';
  const base = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32) };
  const enforced = new IdentityService(db, base, contracts.ownerPermissions);
  const relaxed = new IdentityService(db, { ...base, requireMfa: false }, contracts.ownerPermissions);
  let app: INestApplication | undefined;
  let relaxedApp: INestApplication | undefined;
  const jar = new Map<string, string>();
  const call = async (server: string, path: string, body?: unknown) => {
    const response = await fetch(server + '/api/v1/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json',
        Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0]!; const index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return { status: response.status, body: response.status === 204 ? null : await response.json() as Record<string, any> };
  };
  try {
    await enforced.initialize();
    const role = await db.adminRole.findFirst({ where: { kind: 'owner' } });
    assert.ok(role, '初始化后应存在 owner 角色');
    // 账号名就是 admin：契约不再要求邮箱格式，这也是生产的实际形态。
    await db.adminUser.create({ data: { email: 'admin', displayName: '店主', locale: 'zh-HK',
      passwordHash: await passwordHash('admin@12'), mfaRequired: true, roles: { create: { roleId: role.id } } } });
    app = await createApp(enforced); await app.listen(0, '127.0.0.1');
    relaxedApp = await createApp(relaxed); await relaxedApp.listen(0, '127.0.0.1');

    await t.test('默认实例仍然要求二次验证（模板默认值不能被动到）', async () => {
      const result = await call(await app!.getUrl(), 'admin/auth/login', { email: 'admin', password: 'admin@12' });
      assert.equal(result.status, 202);
      // 还没有因子时是登记挑战，已登记过才是验证挑战；两者都说明 MFA 闸门仍然生效。
      assert.ok(result.body && ['enroll_mfa', 'verify_mfa'].includes(result.body.data.nextAction));
    });

    await t.test('关闭强制 MFA 后密码通过即发会话，且账号名可以是 admin', async () => {
      const result = await call(await relaxedApp!.getUrl(), 'admin/auth/login', { email: 'admin', password: 'admin@12' });
      assert.equal(result.status, 200);
      assert.ok(result.body);
      assert.equal(typeof result.body.data.csrfToken, 'string');
      assert.equal(result.body.data.user.email, 'admin');
      const session = await call(await relaxedApp!.getUrl(), 'admin/auth/session');
      assert.equal(session.status, 200);
      assert.ok(session.body);
      assert.equal(session.body.data.user.email, 'admin');
      // 关闭后 userSummary 不该再谎报「需要 MFA」。
      assert.equal(session.body.data.user.mfaRequired, false);
    });

    await t.test('密码错误仍拒绝，关闭 MFA 不等于放开鉴权', async () => {
      const result = await call(await relaxedApp!.getUrl(), 'admin/auth/login', { email: 'admin', password: 'wrong-password' });
      assert.equal(result.status, 401);
    });
  } finally {
    if (relaxedApp) await relaxedApp.close();
    if (app) await app.close();
    await db.$disconnect();
    await cluster.stop();
  }
});
