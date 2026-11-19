import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { identityConfig, originAllowed } from '../apps/api/src/identity/config.js';
import { decrypt, encrypt, recoveryCodes } from '../apps/api/src/identity/crypto.js';
import { connectDatabase } from '../packages/database/src/client.js';

test('identity startup requires canonical keys, UUID and an approved secure origin', () => {
  const environment = { INSTANCE_ID: randomUUID(), APP_ORIGIN: 'https://shop.example.test',
    IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('base64'), NODE_ENV: 'production' };
  assert.doesNotThrow(() => identityConfig(environment));
  assert.throws(() => identityConfig({ ...environment, INSTANCE_ID: '-'.repeat(36) }));
  assert.throws(() => identityConfig({ ...environment, IDENTITY_ENCRYPTION_KEY: 'not-a-key' }));
  assert.throws(() => identityConfig({ ...environment, APP_ORIGIN: 'http://localhost' }));
  assert.throws(() => identityConfig({ ...environment, APP_ORIGIN: 'https://shop.example.test/extra' }));
  assert.doesNotThrow(() => identityConfig({ ...environment, APP_ORIGIN: 'http://127.0.0.1:3000', NODE_ENV: 'development' }));
});

test('encrypted TOTP cannot be transplanted to another user, instance or key', () => {
  const config = { instanceId: randomUUID(), allowedOrigin: 'https://shop.example.test', encryptionKey: randomBytes(32) };
  const userId = randomUUID();
  const encrypted = encrypt('test-provisioning-secret', userId, config);
  assert.equal(decrypt(encrypted, userId, config), 'test-provisioning-secret');
  assert.throws(() => decrypt(encrypted, randomUUID(), config));
  assert.throws(() => decrypt(encrypted, userId, { ...config, instanceId: randomUUID() }));
  assert.throws(() => decrypt(encrypted, userId, { ...config, encryptionKey: randomBytes(32) }));
});

test('recovery code generation meets frozen length, count and alphabet', () => {
  const codes = recoveryCodes();
  assert.equal(codes.length, 10); assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every(code => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{20}$/.test(code)));
});

test('database URL cannot override enforced UTC connection options', () => {
  assert.throws(() => connectDatabase('postgresql://unused:unused@127.0.0.1:1/test?options=-c%20timezone%3DAsia%2FShanghai'),
    /connection options are controlled/);
});

test('admin and storefront origins are both accepted while links use the admin origin', () => {
  const environment = { INSTANCE_ID: randomUUID(), APP_ORIGIN: 'https://shop.example.test',
    IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('base64'), NODE_ENV: 'production' };
  // 后台独立域名：写入来源两个都放行，邀请/重设链接必须指向后台（/admin/* 只存在于后台应用）。
  const split = identityConfig({ ...environment, ADMIN_ORIGIN: 'https://admin.shop.example.test' });
  assert.equal(split.allowedOrigin, 'https://admin.shop.example.test');
  assert.equal(split.storefrontOrigin, 'https://shop.example.test');
  assert.equal(originAllowed(split, 'https://admin.shop.example.test'), true);
  assert.equal(originAllowed(split, 'https://shop.example.test'), true);
  assert.equal(originAllowed(split, 'https://evil.example.test'), false);
  assert.equal(originAllowed(split, 'https://admin.shop.example.test.evil.test'), false);
  // 缺失 Origin（同站表单以外、老客户端）一律拒绝，不给「没带就放过」的后门。
  assert.equal(originAllowed(split, undefined), false);
  assert.equal(originAllowed(split, ''), false);
  // 未配置后台域名时两者同源：不能凭空多认一个来源。
  const single = identityConfig(environment);
  assert.equal(single.allowedOrigin, 'https://shop.example.test');
  assert.equal(originAllowed(single, 'https://admin.shop.example.test'), false);
  assert.throws(() => identityConfig({ ...environment, ADMIN_ORIGIN: 'http://admin.shop.example.test' }));
  assert.throws(() => identityConfig({ ...environment, ADMIN_ORIGIN: 'https://admin.shop.example.test/' }));
  assert.doesNotThrow(() => identityConfig({ ...environment, ADMIN_ORIGIN: 'http://admin.localhost:3000',
    NODE_ENV: 'development' }));
});
