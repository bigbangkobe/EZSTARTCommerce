import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { canonicalCarrierBody } from '../packages/domain/src/carrier.js';
import { testPostgres } from './helpers/postgres.js';

test('carrier webhooks: signed, idempotent, PII-free and server-authoritative delivery', { timeout: 900_000 }, async () => {
  const secret = 'carrier-test-secret-'.padEnd(48, 'x');
  const previousSecrets = process.env['CARRIER_WEBHOOK_SECRETS'];
  process.env['CARRIER_WEBHOOK_SECRETS'] = JSON.stringify({ sf: secret });
  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  const contracts = new IdentityContracts();
  const origin = 'https://shop.example.test';
  const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
    bootstrapToken: randomBytes(32).toString('base64url') };
  const identity = new IdentityService(db, config, contracts.ownerPermissions);
  let app: INestApplication | undefined;
  let base = '';

  const request = async (method: string, path: string, body: unknown, headers: Record<string, string>) => {
    const response = await fetch(base + '/api/v1/' + path, { method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = response.status === 204 ? null : await response.json();
    if (response.status >= 400) contracts.assert('ErrorEnvelope', data);
    return { status: response.status, body: data as any };
  };
  const resetLimits = () => db.identityRateLimit.deleteMany();

  /** 承运商按 canonical JSON + Unix 秒签名；测试侧与服务端共用同一规范化函数。 */
  const signedHeaders = (body: unknown, opts: { secret?: string; skew?: number; signature?: string } = {}) => {
    const timestamp = String(Math.floor(Date.now() / 1000) + (opts.skew ?? 0));
    const hmac = createHmac('sha256', opts.secret ?? secret)
      .update(`${timestamp}.${canonicalCarrierBody(body)}`).digest('hex');
    return { 'X-Carrier-Timestamp': timestamp, 'X-Carrier-Signature': opts.signature ?? `v1=${hmac}` };
  };
  const callback = (shipmentId: string, status: string, overrides: Record<string, unknown> = {}) => ({
    eventId: randomUUID(), shipmentId, status, occurredAt: new Date().toISOString(), ...overrides,
  });
  const post = (body: unknown, headers: Record<string, string> = {}, carrier = 'sf') =>
    request('POST', `webhooks/carriers/${carrier}`, body, headers);
  const accepted = (body: unknown, headers?: Record<string, string>, carrier = 'sf') =>
    post(body, { ...signedHeaders(body), ...headers }, carrier);

  let variantId = '';
  let rateId = '';
  const contact = { email: 'buyer@example.com', phone: '+85291234567', fullName: 'Buyer' };
  const address = { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
    district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };

  const makeOrder = async (orderStatus = 'shipped') => {
    const quantity = 2;
    const subtotal = 10_000 * quantity;
    const now = new Date();
    const cart = await db.guestCart.create({ data: { tokenDigest: digest(randomBytes(32).toString('hex')),
      status: 'converted', currency: 'HKD', expiresAt: new Date(now.getTime() + 86_400_000) } });
    const quote = await db.checkoutQuote.create({ data: { cartId: cart.id, status: 'consumed', version: 1,
      locale: 'en', marketCode: 'HK', currency: 'HKD', contact, shippingAddress: address, shippingMethodId: rateId,
      shippingMethodSnapshot: { code: 'STANDARD', name: 'Standard', estimatedMinDays: 1, estimatedMaxDays: 3,
        fixedFeeMinor: 3_000, freeAboveMinor: 50_000 },
      subtotalMinor: subtotal, discountMinor: 0, shippingMinor: 3_000, taxMinor: 0, totalMinor: subtotal + 3_000,
      ruleVersions: { price: 'catalog.v1', promotion: 'none', shipping: 'rate:1', tax: null }, warnings: [],
      policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }],
      expiresAt: new Date(now.getTime() + 900_000) } });
    const order = await db.shopOrder.create({ data: { publicOrderNumber: `EZ-20261118-${randomBytes(3).toString('hex').toUpperCase()}`,
      idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()), quoteId: quote.id, cartId: cart.id,
      shippingRateId: rateId, orderStatus, paymentStatus: 'cod_due', currency: 'HKD', subtotalMinor: subtotal,
      discountMinor: 0, shippingMinor: 3_000, taxMinor: 0, totalMinor: subtotal + 3_000, locale: 'en', marketCode: 'HK',
      contact, shippingAddress: address, shippingMethodSnapshot: { code: 'STANDARD', name: 'Standard' },
      paymentMethodCode: 'cod', policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }], placedAt: now } });
    const item = await db.orderItem.create({ data: { orderId: order.id, variantId, sku: 'SKU-1', productName: 'Test Product',
      variantName: 'M', quantity, unitPriceMinor: 10_000, lineSubtotalMinor: subtotal, lineDiscountMinor: 0,
      lineTotalMinor: subtotal } });
    await db.orderStatusEvent.create({ data: { orderId: order.id, fromStatus: null, toStatus: orderStatus,
      reason: 'order_placed', actorType: 'customer' } });
    await db.inventoryItem.update({ where: { variantId }, data: { reserved: { increment: quantity } } });
    await db.inventoryReservation.create({ data: { orderId: order.id, variantId, quantity,
      expiresAt: new Date(now.getTime() + 1_800_000) } });
    return { order, item };
  };

  const makeShipment = async (orderId: string, orderItemId: string, status = 'dispatched', trackingNumber: string | null = null) =>
    db.shipment.create({ data: { orderId, status, carrierCode: 'sf', carrierName: 'SF Express', trackingNumber,
      dispatchedAt: status === 'created' ? null : new Date(), items: { create: [{ orderItemId, quantity: 2 }] } } });

  try {
    await identity.initialize();
    app = await createApp(identity); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    await db.storeConfig.create({ data: { id: 1, displayName: 'Carrier Store', locales: ['zh-CN', 'en'],
      defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
    const zone = await db.shippingZone.create({ data: { code: 'HK', nameByLocale: { en: 'Hong Kong' },
      countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true } });
    rateId = (await db.shippingRate.create({ data: { code: 'STANDARD', nameByLocale: { en: 'Standard' },
      fixedFeeMinor: 3_000, freeAboveMinor: 50_000, currency: 'HKD', estimatedMinDays: 1, estimatedMaxDays: 3,
      codEnabled: true, enabled: true, zones: { create: [{ zoneId: zone.id }] } } })).id;
    const product = await db.product.create({ data: { status: 'active', marketCodes: ['HK'],
      translations: { create: [{ locale: 'en', name: 'Test Product', slug: 'test-product' }] } } });
    variantId = (await db.productVariant.create({ data: { productId: product.id, sku: 'SKU-1',
      optionValues: { size: 'M' }, priceMinor: 10_000, currency: 'HKD' } })).id;
    await db.inventoryItem.create({ data: { variantId, onHand: 20 } });
  } catch (error) {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
    if (previousSecrets === undefined) delete process.env['CARRIER_WEBHOOK_SECRETS'];
    else process.env['CARRIER_WEBHOOK_SECRETS'] = previousSecrets;
    throw error;
  }

  try {
    await resetLimits();
    const { order, item } = await makeOrder();
    const shipment = await makeShipment(order.id, item.id);

    // 1) 未签名 / 错密钥 / 时间窗过期：全部拒绝，不落库。
    const body = callback(shipment.id, 'in_transit');
    assert.equal((await post(body)).status, 401);
    assert.equal((await post(body, signedHeaders(body, { secret: 'y'.repeat(48) }))).status, 401);
    assert.equal((await post(body, signedHeaders(body, { skew: -301 }))).status, 401);
    assert.equal((await post(body, { ...signedHeaders(body), 'X-Carrier-Signature': 'v1=abc' })).status, 401);
    assert.equal(await db.carrierStatusEvent.count(), 0);

    // 契约先于签名：PII 字段在解析阶段就被拒绝。
    const withPii = { ...body, email: 'buyer@example.com' };
    assert.equal((await post(withPii, signedHeaders(withPii))).status, 422);
    assert.equal(await db.carrierStatusEvent.count(), 0);

    // 未登记的承运商没有密钥，先验签失败。
    assert.equal((await accepted(body, undefined, 'unknown-carrier')).status, 404);
    assert.equal(await db.carrierStatusEvent.count(), 0);

    // 2) 正常 in_transit：状态回传落库，订单履约状态不被浏览器/承运商随便推进。
    await resetLimits();
    const transit = await accepted(body);
    assert.equal(transit.status, 202);
    contracts.assert('CarrierWebhookAck', transit.body);
    assert.equal(transit.body.data.received, true);
    assert.equal(transit.body.data.duplicate, false);
    assert.equal((await db.shopOrder.findUniqueOrThrow({ where: { id: order.id } })).orderStatus, 'shipped');
    assert.equal((await db.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).carrierStatus, 'in_transit');
    assert.equal(await db.carrierStatusEvent.count({ where: { eventId: body.eventId } }), 1);

    // 3) 同一 eventId 重放：签名正确也不再写第二条、不重复推进。
    await resetLimits();
    const replay = await accepted(body);
    assert.equal(replay.status, 202);
    assert.equal(replay.body.data.received, false);
    assert.equal(replay.body.data.duplicate, true);
    assert.equal(await db.carrierStatusEvent.count({ where: { eventId: body.eventId } }), 1);

    // 4) 已登记追踪号的包裹不能接受另一个单号的回传。
    await resetLimits();
    const tracked = await makeShipment(order.id, item.id, 'dispatched', 'SF999');
    const mismatch = callback(tracked.id, 'in_transit', { trackingNumber: 'SF000' });
    assert.equal((await accepted(mismatch)).status, 409);
    assert.equal(await db.carrierStatusEvent.count({ where: { shipmentId: tracked.id } }), 0);

    // 5) 未 dispatch 的包裹不能靠 delivered 回调越过库存授权动作。
    await resetLimits();
    const { order: freshOrder, item: freshItem } = await makeOrder('processing');
    const unshipped = await makeShipment(freshOrder.id, freshItem.id, 'created');
    assert.equal((await accepted(callback(unshipped.id, 'delivered'))).status, 409);
    assert.equal((await db.shopOrder.findUniqueOrThrow({ where: { id: freshOrder.id } })).orderStatus, 'processing');

    // 6) delivered 复用履约推进：订单完成、状态事件标记 system，付款状态保持 cod_due。
    await resetLimits();
    const delivered = callback(shipment.id, 'delivered', { note: 'left with concierge' });
    const done = await accepted(delivered);
    assert.equal(done.status, 202);
    assert.equal(done.body.data.shipmentStatus, 'delivered');
    const finalOrder = await db.shopOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(finalOrder.orderStatus, 'completed');
    assert.equal(finalOrder.fulfillmentStatus, 'delivered');
    assert.equal(finalOrder.paymentStatus, 'cod_due');
    const statusEvent = await db.orderStatusEvent.findFirst({ where: { orderId: order.id, toStatus: 'completed' } });
    assert.equal(statusEvent?.actorType, 'system');
    assert.equal(statusEvent?.reason, 'shipment_delivered');
    const stored = await db.carrierStatusEvent.findUniqueOrThrow({ where: { eventId: delivered.eventId } });
    assert.match(stored.signatureRef, /^v1=[0-9a-f]{16}$/);
    assert.equal(stored.note, 'left with concierge');

    // 7) 后台订单详情能读到回传台账（沿用 orders.read 权限，无额外 PII 列）。
    const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: ['orders.read'] } });
    const user = await db.adminUser.create({ data: { email: `u-${randomUUID()}@carrier.test`, displayName: 'Staff',
      passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
    await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
    const token = randomBytes(32).toString('base64url');
    await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
      lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
    const detail = await request('GET', `admin/orders/${order.id}`, undefined, { Cookie: `ez_admin_session=${token}`, Origin: origin });
    assert.equal(detail.status, 200);
    const detailShipment = detail.body.data.shipments.find((entry: any) => entry.id === shipment.id);
    assert.equal(detailShipment.carrierStatus, 'delivered');
    assert.equal(detailShipment.carrierEvents.length, 2);
    assert.ok(detailShipment.carrierEvents.some((entry: any) => entry.eventId === delivered.eventId));
  } finally {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
    if (previousSecrets === undefined) delete process.env['CARRIER_WEBHOOK_SECRETS'];
    else process.env['CARRIER_WEBHOOK_SECRETS'] = previousSecrets;
  }
});
