import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { identityConfig } from '../apps/api/src/identity/config.js';
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
