import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { totp } from '../apps/api/src/identity/crypto.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { testPostgres } from './helpers/postgres.js';

/**
 * 商品级收款渠道约束：烟草商城里「必须先行转账」与「可货到付款」的商品会同时存在。
 *
 * 这里验证四件事：
 * 1. 商品能保存渠道约束，且读回一致；
 * 2. 报价阶段就把可选方式收窄（前端据此渲染，不是先让人选再拒）；
 * 3. 不受支持的方式下单被明确拒绝，不静默降级；
 * 4. 预付订单未收款时发货被拦，写明事由可放行并留痕。
 */
test('product payment channels narrow checkout and gate dispatch until paid', { timeout: 300_000 }, async t => {
  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  const contracts = new IdentityContracts();
  const origin = 'https://shop.example.test';
  const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
    bootstrapToken: randomBytes(32).toString('base64url') };
  const identity = new IdentityService(db, config, contracts.ownerPermissions);
  const owner = { email: 'owner@channels.test', displayName: 'Owner', password: 'A-long-test-password-1', locale: 'en' };
  let app: INestApplication | undefined;
  let base = '';
  const jar = new Map<string, string>();
  let adminCsrf = '';

  const request = async (method: string, path: string, body: unknown, headers: Record<string, string>,
    schema?: string) => {
    const response = await fetch(base + '/api/v1/' + path, { method,
      headers: { 'Content-Type': 'application/json',
        Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0]!; const index = pair.indexOf('=');
      const key = pair.slice(0, index); const token = pair.slice(index + 1);
      if (token) jar.set(key, token); else jar.delete(key);
    }
    const data = response.status === 204 ? null : await response.json();
    if (response.status >= 400) contracts.assert('ErrorEnvelope', data);
    else if (schema && response.status !== 204) contracts.assert(schema, data);
    return { status: response.status, body: data as any, response };
  };
  const admin = (method: string, path: string, body?: unknown, schema = 'SuccessEnvelope',
    headers: Record<string, string> = {}) =>
    request(method, path, body, { Origin: origin, 'X-CSRF-Token': adminCsrf, ...headers }, schema);
  const front = (method: string, path: string, body?: unknown, schema = 'SuccessEnvelope',
    headers: Record<string, string> = {}) =>
    request(method, path, body, { ...(jar.has('ez_cart_csrf') ? { 'X-CSRF-Token': jar.get('ez_cart_csrf')! } : {}), ...headers }, schema);

  const address = { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
    district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };
  const contact = { email: 'buyer@example.com', phone: null, fullName: 'Buyer' };
  const quoteBody = (cartId: string, shippingMethodId: string) => ({ cartId, locale: 'en', marketCode: 'HK', contact,
    shippingAddress: address, shippingMethodId, couponCode: null,
    policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }] });

  let rateId = '';
  /** 允许全部渠道的商品（空数组 = 不限）与「必须先行转账」的商品。 */
  let anyVariantId = '';
  let prepaidVariantId = '';
  let prepaidProductId = '';
  let prepaidVersion = 0;

  try {
    await identity.initialize();
    app = await createApp(identity); await app.listen(0, '127.0.0.1'); base = await app.getUrl();

    const bootstrap = await request('POST', 'admin/auth/bootstrap', owner,
      { Origin: origin, 'X-Bootstrap-Token': config.bootstrapToken! });
    const challengeId = bootstrap.body.data.challengeId as string;
    const enrollment = await request('POST', 'admin/auth/mfa/enrollments', { challengeId }, { Origin: origin });
    const confirmed = await request('POST', 'admin/auth/mfa/enrollments/confirm', { challengeId,
      enrollmentId: enrollment.body.data.enrollmentId,
      code: totp(enrollment.body.data.totpSecret, owner.email).generate() }, { Origin: origin });
    assert.equal(confirmed.status, 200);
    adminCsrf = confirmed.body.data.session.csrfToken;

    await db.storeConfig.create({ data: { id: 1, displayName: 'Channel Store', locales: ['zh-CN', 'zh-HK', 'en'],
      defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
    await db.marketProfile.create({ data: { marketCode: 'HK', enabled: true, reviewStatus: 'approved' } });

    const zone = await admin('POST', 'admin/shipping/zones', { code: 'hk', nameByLocale: { en: 'Hong Kong' },
      countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true });
    assert.equal(zone.status, 201);
    const rate = await admin('POST', 'admin/shipping/rates', { code: 'standard', nameByLocale: { en: 'Standard' },
      zoneIds: [zone.body.data.id], fixedFeeMinor: 3_000, freeAboveMinor: null, currency: 'HKD',
      estimatedMinDays: 1, estimatedMaxDays: 3, codEnabled: true, enabled: true });
    assert.equal(rate.status, 201);
    rateId = rate.body.data.id;

    // 商品 A：不限渠道（默认），用于验证「不配置就是三种都能用」。
    const anyProduct = await db.product.create({ data: { status: 'active', marketCodes: ['HK'],
      translations: { create: [{ locale: 'en', name: 'Any Product', slug: 'any-product' }] } } });
    anyVariantId = (await db.productVariant.create({ data: { productId: anyProduct.id, sku: 'SKU-ANY',
      optionValues: { size: 'M' }, priceMinor: 10_000, currency: 'HKD' } })).id;
    await db.inventoryItem.create({ data: { variantId: anyVariantId, onHand: 20 } });

    // 商品 B：只能先行转账。
    const prepaid = await db.product.create({ data: { status: 'active', marketCodes: ['HK'],
      translations: { create: [{ locale: 'en', name: 'Prepaid Only', slug: 'prepaid-only' }] } } });
    prepaidProductId = prepaid.id;
    prepaidVariantId = (await db.productVariant.create({ data: { productId: prepaid.id, sku: 'SKU-PREPAID',
      optionValues: { size: 'L' }, priceMinor: 12_000, currency: 'HKD' } })).id;
    await db.inventoryItem.create({ data: { variantId: prepaidVariantId, onHand: 20 } });
  } catch (error) {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
    throw error;
  }

  t.after(async () => {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
  });

  await t.test('product stores and returns its allowed payment channels', async () => {
    await db.identityRateLimit.deleteMany();
    const before = await admin('GET', `admin/products/${prepaidProductId}`);
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.data.allowedPaymentChannels, [], '未配置的商品必须读回空数组');
    prepaidVersion = before.body.data.version;

    const patched = await admin('PATCH', `admin/products/${prepaidProductId}`,
      { allowedPaymentChannels: ['manual'] }, 'SuccessEnvelope', { 'If-Match': `"${prepaidVersion}"` });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.deepEqual(patched.body.data.allowedPaymentChannels, ['manual']);

    // 未知渠道不能写进商品：否则结账交集中会出现永远对不上的名字。
    assert.equal((await admin('PATCH', `admin/products/${prepaidProductId}`,
      { allowedPaymentChannels: ['stripe'] }, 'SuccessEnvelope',
      { 'If-Match': `"${patched.body.data.version}"` })).status, 422);
  });

  await t.test('manual transfer must be enabled with a payment instruction', async () => {
    await db.identityRateLimit.deleteMany();
    const list = await admin('GET', 'admin/payment-methods');
    const manual = (list.body.data as { items: any[] }).items
      .find(method => method.providerCode === 'manual_bank_transfer' && method.environment === 'production');
    assert.ok(manual, '缺少转账渠道配置行');
    const patched = await admin('PATCH', 'admin/payment-methods', { providerCode: 'manual_bank_transfer',
      environment: 'production', enabled: true, approvalReference: 'OPS-TEST-001',
      publicConfig: { accountSummary: 'FPS 12345678 / 轉賬後 WhatsApp 我們' } }, 'SuccessEnvelope',
      { 'If-Match': `"${manual.version}"` });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.enabled, true);
  });

  await t.test('unrestricted cart offers both channels; prepaid item removes cash on delivery', async () => {
    await db.identityRateLimit.deleteMany();
    // 购物袋一：只有不限渠道的商品 → 两种方式都在。
    const cartA = await front('POST', 'storefront/cart', undefined, 'SuccessEnvelope');
    assert.equal(cartA.status, 201);
    assert.equal((await front('POST', 'storefront/cart/items', { variantId: anyVariantId, quantity: 1 })).status, 200);
    const quoteA = await front('POST', 'storefront/checkout/quote',
      quoteBody(cartA.body.data.cartId, rateId));
    assert.equal(quoteA.status, 200, JSON.stringify(quoteA.body));
    const codesA = (quoteA.body.data.paymentMethods as { code: string }[]).map(method => method.code).sort();
    assert.deepEqual(codesA, ['cod', 'manual_bank_transfer']);

    // 购物袋二：只有「必须先行转账」的商品 → 货到付款不出现。
    const cartB = await front('POST', 'storefront/cart', undefined, 'SuccessEnvelope');
    assert.equal((await front('POST', 'storefront/cart/items', { variantId: prepaidVariantId, quantity: 1 })).status, 200);
    const quoteB = await front('POST', 'storefront/checkout/quote',
      quoteBody(cartB.body.data.cartId, rateId));
    assert.equal(quoteB.status, 200, JSON.stringify(quoteB.body));
    const methodsB = quoteB.body.data.paymentMethods as { code: string; channel: string; instructions: string | null }[];
    assert.deepEqual(methodsB.map(method => method.code), ['manual_bank_transfer']);
    // 顾客要看到往哪转钱：付款指引必须原样带到结账页。
    assert.match(methodsB[0]!.instructions ?? '', /FPS 12345678/);
  });

  await t.test('ordering a prepaid cart with cash on delivery is refused by code', async () => {
    await db.identityRateLimit.deleteMany();
    const cart = await front('POST', 'storefront/cart', undefined, 'SuccessEnvelope');
    await front('POST', 'storefront/cart/items', { variantId: prepaidVariantId, quantity: 1 });
    const quote = await front('POST', 'storefront/checkout/quote', quoteBody(cart.body.data.cartId, rateId));
    assert.equal(quote.status, 200);

    const rejected = await front('POST', 'storefront/checkout/orders', { quoteId: quote.body.data.quoteId,
      confirmedQuoteVersion: 1, paymentMethodCode: 'cod' }, 'SuccessEnvelope',
    { 'Idempotency-Key': randomUUID() });
    assert.equal(rejected.status, 422);
    // 必须给出可区分的错误码：前端要能解释「这件商品不支持货到付款」，而不是笼统的不可用。
    assert.equal(rejected.body.error.code, 'PAYMENT_METHOD_NOT_ALLOWED_FOR_CART');
  });

  await t.test('prepaid order cannot be dispatched before payment, override is audited', async () => {
    await db.identityRateLimit.deleteMany();
    const cart = await front('POST', 'storefront/cart', undefined, 'SuccessEnvelope');
    await front('POST', 'storefront/cart/items', { variantId: prepaidVariantId, quantity: 1 });
    const quote = await front('POST', 'storefront/checkout/quote', quoteBody(cart.body.data.cartId, rateId));
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    const placed = await front('POST', 'storefront/checkout/orders', { quoteId: quote.body.data.quoteId,
      confirmedQuoteVersion: quote.body.data.version, paymentMethodCode: 'manual_bank_transfer' }, 'SuccessEnvelope',
    { 'Idempotency-Key': randomUUID() });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const orderId = placed.body.data.orderId as string;

    const detail = await admin('GET', `admin/orders/${orderId}`);
    assert.equal(detail.status, 200);
    // 下单即冻结「必须预付」：事后改商品配置不影响历史订单。
    assert.equal(detail.body.data.requiresPrepayment, true);
    assert.equal(detail.body.data.paymentStatus, 'created');

    const shipment = await admin('POST', `admin/orders/${orderId}/shipments`, {
      carrierCode: 'sf', carrierName: 'SF Express', trackingNumber: null, note: null,
      items: detail.body.data.lines.map((line: any) => ({ orderItemId: line.id, quantity: line.quantity })) },
      'SuccessEnvelope', { 'Idempotency-Key': randomUUID() });
    assert.equal(shipment.status, 201, JSON.stringify(shipment.body));
    const shipmentId = shipment.body.data.id as string;

    const blocked = await admin('POST', `admin/shipments/${shipmentId}/dispatch`,
      { dispatchedAt: new Date().toISOString() }, 'SuccessEnvelope',
      { 'If-Match': `"${shipment.body.data.version}"`, 'Idempotency-Key': randomUUID() });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'PAYMENT_REQUIRED_BEFORE_DISPATCH');

    const forced = await admin('POST', `admin/shipments/${shipmentId}/dispatch`,
      { dispatchedAt: new Date().toISOString(), overrideReason: '客戶已WhatsApp轉賬截圖，銀行到賬延遲' },
      'SuccessEnvelope', { 'If-Match': `"${shipment.body.data.version}"`, 'Idempotency-Key': randomUUID() });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));

    const after = await admin('GET', `admin/orders/${orderId}`);
    assert.equal(after.body.data.dispatchOverrideReason, '客戶已WhatsApp轉賬截圖，銀行到賬延遲');
    const audit = await db.auditLog.findFirst({ where: { action: 'order.shipment.dispatch_override' },
      orderBy: { occurredAt: 'desc' } });
    assert.ok(audit, '强制放行必须留下审计记录');
    assert.match(audit.reason ?? '', /WhatsApp/, '事由必须与操作一起留痕');
  });

  await t.test('cash on delivery order still ships without any payment gate', async () => {
    await db.identityRateLimit.deleteMany();
    const cart = await front('POST', 'storefront/cart', undefined, 'SuccessEnvelope');
    await front('POST', 'storefront/cart/items', { variantId: anyVariantId, quantity: 1 });
    const quote = await front('POST', 'storefront/checkout/quote', quoteBody(cart.body.data.cartId, rateId));
    const placed = await front('POST', 'storefront/checkout/orders', { quoteId: quote.body.data.quoteId,
      confirmedQuoteVersion: 1, paymentMethodCode: 'cod' }, 'SuccessEnvelope',
    { 'Idempotency-Key': randomUUID() });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const orderId = placed.body.data.orderId as string;

    const detail = await admin('GET', `admin/orders/${orderId}`);
    assert.equal(detail.body.data.requiresPrepayment, false, '不含预付商品的订单不应被拦截');
    assert.equal(detail.body.data.paymentStatus, 'cod_due');

    const shipment = await admin('POST', `admin/orders/${orderId}/shipments`, {
      carrierCode: 'sf', carrierName: 'SF Express', trackingNumber: null, note: null,
      items: detail.body.data.lines.map((line: any) => ({ orderItemId: line.id, quantity: line.quantity })) },
      'SuccessEnvelope', { 'Idempotency-Key': randomUUID() });
    const dispatched = await admin('POST', `admin/shipments/${shipment.body.data.id}/dispatch`,
      { dispatchedAt: new Date().toISOString() }, 'SuccessEnvelope',
      { 'If-Match': `"${shipment.body.data.version}"`, 'Idempotency-Key': randomUUID() });
    assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));
  });

  await t.test('sandbox site still sees cash on delivery: offline rows ignore environment', async () => {
    await db.identityRateLimit.deleteMany();
    // 线下渠道只播种在 production；以前按站点环境精确匹配，sandbox 站点会查不到 cod 行，
    // 结账页只剩沙箱网关。这条用例锁住「线下渠道与环境无关」这个语义。
    const previous = process.env.PAYMENTS_ENVIRONMENT;
    process.env.PAYMENTS_ENVIRONMENT = 'sandbox';
    try {
      const cart = await front('POST', 'storefront/cart', undefined, 'SuccessEnvelope');
      await front('POST', 'storefront/cart/items', { variantId: anyVariantId, quantity: 1 });
      const quote = await front('POST', 'storefront/checkout/quote', quoteBody(cart.body.data.cartId, rateId));
      assert.equal(quote.status, 200, JSON.stringify(quote.body));
      const codes = (quote.body.data.paymentMethods as { code: string }[]).map(method => method.code);
      assert.ok(codes.includes('cod'), `sandbox 站点也必须能看到货到付款：${codes.join(',') || '(空)'}`);
    } finally {
      if (previous === undefined) delete process.env.PAYMENTS_ENVIRONMENT;
      else process.env.PAYMENTS_ENVIRONMENT = previous;
    }
  });
});
