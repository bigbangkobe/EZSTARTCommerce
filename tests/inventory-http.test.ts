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

test('inventory: versioned adjustments, reserved-aware decreases and low-stock thresholds', { timeout: 300_000 },
  async t => {
  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  const contracts = new IdentityContracts();
  const origin = 'https://shop.example.test';
  const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
    bootstrapToken: randomBytes(32).toString('base64url') };
  const identity = new IdentityService(db, config, contracts.ownerPermissions);
  let app: INestApplication | undefined;
  let base = '';

  const request = async (method: string, path: string, body: unknown, headers: Record<string, string>,
    schema?: string) => {
    const response = await fetch(base + '/api/v1/' + path, { method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = response.status === 204 ? null : await response.json();
    if (response.status >= 400) contracts.assert('ErrorEnvelope', data);
    else if (schema && data !== null) contracts.assert(schema, data);
    return { status: response.status, body: data as any };
  };
  const resetLimits = () => db.identityRateLimit.deleteMany();

  const sessionFor = async (permissions: string[]) => {
    const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
    const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@inventory.test`, displayName: 'Staff',
      passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
    await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
    const token = randomBytes(32).toString('base64url');
    const csrfToken = csrf(token, config);
    await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
      lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
    const call = (method: string, path: string, body?: unknown, schema = 'SuccessEnvelope',
      opts: { key?: string } = {}) =>
      request(method, path, body, { Origin: origin, 'X-CSRF-Token': csrfToken,
        ...(method !== 'GET' ? { 'Idempotency-Key': opts.key ?? randomUUID() } : {}),
        Cookie: `ez_admin_session=${token}` }, schema);
    return { call, userId: user.id };
  };

  let variantId = '';
  let secondVariantId = '';

  try {
    await identity.initialize();
    app = await createApp(identity); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    await db.storeConfig.create({ data: { id: 1, displayName: 'Inventory Store', locales: ['zh-CN', 'zh-HK', 'en'],
      defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
    const product = await db.product.create({ data: { status: 'active', marketCodes: ['HK'],
      translations: { create: [{ locale: 'en', name: 'Linen Shirt', slug: 'linen-shirt' }] } } });
    variantId = (await db.productVariant.create({ data: { productId: product.id, sku: 'SKU-1',
      optionValues: { size: 'M' }, priceMinor: 10_000, currency: 'HKD' } })).id;
    // 第二个变体故意不建库存行：列表与调整都要能处理“从未入库”的 SKU。
    secondVariantId = (await db.productVariant.create({ data: { productId: product.id, sku: 'SKU-2',
      optionValues: { size: 'L' }, priceMinor: 10_000, currency: 'HKD' } })).id;
  } catch (error) {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
    throw error;
  }

  try {
    await t.test('stock listing covers never-stocked SKUs and hides nothing', async () => {
      await resetLimits();
      const reader = await sessionFor(['inventory.read']);
      const outsider = await sessionFor(['orders.read']);

      assert.equal((await outsider.call('GET', 'admin/inventory')).status, 403);

      const page = await reader.call('GET', 'admin/inventory', undefined, 'InventoryListEnvelope');
      assert.equal(page.status, 200);
      assert.equal(page.body.data.items.length, 2);
      const first = page.body.data.items.find((item: any) => item.sku === 'SKU-1');
      assert.equal(first.onHand, 0);
      assert.equal(first.reserved, 0);
      assert.equal(first.available, 0);
      assert.equal(first.version, 0, '没有库存行的 SKU 版本为 0');
      assert.equal(first.lowStockState, 'out_of_stock');
      assert.equal(first.productName, 'Linen Shirt');

      // 调整后同一个 SKU 的版本与可售数一起变化。
      const adjuster = await sessionFor(['inventory.read', 'inventory.adjust']);
      const adjusted = await adjuster.call('POST', 'admin/inventory/adjustments', { variantId,
        delta: 10, reason: 'Opening stock', expectedVersion: 0 }, 'InventoryAdjustmentEnvelope');
      assert.equal(adjusted.status, 201);
      assert.equal(adjusted.body.data.onHand, 10);
      assert.equal(adjusted.body.data.version, 1);
      assert.equal(adjusted.body.data.replay, false);
      assert.equal(adjusted.body.data.movement.stockDelta, 10);
      assert.equal(adjusted.body.data.movement.onHandAfter, 10);

      const after = await reader.call('GET', 'admin/inventory?q=SKU-1', undefined, 'InventoryListEnvelope');
      assert.equal(after.body.data.items.length, 1);
      assert.equal(after.body.data.items[0].version, 1);
      assert.equal(after.body.data.items[0].lowStockState, 'ok');
    });

    await t.test('adjustments are versioned, idempotent and never overwrite concurrent writes', async () => {
      await resetLimits();
      const agent = await sessionFor(['inventory.read', 'inventory.adjust']);
      const before = (await db.inventoryItem.findUniqueOrThrow({ where: { variantId } })).version;

      // 旧版本号必须失败，库存不能被静默覆盖。
      const stale = await agent.call('POST', 'admin/inventory/adjustments', { variantId, delta: 1,
        reason: 'Stale write', expectedVersion: before - 1 }, 'InventoryAdjustmentEnvelope');
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
      assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { variantId } })).onHand, 10);

      // 同一幂等键重放返回原流水，不会再记一笔。
      const key = randomUUID();
      const body = { variantId, delta: -2, reason: 'Damaged in storage', expectedVersion: before };
      const first = await agent.call('POST', 'admin/inventory/adjustments', body, 'InventoryAdjustmentEnvelope', { key });
      assert.equal(first.status, 201);
      assert.equal(first.body.data.movement.quantity, 2);
      const replay = await agent.call('POST', 'admin/inventory/adjustments', body, 'InventoryAdjustmentEnvelope', { key });
      assert.equal(replay.status, 201);
      assert.equal(replay.body.data.replay, true);
      assert.equal(replay.body.data.movement.id, first.body.data.movement.id);
      assert.equal(await db.inventoryMovement.count({ where: { variantId, type: 'adjustment' } }), 2);

      // 同一个键换了内容就是冲突，不是重放。
      const conflicting = await agent.call('POST', 'admin/inventory/adjustments',
        { ...body, delta: -3 }, 'InventoryAdjustmentEnvelope', { key });
      assert.equal(conflicting.status, 409);
      assert.equal(conflicting.body.error.code, 'IDEMPOTENCY_CONFLICT');

      // 已预留的 4 件不能被调减吃掉：现存 8、预留 4 时最多只能减 4。
      await db.inventoryItem.update({ where: { variantId }, data: { reserved: 4 } });
      const current = await db.inventoryItem.findUniqueOrThrow({ where: { variantId } });
      const tooMuch = await agent.call('POST', 'admin/inventory/adjustments', { variantId, delta: -5,
        reason: 'Stocktake loss', expectedVersion: current.version }, 'InventoryAdjustmentEnvelope');
      assert.equal(tooMuch.status, 409);
      assert.equal(tooMuch.body.error.code, 'INSUFFICIENT_ON_HAND');
      const exact = await agent.call('POST', 'admin/inventory/adjustments', { variantId, delta: -4,
        reason: 'Stocktake loss', expectedVersion: current.version }, 'InventoryAdjustmentEnvelope');
      assert.equal(exact.status, 201);
      assert.equal(exact.body.data.onHand, 4);
      assert.equal(exact.body.data.available, 0);
      assert.equal(exact.body.data.movement.onHandAfter, 4);
      await db.inventoryItem.update({ where: { variantId }, data: { reserved: 0 } });

      // 数据库自己也拒绝形状不对的调整流水（delta 带符号、quantity 记绝对值）。
      await assert.rejects(() => db.inventoryMovement.create({ data: { variantId, type: 'adjustment',
        quantity: 3, stockDelta: -2, onHandAfter: 1, reason: 'bad shape', dedupeKey: `bad:${randomUUID()}` } }));
    });

    await t.test('thresholds only drive alerts and are versioned through the body', async () => {
      await resetLimits();
      const adjuster = await sessionFor(['inventory.read', 'inventory.adjust']);
      const manager = await sessionFor(['inventory.read', 'inventory.manage']);

      // 只有调整权限不能改阈值。
      assert.equal((await adjuster.call('PATCH', 'admin/inventory/thresholds',
        { variantId, lowStockLevel: 5, expectedVersion: 0 })).status, 403);

      const created = await manager.call('PATCH', 'admin/inventory/thresholds',
        { variantId, lowStockLevel: 5, expectedVersion: 0 }, 'InventoryThresholdEnvelope');
      assert.equal(created.status, 200);
      assert.equal(created.body.data.lowStockLevel, 5);
      assert.equal(created.body.data.version, 1);

      // 旧版本再改一次必须失败。
      const stale = await manager.call('PATCH', 'admin/inventory/thresholds',
        { variantId, lowStockLevel: 9, expectedVersion: 0 }, 'InventoryThresholdEnvelope');
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, 'VERSION_CONFLICT');

      const updated = await manager.call('PATCH', 'admin/inventory/thresholds',
        { variantId, lowStockLevel: 2, expectedVersion: 1 }, 'InventoryThresholdEnvelope');
      assert.equal(updated.status, 200);
      assert.equal(updated.body.data.version, 2);

      // 现存 4、预留 0、阈值 5 → 可售 4 低于阈值；售罄的 SKU-2 阈值按 0 算，同样在提醒范围内。
      const low = await manager.call('GET', 'admin/inventory?lowStock=1', undefined, 'InventoryListEnvelope');
      assert.equal(low.status, 200);
      assert.deepEqual(low.body.data.items.map((item: any) => item.sku), ['SKU-1', 'SKU-2']);
      assert.equal(low.body.data.items[0].lowStockState, 'low');
      assert.equal(low.body.data.items[1].lowStockState, 'out_of_stock');

      const all = await manager.call('GET', 'admin/inventory', undefined, 'InventoryListEnvelope');
      assert.equal(all.body.data.items.length, 2);
      const untouched = all.body.data.items.find((item: any) => item.sku === 'SKU-2');
      assert.equal(untouched.lowStockLevel, 0, '未设置阈值的 SKU 阈值按 0 表示');

      const list = await manager.call('GET', 'admin/inventory/thresholds', undefined, 'InventoryThresholdListEnvelope');
      assert.equal(list.body.data.items.length, 1);
      assert.equal(list.body.data.items[0].variantId, variantId);
    });

    await t.test('movements are append-only and filterable by type, SKU and range', async () => {
      await resetLimits();
      const reader = await sessionFor(['inventory.read']);
      const page = await reader.call('GET', 'admin/inventory/movements?type=adjustment',
        undefined, 'InventoryMovementListEnvelope');
      assert.equal(page.status, 200);
      assert.ok(page.body.data.items.length >= 3);
      assert.ok(page.body.data.items.every((row: any) => row.type === 'adjustment' && row.reason.length > 0));
      assert.equal(page.body.data.hasMore, false);

      const byVariant = await reader.call('GET', `admin/inventory/movements?variantId=${secondVariantId}`,
        undefined, 'InventoryMovementListEnvelope');
      assert.equal(byVariant.body.data.items.length, 0, '没有调整过的 SKU 没有流水');

      assert.equal((await reader.call('GET', 'admin/inventory/movements?type=purchase')).status, 422);
      assert.equal((await reader.call('GET', 'admin/inventory/movements?from=not-a-date')).status, 422);
      assert.equal((await reader.call('GET',
        'admin/inventory/movements?from=2026-11-16T00:00:00.000Z&to=2026-11-15T00:00:00.000Z')).status, 422);
      // 退货入库与人工调整共用一张流水表，类型闭集里都有。
      assert.equal((await reader.call('GET', 'admin/inventory/movements?type=return_restock')).status, 200);
    });

    // 三次成功调整（+10、-2、-4）：重放与被拒的写入都不会多出一行。
    assert.equal(await db.inventoryMovement.count({ where: { type: 'adjustment' } }), 3);
    const audit = await db.auditLog.count({ where: { action: 'inventory.adjust' } });
    assert.equal(audit, 3, '每次调整都留一条审计');
  } finally {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
    await db.$disconnect();
  }
});
