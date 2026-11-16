import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { totp } from '../apps/api/src/identity/crypto.js';
import { LocalMediaStorage } from '../apps/api/src/media/storage.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { testPostgres } from './helpers/postgres.js';

function png(width: number, height: number, padding = 0): Buffer {
  const bytes = Buffer.alloc(33 + padding, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** fetch 只接受 ArrayBuffer 作为二进制请求体；Buffer 需要显式截取底层区间。 */
function wire(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

test('media upload: short-lived target, signed byte transfer and verified completion', { timeout: 180_000 }, async t => {
  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  const contracts = new IdentityContracts();
  const origin = 'https://shop.example.test';
  const root = await mkdtemp(join(tmpdir(), 'ez-media-'));
  const storage = new LocalMediaStorage({ driver: 'local', root, signingKey: randomBytes(32), basePath: '/api/v1/media' });
  const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
    bootstrapToken: randomBytes(32).toString('base64url') };
  const identity = new IdentityService(db, config, contracts.ownerPermissions);
  const owner = { email: 'owner@media.test', displayName: 'Owner', password: 'A-long-test-password-1', locale: 'en' };
  let app: INestApplication | undefined;
  let base = '';
  const jar = new Map<string, string>();
  let csrf = '';
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}, schema?: string) => {
    const response = await fetch(base + '/api/v1/' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0]!; const index = pair.indexOf('=');
      const key = pair.slice(0, index); const token = pair.slice(index + 1);
      if (token) jar.set(key, token); else jar.delete(key);
    }
    const data = response.status === 204 ? null : await response.json();
    if (response.status >= 400) contracts.assert('ErrorEnvelope', data);
    else if (schema) contracts.assert(schema, data);
    return { status: response.status, body: data, response };
  };
  const write = (path: string, body: unknown) => call(path, body, { 'X-CSRF-Token': csrf }, 'SuccessEnvelope');
  try {
    await identity.initialize();
    app = await createApp(identity, { mediaStorage: storage }); await app.listen(0, '127.0.0.1'); base = await app.getUrl();

    // 与身份模块一致的真实初始化路径：bootstrap → 录入 TOTP → 拿到会话与 CSRF。
    const bootstrap = await call('admin/auth/bootstrap', owner, { 'X-Bootstrap-Token': config.bootstrapToken! });
    assert.equal(bootstrap.status, 202);
    const challengeId = bootstrap.body!.data.challengeId as string;
    const enrollment = await call('admin/auth/mfa/enrollments', { challengeId });
    assert.equal(enrollment.status, 201);
    const confirmed = await call('admin/auth/mfa/enrollments/confirm', { challengeId,
      enrollmentId: enrollment.body!.data.enrollmentId, code: totp(enrollment.body!.data.totpSecret, owner.email).generate() });
    assert.equal(confirmed.status, 200);
    csrf = confirmed.body!.data.session.csrfToken;

    let mediaId = '';
    let objectKey = '';
    let uploadUrl = '';
    const bytes = png(800, 600, 128);
    const digest = createHash('sha256').update(bytes).digest('hex');

    await t.test('upload target is short-lived, server-keyed and recorded as pending', async () => {
      const target = await write('admin/media/upload-target', { fileName: 'front.png', contentType: 'image/png', sizeBytes: bytes.length });
      assert.equal(target.status, 201);
      const data = target.body!.data;
      mediaId = data.mediaId; objectKey = data.objectKey; uploadUrl = data.uploadUrl;
      assert.match(objectKey, /^media\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
      assert.equal(data.method, 'PUT');
      assert.deepEqual(data.headers, { 'Content-Type': 'image/png' });
      assert.ok(uploadUrl.startsWith('/api/v1/media/objects?'));
      assert.ok(new Date(data.expiresAt).getTime() > Date.now());
      const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
      assert.equal(row.status, 'pending'); assert.equal(row.sha256, null);
    });

    await t.test('declared type, extension and size are validated before a target exists', async () => {
      assert.equal((await write('admin/media/upload-target', { fileName: 'x.svg', contentType: 'image/svg+xml', sizeBytes: 10 })).status, 422);
      assert.equal((await write('admin/media/upload-target', { fileName: 'x.gif', contentType: 'image/png', sizeBytes: 10 })).status, 422);
      assert.equal((await write('admin/media/upload-target', { fileName: 'x.png', contentType: 'image/png', sizeBytes: 10 * 1024 * 1024 + 1 })).status, 422);
      assert.equal((await write('admin/media/upload-target', { fileName: 'x.png', contentType: 'image/png', sizeBytes: 10 })).status, 201);
    });

    await t.test('byte transfer requires the signature and cannot be replayed after expiry', async () => {
      const tampered = uploadUrl.replace(/signature=[0-9a-f]/, match => match.slice(0, -1) + (match.endsWith('0') ? '1' : '0'));
      const rejected = await fetch(base + tampered, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: wire(bytes) });
      assert.equal(rejected.status, 403);
      const expired = await fetch(base + uploadUrl.replace(/expires=\d+/, 'expires=1'), { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: wire(bytes) });
      assert.equal(expired.status, 403);
      // 未签名的裸请求同样被拒绝：存储端点不读会话，只认短时签名。
      assert.equal((await fetch(base + '/api/v1/media/objects?key=' + objectKey, { method: 'PUT', body: wire(bytes) })).status, 403);
      assert.equal(await db.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } }).then(row => row.status), 'pending');
    });

    await t.test('a wrong digest or swapped content never completes the upload', async () => {
      const stored = await fetch(base + uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: wire(bytes) });
      assert.equal(stored.status, 204);
      const onDisk = await readFile(join(root, objectKey));
      assert.deepEqual(onDisk, bytes, '写入的字节必须与上传的一致');

      assert.equal((await write('admin/media/complete', { objectKey, sha256: 'f'.repeat(64) })).status, 422);
      assert.equal((await write('admin/media/complete', { objectKey, sha256: 'not-a-digest' })).status, 422);
      assert.equal((await write('admin/media/complete', { objectKey: 'media/2026/11/' + randomUUID() + '.png', sha256: digest })).status, 422);
      assert.equal((await write('admin/media/complete', { objectKey, sha256: digest, sizeBytes: 1 })).status, 422, '未知字段按契约拒绝');
      assert.equal((await db.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } })).status, 'pending');
    });

    await t.test('completion records digest, dimensions and a short-lived read URL', async () => {
      const done = await write('admin/media/complete', { objectKey, sha256: digest.toUpperCase() });
      assert.equal(done.status, 201);
      assert.equal(done.body!.data.status, 'ready');
      assert.equal(done.body!.data.sha256, digest);
      assert.deepEqual([done.body!.data.width, done.body!.data.height], [800, 600]);
      assert.ok(done.body!.data.url?.startsWith('/api/v1/media/objects?'));
      assert.equal((await write('admin/media/complete', { objectKey, sha256: digest })).status, 409, '重复确认必须失败');
      assert.equal((await call('admin/media/' + mediaId, undefined, {}, 'MediaAssetEnvelope')).status, 200);
    });

    await t.test('confirmed media is readable only through a signed URL', async () => {
      const detail = await call('admin/media/' + mediaId, undefined, {}, 'MediaAssetEnvelope');
      const served = await fetch(base + detail.body!.data.url);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'image/png');
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes);
      assert.equal((await fetch(base + '/api/v1/media/objects?key=' + objectKey)).status, 403);
      assert.equal((await call('admin/media?limit=1', undefined, {}, 'MediaAssetListEnvelope')).status, 200);
      assert.equal((await call('admin/media/' + randomUUID())).status, 404);
    });

    await t.test('products and brands may only reference confirmed media of this instance', async () => {
      const brand = await write('admin/brands', { logoMediaId: mediaId,
        translations: [{ locale: 'en', name: 'Media Brand', slug: 'media-brand' }] });
      assert.equal(brand.status, 201);
      assert.equal((await write('admin/brands', { logoMediaId: randomUUID(),
        translations: [{ locale: 'en', name: 'Ghost Brand', slug: 'ghost-brand' }] })).status, 422);
    });

    await t.test('media endpoints require an admin session and the media permission', async () => {
      const saved = jar.get('ez_admin_session')!;
      jar.delete('ez_admin_session');
      assert.equal((await call('admin/media')).status, 401);
      jar.set('ez_admin_session', saved);
      const role = await db.adminRole.create({ data: { name: 'Read only', kind: 'custom', permissionCodes: ['catalog.read'] } });
      const user = await db.adminUser.create({ data: { email: 'reader@media.test', displayName: 'Reader', passwordHash: 'x',
        status: 'active', locale: 'en', mfaRequired: false } });
      await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
      const token = randomBytes(32).toString('base64url');
      await db.adminSession.create({ data: { userId: user.id, tokenDigest: createHash('sha256').update(token).digest('hex'),
        mfaVerified: false, lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
      const response = await fetch(base + '/api/v1/admin/media', { headers: { Cookie: `ez_admin_session=${token}` } });
      assert.equal(response.status, 403, 'catalog.read 不得读取媒体库');
    });
  } finally {
    if (app) await app.close();
    await db.$disconnect();
    await cluster.stop();
    await rm(root, { recursive: true, force: true });
  }
});
