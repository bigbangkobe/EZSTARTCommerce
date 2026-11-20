/**
 * 线上支付端到端：发起支付 → 签名回调 → 入账 → 幂等重放 → 篡改拒绝。
 *
 * 用 mock 适配器跑真实 HTTP + 真实 PostgreSQL，验证的是**编排**而不是适配器本身：
 * 归属校验、状态机推进、金额复核、事件去重、订单状态投影。
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { MockPaymentAdapter } from '../apps/api/src/payments/adapters/mock.js';
import { adapterFor } from '../apps/api/src/payments/adapters/registry.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { testPostgres } from './helpers/postgres.js';

const WEBHOOK_SECRET = 'test_webhook_secret_1234';
const CREDENTIALS = JSON.stringify({ apiKey: 'test_api_key_1234', webhookSecret: WEBHOOK_SECRET });
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('online payments: intent, signed webhook settlement and idempotent replay', { timeout: 300_000 }, async (t) => {
  // createApp 读这三个变量决定线上支付是否可用、用哪套密钥环境、以及 mock 渠道的凭据来源。
  // 站点支付环境必须显式声明 sandbox：默认是 production，而生产禁用 secret://env/。
  process.env.PAYMENTS_ENVIRONMENT = 'sandbox';
  t.after(() => { delete process.env.PAYMENTS_ENVIRONMENT; });
  process.env.PAYMENTS_BASE_URL = 'https://shop.example.test';
  process.env.MOCK_PAYMENT_SECRET = CREDENTIALS;

  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  const contracts = new IdentityContracts();
  const origin = 'https://shop.example.test';
  const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
    bootstrapToken: randomBytes(32).toString('base64url') };
  const identity = new IdentityService(db, config, contracts.ownerPermissions);

  let app: INestApplication | undefined;
  let base = '';

  const cartToken = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const guestHeaders = { Origin: origin, 'X-CSRF-Token': csrfToken,
    Cookie: `ez_guest_cart=${cartToken}; ez_cart_csrf=${csrfToken}` };

  const post = async (path: string, raw: string, headers: Record<string, string>) => {
    const response = await fetch(base + '/api/v1/' + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: raw });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
  };

  try {
    await identity.initialize();
    app = await createApp(identity);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();

    await db.storeConfig.create({ data: { id: 1, displayName: 'Online Store', locales: ['en'],
      defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
    const zone = await db.shippingZone.create({ data: { code: 'HK', nameByLocale: { en: 'Hong Kong' },
      countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true } });
    const rate = await db.shippingRate.create({ data: { code: 'STANDARD', nameByLocale: { en: 'Standard' },
      fixedFeeMinor: 3_000, freeAboveMinor: 50_000, currency: 'HKD', estimatedMinDays: 1, estimatedMaxDays: 3,
      enabled: true, codEnabled: false, zones: { create: [{ zoneId: zone.id }] } } });

    // 购物袋已转化（模拟下单完成）；token 摘要与 CartService.digest 一致。
    const cart = await db.guestCart.create({ data: { tokenDigest: sha256(cartToken), status: 'converted',
      currency: 'HKD', expiresAt: new Date(Date.now() + 86_400_000) } });
    const now = new Date();
    const quote = await db.checkoutQuote.create({ data: { cartId: cart.id, status: 'consumed', version: 1,
      locale: 'en', marketCode: 'HK', currency: 'HKD',
      contact: { email: 'buyer@example.com', phone: '+85291234567', fullName: 'Buyer' },
      shippingAddress: { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
        district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null },
      shippingMethodId: rate.id, shippingMethodSnapshot: { code: 'STANDARD', name: 'Standard' },
      subtotalMinor: 20_000, discountMinor: 0, shippingMinor: 3_000, taxMinor: 0, totalMinor: 23_000,
      ruleVersions: { price: 'catalog.v1', promotion: 'none', shipping: 'rate:1', tax: null }, warnings: [],
      policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }],
      expiresAt: new Date(now.getTime() + 900_000) } });
    const order = await db.shopOrder.create({ data: {
      publicOrderNumber: `EZ-20261120-${randomBytes(3).toString('hex').toUpperCase()}`,
      idempotencyKey: randomUUID(), requestDigest: sha256(randomUUID()), quoteId: quote.id, cartId: cart.id,
      shippingRateId: rate.id, orderStatus: 'awaiting_confirmation', paymentStatus: 'created',
      currency: 'HKD', subtotalMinor: 20_000, discountMinor: 0, shippingMinor: 3_000, taxMinor: 0,
      totalMinor: 23_000, locale: 'en', marketCode: 'HK',
      contact: { email: 'buyer@example.com', phone: '+85291234567', fullName: 'Buyer' },
      shippingAddress: { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
        district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null },
      shippingMethodSnapshot: { code: 'STANDARD', name: 'Standard' },
      paymentMethodCode: 'mock', policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }],
      placedAt: now } });

    const methodConfig = await db.paymentMethodConfig.create({ data: { providerCode: 'mock',
      environment: 'sandbox', displayName: 'Mock gateway', enabled: true, approvalReference: 'test-approval',
      approvedAt: new Date(), publicConfig: { providerAccountRef: 'MOCK-MERCHANT-1',
        checkoutBase: 'https://sandbox.invalid/mock-pay' }, secretRef: 'secret://env/MOCK_PAYMENT_SECRET',
      connectionStatus: 'ok', lastCheckedAt: new Date() } });

    await db.payment.create({ data: { publicPaymentNumber: `PAY-20261120-${randomBytes(3).toString('hex').toUpperCase()}`,
      dedupeKey: `mock:${order.id}`, orderId: order.id, methodConfigId: methodConfig.id, providerCode: 'mock',
      environment: 'sandbox', channel: 'online', status: 'pending', amountMinor: 23_000, currency: 'HKD',
      metadata: { source: 'checkout' } } });

    // ---- 1. 发起支付 --------------------------------------------------------
    const intent = await post(`storefront/checkout/orders/${order.id}/pay`, '{}', guestHeaders);
    assert.equal(intent.status, 200, JSON.stringify(intent.body));
    const data = (intent.body as { data: { redirectUrl: string; providerTransactionId: string } }).data;
    assert.match(data.redirectUrl, /^https:\/\/sandbox\.invalid\/mock-pay\?ref=mock_[0-9a-f]{18}$/);
    assert.match(data.providerTransactionId, /^mock_/);

    const ledger = await db.payment.findUnique({ where: { dedupeKey: `mock:${order.id}` } });
    assert.equal(ledger?.providerTransactionId, data.providerTransactionId);
    // 跳转地址不进台账：它会随查询与导出扩散
    assert.equal((ledger?.metadata as Record<string, unknown>).redirectUrl, undefined);

    // 重复发起必须复用同一笔渠道单，不能再开一笔
    const again = await post(`storefront/checkout/orders/${order.id}/pay`, '{}', guestHeaders);
    assert.equal(again.status, 200);
    assert.equal((again.body as { data: { providerTransactionId: string } }).data.providerTransactionId,
      data.providerTransactionId);

    // ---- 2. 签名回调 --------------------------------------------------------
    const adapter = adapterFor('mock', 'sandbox') as MockPaymentAdapter;
    const eventBody = JSON.stringify({ providerTransactionId: data.providerTransactionId,
      paymentNumber: ledger!.publicPaymentNumber, status: 'succeeded', amountMinor: 23_000, currency: 'HKD',
      eventId: 'evt_1', occurredAt: new Date().toISOString() });
    const signed = adapter.signWebhook(WEBHOOK_SECRET, eventBody);
    const hookHeaders = { Origin: origin, 'x-mock-signature': signed.signature, 'x-mock-timestamp': signed.timestamp };

    const settled = await post('webhooks/payments/mock?env=sandbox', eventBody, hookHeaders);
    assert.equal(settled.status, 202, JSON.stringify(settled.body));
    assert.equal((settled.body as { data: { kind: string } }).data.kind, 'accepted');

    const paid = await db.payment.findUnique({ where: { id: ledger!.id } });
    assert.equal(paid?.status, 'succeeded');
    assert.ok(paid?.paidAt);
    const paidOrder = await db.shopOrder.findUnique({ where: { id: order.id } });
    assert.equal(paidOrder?.paymentStatus, 'succeeded');
    assert.equal(await db.paymentEvent.count({ where: { paymentId: ledger!.id } }), 1);

    // ---- 3. 同一事件重放：202 但不重复入账 ------------------------------------
    const replay = await post('webhooks/payments/mock?env=sandbox', eventBody, hookHeaders);
    assert.equal(replay.status, 202);
    assert.equal((replay.body as { data: { kind: string } }).data.kind, 'duplicate');
    assert.equal(await db.paymentEvent.count({ where: { paymentId: ledger!.id } }), 1);

    // ---- 4. 篡改金额：签名失效，400 且不改任何状态 -----------------------------
    const tampered = JSON.stringify({ providerTransactionId: data.providerTransactionId,
      paymentNumber: ledger!.publicPaymentNumber, status: 'succeeded', amountMinor: 1, currency: 'HKD',
      eventId: 'evt_2', occurredAt: new Date().toISOString() });
    const tamperedRes = await post('webhooks/payments/mock?env=sandbox', tampered, hookHeaders);
    assert.equal(tamperedRes.status, 400);
    assert.equal(await db.paymentEvent.count({ where: { paymentId: ledger!.id } }), 1);
    assert.equal((await db.payment.findUnique({ where: { id: ledger!.id } }))?.status, 'succeeded');

    // ---- 5. 已付订单不能再发起支付 -------------------------------------------
    const afterPaid = await post(`storefront/checkout/orders/${order.id}/pay`, '{}', guestHeaders);
    assert.equal(afterPaid.status, 409);

    // ---- 6. 未知单号回调：202 但不动任何台账（交给对账） ------------------------
    const unknownBody = JSON.stringify({ providerTransactionId: 'mock_ffffffffffffffffffff', status: 'succeeded',
      amountMinor: 23_000, currency: 'HKD', eventId: 'evt_3', occurredAt: new Date().toISOString() });
    const unknownSigned = adapter.signWebhook(WEBHOOK_SECRET, unknownBody);
    const unknown = await post('webhooks/payments/mock?env=sandbox', unknownBody,
      { Origin: origin, 'x-mock-signature': unknownSigned.signature, 'x-mock-timestamp': unknownSigned.timestamp });
    assert.equal(unknown.status, 202);
    assert.equal((unknown.body as { data: { kind: string } }).data.kind, 'deferred');
  } finally {
    await app?.close();
    await db.$disconnect();
    await cluster.stop();
  }
});
