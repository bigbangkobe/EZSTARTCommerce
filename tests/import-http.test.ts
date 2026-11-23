import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { csrf } from '../apps/api/src/identity/crypto.js';
import { LocalMediaStorage } from '../apps/api/src/media/storage.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { IMPORT_TARGETS } from '../packages/domain/src/import.js';
import { digest } from '../packages/domain/src/identity.js';
import { testPostgres } from './helpers/postgres.js';

const LOCALES = ['zh-CN', 'zh-HK', 'en'];
const HEADER = [...IMPORT_TARGETS];

/** 32 列一行，列名与交付模板一致；未指定的列留空。 */
const row = (values: Record<string, string>) => IMPORT_TARGETS.map(target => values[target] ?? '');
const quote = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const csv = (rows: string[][]) => [HEADER.map(quote).join(','), ...rows.map(cells => cells.map(quote).join(','))].join('\r\n');

const base = {
  product_key: 'AROMA-001', base_sku: 'AROMA-001', category_path: '香薰', market_codes: 'HK',
  name_zh_HK: '檜木香薰蠟燭', slug_zh_HK: 'hinoki-aroma-candle',
  name_zh_CN: '桧木香薰蜡烛', slug_zh_CN: 'hinoki-aroma-candle',
  name_en: 'Hinoki Aroma Candle', slug_en: 'hinoki-aroma-candle',
  variant_sku: 'AROMA-001-100', option1_name: '容量', option1_value: '100ml',
  price_hkd: '168.00', compare_at_hkd: '220.00', currency: 'HKD', stock_qty: '40',
  variant_status: 'active', publish_now: 'Y',
};

/**
 * 商品批量导入（M05）HTTP 回归：
 * 1. 上传目标只能签出 imports/ 前缀的 CSV 键，且需要 catalog.import；
 * 2. 建任务幂等、预检只读、执行必须回传预检给出的三个值（摘要 / 映射版本 / 有效行数）；
 * 3. 预检报告能区分新建 / 更新 / 跳过 / 拒绝，拒绝行不落库；
 * 4. 同一幂等键重放回放结果而不是 409；
 * 5. 只读账号与缺 CSRF 都被挡在写入口之外。
 *
 * 传输层不在本用例范围：文件按服务端签发的键直接写盘（真实链路由浏览器 PUT 签名 URL 完成）。
 */
test('product import runs create → validate → execute with confirmation and idempotency',
  { timeout: 900_000 }, async () => {
    const cluster = await testPostgres();
    const db = connectDatabase(cluster.url);
    const contracts = new IdentityContracts();
    const origin = 'https://shop.example.test';
    const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
      bootstrapToken: randomBytes(32).toString('base64url') };
    const identity = new IdentityService(db, config, contracts.ownerPermissions);
    const mediaRoot = await mkdtemp(join(tmpdir(), 'ez-import-'));
    const storage = new LocalMediaStorage({ driver: 'local', root: mediaRoot, signingKey: randomBytes(32), basePath: '/api/v1/media' });
    let app: INestApplication | undefined;
    let baseUrl = '';

    const request = async (method: string, path: string, body: unknown, headers: Record<string, string>, schema?: string) => {
      const response = await fetch(baseUrl + '/api/v1/' + path, { method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = response.status === 204 ? null : await response.json();
      if (response.status >= 400) contracts.assert('ErrorEnvelope', data);
      else if (schema) contracts.assert(schema, data);
      return { status: response.status, body: data as any };
    };

    const sessionFor = async (permissions: string[]) => {
      const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
      const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@import.test`, displayName: 'Staff',
        passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
      await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
      const token = randomBytes(32).toString('base64url');
      const tokenCsrf = csrf(token, config);
      await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
        lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
      return (method: string, path: string, body?: unknown,
        opts: { schema?: string; headers?: Record<string, string>; csrf?: boolean } = {}) =>
        request(method, path, body, { Cookie: `ez_admin_session=${token}`, Origin: origin,
          ...(opts.csrf === false ? {} : { 'X-CSRF-Token': tokenCsrf }), ...(opts.headers ?? {}) },
        opts.schema ?? (method === 'DELETE' ? undefined : undefined));
    };

    /** 把文件写到服务端签发的键上：等价于浏览器对签名 URL 的 PUT。 */
    const putFile = async (objectKey: string, text: string) => {
      const path = join(mediaRoot, objectKey);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
      return createHash('sha256').update(text, 'utf8').digest('hex');
    };

    try {
      await identity.initialize();
      app = await createApp(identity, { mediaStorage: storage });
      await app.listen(0, '127.0.0.1'); baseUrl = await app.getUrl();
      await db.storeConfig.create({ data: { id: 1, displayName: 'Import Store', locales: LOCALES,
        defaultLocale: 'zh-HK', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
      await db.marketProfile.create({ data: { marketCode: 'HK', enabled: true, reviewStatus: 'approved', eligibleProductIds: [] } });
      await db.category.create({ data: { position: 0, enabled: true, translations: { create: [
        { locale: 'zh-HK', name: '香薰', slug: 'aroma' }, { locale: 'zh-CN', name: '香薰', slug: 'aroma-cn' },
        { locale: 'en', name: 'Aroma', slug: 'aroma-en' } ] } } });

      const owner = await sessionFor(contracts.ownerPermissions);
      const mapping = Object.fromEntries(HEADER.map(header => [header, header]));
      const content = csv([
        row({ ...base }),
        row({ ...base, variant_sku: 'AROMA-001-200', option1_value: '200ml', price_hkd: '288.00', compare_at_hkd: '', stock_qty: '25' }),
        row({ ...base, product_key: 'CUP-014', base_sku: 'CUP-014', name_zh_HK: '砥部燒茶杯', slug_zh_HK: 'toBe-cup',
          name_zh_CN: '砥部烧茶杯', slug_zh_CN: 'toBe-cup', name_en: 'ToBe Ware Teacup', slug_en: 'toBe-cup',
          variant_sku: 'CUP-014-STD', option1_name: '款式', option1_value: '標準', price_hkd: '128.00',
          compare_at_hkd: '', stock_qty: '12', publish_now: 'N' }),
      ]);

      // 1. 上传目标：只能签出 imports/ 前缀的 CSV。
      const target = await owner('POST', 'admin/import-files', {});
      assert.equal(target.status, 201);
      assert.match(target.body.data.objectKey, /^imports\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.csv$/);
      assert.match(target.body.data.uploadUrl, /signature=/);
      const sha = await putFile(target.body.data.objectKey, content);
      assert.equal(sha.length, 64);

      // 2. 建任务，并验证幂等键重放拿到同一个任务。
      const createBody = { fileObjectKey: target.body.data.objectKey, fileSha256: sha, format: 'csv',
        mode: 'create_or_update_by_sku', commitMode: 'valid_rows', columnMapping: mapping, localeSet: LOCALES };
      const created = await owner('POST', 'admin/import-jobs', createBody,
        { schema: 'ImportJobEnvelope', headers: { 'Idempotency-Key': 'import-batch-1' } });
      assert.equal(created.status, 201);
      assert.equal(created.body.data.status, 'uploaded');
      const jobId = created.body.data.id;
      const replayed = await owner('POST', 'admin/import-jobs', createBody,
        { schema: 'ImportJobEnvelope', headers: { 'Idempotency-Key': 'import-batch-1' } });
      assert.equal(replayed.body.data.id, jobId);

      // 3. 预检：三行全部可新建，且报告给出逐行动作。
      const preview = await owner('POST', `admin/import-jobs/${jobId}/validate`, undefined, { schema: 'ImportPreviewEnvelope' });
      assert.equal(preview.status, 200);
      assert.equal(preview.body.data.totalRows, 3);
      assert.equal(preview.body.data.validRows, 3);
      assert.equal(preview.body.data.invalidRows, 0);
      assert.equal(preview.body.data.newCount, 3);
      assert.ok(preview.body.data.previewRows.every((entry: any) => entry.action === 'create'));
      const confirmed = { confirmedFileSha256: preview.body.data.fileSha256,
        confirmedMappingVersion: preview.body.data.mappingVersion, expectedValidRows: preview.body.data.validRows };

      // 4. 执行前必须证明「就是那份文件」：摘要 / 有效行数不符都拒绝。
      assert.equal((await owner('POST', `admin/import-jobs/${jobId}/execute`,
        { ...confirmed, confirmedFileSha256: 'f'.repeat(64) })).status, 409);
      assert.equal((await owner('POST', `admin/import-jobs/${jobId}/execute`,
        { ...confirmed, expectedValidRows: 99 })).status, 409);

      // 5. 正常执行：两个商品、三个规格，发布标记为 Y 的商品直接可售。
      const executed = await owner('POST', `admin/import-jobs/${jobId}/execute`, confirmed,
        { schema: 'ImportJobEnvelope', headers: { 'Idempotency-Key': 'exec-1' } });
      assert.equal(executed.status, 202);
      assert.equal(executed.body.data.status, 'completed');
      assert.equal(executed.body.data.createdCount, 2);
      assert.equal(executed.body.data.failedCount, 0);
      assert.equal(await db.product.count(), 2);
      assert.equal(await db.productVariant.count(), 3);
      const published = await db.product.findFirst({ where: { status: 'active' }, include: { variants: true } });
      assert.ok(published);
      assert.equal(published?.variants.length, 2);
      assert.equal(await db.productTranslation.count({ where: { locale: 'en' } }), 2);

      // 6. 同一幂等键重放：回放结果，而不是「已完成」的 409。
      const replayExec = await owner('POST', `admin/import-jobs/${jobId}/execute`, confirmed,
        { schema: 'ImportJobEnvelope', headers: { 'Idempotency-Key': 'exec-1' } });
      assert.equal(replayExec.status, 202);
      assert.equal(replayExec.body.data.status, 'completed');
      assert.equal(replayExec.body.data.createdCount, 2);

      // 7. create_only + 已存在的 SKU → 预检全部跳过，执行后商品数不变。
      const second = await owner('POST', 'admin/import-jobs',
        { ...createBody, mode: 'create_only' }, { schema: 'ImportJobEnvelope' });
      const secondPreview = await owner('POST', `admin/import-jobs/${second.body.data.id}/validate`, undefined, { schema: 'ImportPreviewEnvelope' });
      assert.equal(secondPreview.body.data.skipCount, 3);
      assert.equal(secondPreview.body.data.newCount, 0);
      await owner('POST', `admin/import-jobs/${second.body.data.id}/execute`,
        { confirmedFileSha256: secondPreview.body.data.fileSha256, confirmedMappingVersion: secondPreview.body.data.mappingVersion,
          expectedValidRows: secondPreview.body.data.validRows }, { schema: 'ImportJobEnvelope' });
      assert.equal(await db.product.count(), 2);

      // 8. 缺语言的商品被拒，且拒绝行不落库。
      const brokenTarget = await owner('POST', 'admin/import-files', {});
      const broken = csv([row({ ...base, product_key: 'BAD-001', name_en: '', slug_en: '', variant_sku: 'BAD-001-1' })]);
      const brokenSha = await putFile(brokenTarget.body.data.objectKey, broken);
      const brokenJob = await owner('POST', 'admin/import-jobs',
        { ...createBody, fileObjectKey: brokenTarget.body.data.objectKey, fileSha256: brokenSha, mode: 'create_or_update_by_sku' },
        { schema: 'ImportJobEnvelope' });
      const brokenPreview = await owner('POST', `admin/import-jobs/${brokenJob.body.data.id}/validate`, undefined, { schema: 'ImportPreviewEnvelope' });
      assert.equal(brokenPreview.body.data.invalidRows, 1);
      assert.equal(brokenPreview.body.data.previewRows[0].action, 'reject');
      assert.ok(brokenPreview.body.data.previewRows[0].errors.length > 0);
      const before = await db.product.count();
      await owner('POST', `admin/import-jobs/${brokenJob.body.data.id}/execute`,
        { confirmedFileSha256: brokenPreview.body.data.fileSha256, confirmedMappingVersion: brokenPreview.body.data.mappingVersion,
          expectedValidRows: brokenPreview.body.data.validRows }, { schema: 'ImportJobEnvelope' });
      assert.equal(await db.product.count(), before);

      // 9. 错误报告可下载、取消可用、越权与缺 CSRF 被挡。
      const report = await owner('GET', `admin/import-jobs/${brokenJob.body.data.id}/error-report`);
      assert.equal(report.status, 200);
      assert.equal(report.body.data.invalidRows, 1);
      // 已完成的任务不能取消：状态机只在早期状态允许取消。
      assert.equal((await owner('POST', `admin/import-jobs/${brokenJob.body.data.id}/cancel`, { reason: 'test cancel' })).status, 409);

      const reader = await sessionFor(['catalog.read']);
      assert.equal((await reader('GET', `admin/import-jobs/${jobId}`)).status, 403);
      assert.equal((await reader('POST', 'admin/import-jobs', createBody)).status, 403);
      assert.equal((await owner('POST', 'admin/import-jobs', createBody, { csrf: false })).status, 403);
    } finally {
      await app?.close();
      await db.$disconnect();
      await cluster.stop();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  });
