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

/** 邮件自检（M10 批次七C）：入队与看结果分权限，投递本身由 worker 完成，这里只到队列为止。 */
test('mail self-test: queueing and reading the result are separately permissioned', { timeout: 300_000 }, async () => {
  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  const contracts = new IdentityContracts();
  const origin = 'https://shop.example.test';
  const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
    bootstrapToken: randomBytes(32).toString('base64url') };
  const identity = new IdentityService(db, config, contracts.ownerPermissions);
  let app: INestApplication | undefined;

  const request = async (method: string, path: string, body: unknown, headers: Record<string, string>,
    schema?: string) => {
    const response = await fetch(base + '/api/v1/' + path, { method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = response.status === 204 ? null : await response.json();
    if (response.status >= 400) contracts.assert('ErrorEnvelope', data);
    else if (schema && response.status !== 204) contracts.assert(schema, data);
    return { status: response.status, body: data as any, response };
  };

  const sessionFor = async (permissions: string[]) => {
    const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
    const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@mailtest.test`, displayName: 'Staff',
      passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
    await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
    const token = randomBytes(32).toString('base64url');
    await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
      lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
    return (method: string, path: string, body?: unknown, headers: Record<string, string> = {},
      schema = 'SuccessEnvelope') =>
      request(method, path, body, { Origin: origin, 'X-CSRF-Token': csrf(token, config),
        Cookie: `ez_admin_session=${token}`, ...headers }, schema);
  };

  let base = '';
  try {
    await identity.initialize();
    app = await createApp(identity); await app.listen(0, '127.0.0.1'); base = await app.getUrl();

    // 匿名一律 401；能发不等于能看，能看不等于能发。
    assert.equal((await request('GET', 'admin/mail/test', undefined, { Origin: origin })).status, 401);
    assert.equal((await (await sessionFor(['reports.view']))('GET', 'admin/mail/test')).status, 403);
    assert.equal((await (await sessionFor(['notifications.read']))('POST', 'admin/mail/test',
      { recipient: 'reader@example.test' })).status, 403);
    assert.equal((await (await sessionFor(['notifications.manage']))('GET', 'admin/mail/test')).status, 403);

    const operator = await sessionFor(['notifications.read', 'notifications.manage']);
    // 邮箱格式在入队前就挡下：队列里不留垃圾任务。
    assert.equal((await operator('POST', 'admin/mail/test', { recipient: 'not-an-email' })).status, 422);
    // 缺 CSRF 或来源不对的写入在控制器层就被拒。
    assert.equal((await operator('POST', 'admin/mail/test', { recipient: 'ok@example.test' },
      { 'X-CSRF-Token': 'wrong' })).status, 403);
    assert.equal((await request('POST', 'admin/mail/test', { recipient: 'ok@example.test' },
      { Origin: 'https://evil.example.test', 'X-CSRF-Token': 'x' })).status, 403);

    const queued = await operator('POST', 'admin/mail/test', { recipient: 'Owner@Example.Test', locale: 'zh-HK' },
      {}, 'MailTestJobEnvelope');
    assert.equal(queued.status, 202, JSON.stringify(queued.body));
    assert.equal(queued.body.data.status, 'pending');
    assert.ok(queued.body.data.recipientMasked.includes('@example.test'));
    assert.ok(!queued.body.data.recipientMasked.startsWith('owner@'), '明文收件人不得出现在响应里');

    // 列表只回掩码；库里的收件人明文只存在于密文，且 AAD 绑任务行本身。
    const listed = await operator('GET', 'admin/mail/test?limit=10', undefined, {}, 'MailTestJobListEnvelope');
    assert.equal(listed.status, 200);
    const row = listed.body.data.items.find((item: any) => item.id === queued.body.data.id);
    assert.ok(row, '自检任务必须出现在列表里');
    const stored = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: queued.body.data.id } });
    assert.equal(stored.kind, 'admin_mail_test');
    assert.equal(stored.maskedTarget, queued.body.data.recipientMasked);
    assert.ok(stored.encryptedPayload, '投递前密文还在');
    assert.ok(!stored.encryptedPayload!.includes('owner@example.test'), '收件人不得明文落库');

    // 审计：发起自检也留痕。
    const audit = await db.auditLog.findFirst({ where: { action: 'notifications.mail_test.requested',
      objectId: queued.body.data.id } });
    assert.ok(audit, '发起自检必须写审计');

    // 任务 10 分钟有效，超时自动作废（worker 的第一道清扫）。
    assert.ok(new Date(stored.expiresAt).getTime() - Date.now() < 11 * 60_000);
  } finally {
    await app?.close(); await db.$disconnect(); await cluster.stop();
  }
});
