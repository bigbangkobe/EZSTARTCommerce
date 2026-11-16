import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { totp } from '../apps/api/src/identity/crypto.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { testPostgres } from './helpers/postgres.js';

test('checkout: guest cart, immutable quote, idempotent order and stock reservation', { timeout: 300_000 }, async t => {
  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  const contracts = new IdentityContracts();
  const origin = 'https://shop.example.test';
  const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
    bootstrapToken: randomBytes(32).toString('base64url') };
  const identity = new IdentityService(db, config, contracts.ownerPermissions);
  const owner = { email: 'owner@checkout.test', displayName: 'Owner', password: 'A-long-test-password-1', locale: 'en' };
  let app: INestApplication | undefined;
  let base = '';
  const jar = new Map<string, string>();
  let adminCsrf = '';

  const request = async (method: string, path: string, body: unknown, headers: Record<string, string>,
    schema?: string) => {
    const response = await fetch(base + '/api/v1/' + path, { method,
      headers: { 'Content-Type': 'application/json', Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0]!; const index = pair.indexOf('=');
      const key = pair.slice(0, index); const token = pair.slice(index + 1);
      if (token) jar.set(key, token); else jar.delete(key);
    }
    const data = response.status === 204 ? null : await response.json();
    if (response.status >= 400) contracts.assert('ErrorEnvelope', data);
    else if (schema) contracts.assert(schema, data);
    return { status: response.status, body: data as any, response };
  };
  const admin = (method: string, path: string, body?: unknown, schema = 'SuccessEnvelope') =>
    request(method, path, body, { Origin: origin, 'X-CSRF-Token': adminCsrf }, schema);
  /** 游客请求不带 Origin：前台与 API 可能不同源，身份只来自购物袋 cookie + 双提交令牌。 */
  const front = (method: string, path: string, body?: unknown, schema = 'SuccessEnvelope', headers: Record<string, string> = {}) =>
    request(method, path, body, { ...(jar.has('ez_cart_csrf') ? { 'X-CSRF-Token': jar.get('ez_cart_csrf')! } : {}), ...headers }, schema);
  const resetLimits = () => db.identityRateLimit.deleteMany();

  let cart = { id: '', csrf: '', token: '' };
  const newCart = async () => {
    const created = await front('POST', 'storefront/cart', undefined, 'SuccessEnvelope');
    assert.equal(created.status, 201);
    cart = { id: created.body.data.cartId, token: jar.get('ez_guest_cart')!, csrf: jar.get('ez_cart_csrf')! };
    return created;
  };
  const setCart = (value: { token: string; csrf: string }) => { jar.set('ez_guest_cart', value.token); jar.set('ez_cart_csrf', value.csrf); };

  let variantId = '';
  let zoneId = '';
  let methodId = '';
  let draftVariantId = '';

  try {
    await identity.initialize();
    app = await createApp(identity); await app.listen(0, '127.0.0.1'); base = await app.getUrl();

    const bootstrap = await request('POST', 'admin/auth/bootstrap', owner, { Origin: origin, 'X-Bootstrap-Token': config.bootstrapToken! });
    assert.equal(bootstrap.status, 202);
    const challengeId = bootstrap.body.data.challengeId as string;
    const enrollment = await request('POST', 'admin/auth/mfa/enrollments', { challengeId }, { Origin: origin });
    const confirmed = await request('POST', 'admin/auth/mfa/enrollments/confirm', { challengeId,
      enrollmentId: enrollment.body.data.enrollmentId, code: totp(enrollment.body.data.totpSecret, owner.email).generate() }, { Origin: origin });
    assert.equal(confirmed.status, 200);
    adminCsrf = confirmed.body.data.session.csrfToken;

    await db.storeConfig.create({ data: { id: 1, displayName: 'Checkout Store', locales: ['zh-CN', 'zh-HK', 'en'],
      defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
    await db.marketProfile.create({ data: { marketCode: 'HK', enabled: true, reviewStatus: 'approved' } });
    // 未审核通过的市场：可以存在，但不能报价。
    await db.marketProfile.create({ data: { marketCode: 'MO', enabled: true, reviewStatus: 'pending' } });
    const product = await db.product.create({ data: { status: 'active', marketCodes: ['HK'],
      translations: { create: [{ locale: 'en', name: 'Test Product', slug: 'test-product' }] } } });
    const variant = await db.productVariant.create({ data: { productId: product.id, sku: 'SKU-1',
      optionValues: { size: 'M' }, priceMinor: 10_000, currency: 'HKD' } });
    variantId = variant.id;
    await db.inventoryItem.create({ data: { variantId, onHand: 5 } });
    const draft = await db.product.create({ data: { status: 'draft', marketCodes: ['HK'],
      translations: { create: [{ locale: 'en', name: 'Draft Product', slug: 'draft-product' }] } } });
    draftVariantId = (await db.productVariant.create({ data: { productId: draft.id, sku: 'SKU-DRAFT',
      optionValues: {}, priceMinor: 5_000, currency: 'HKD' } })).id;
  } catch (error) {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
    throw error;
  }

  const address = { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
    district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };
  const contact = { email: 'buyer@example.com', phone: null, fullName: 'Buyer' };
  const quoteBody = (cartId: string, method: string) => ({ cartId, locale: 'en', marketCode: 'HK', contact, shippingAddress: address,
    shippingMethodId: method, couponCode: null, policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }] });

  try {
    await t.test('admin configures a shipping zone and rate, refusing overlapping coverage', async () => {
      await resetLimits();
      const zone = await admin('POST', 'admin/shipping/zones', { code: 'hk', nameByLocale: { en: 'Hong Kong' },
        countryCodes: ['hk'], regionCodes: [], priority: 0, enabled: true }, 'SuccessEnvelope');
      assert.equal(zone.status, 201);
      zoneId = zone.body.data.id;
      assert.equal(zone.body.data.code, 'HK');
      assert.deepEqual(zone.body.data.countryCodes, ['HK']);
      assert.equal(zone.body.data.version, 1);
      assert.ok(zone.response.headers.get('etag'), '可编辑资源必须带 ETag');

      assert.equal((await admin('POST', 'admin/shipping/zones', { code: 'HK-2', nameByLocale: { en: 'Duplicate' },
        countryCodes: ['HK'], regionCodes: [], priority: 1, enabled: true })).status, 409);
      assert.equal((await admin('POST', 'admin/shipping/zones', { code: 'BAD CODE', nameByLocale: { en: 'Bad' },
        countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true })).status, 422);
      // 未启用的语言不能出现在名称里，否则前台永远取不到该语言的显示名。
      assert.equal((await admin('POST', 'admin/shipping/zones', { code: 'FR', nameByLocale: { fr: 'France' },
        countryCodes: ['FR'], regionCodes: [], priority: 0, enabled: true })).status, 422);

      const rate = await admin('POST', 'admin/shipping/rates', { code: 'standard', nameByLocale: { en: 'Standard', 'zh-HK': '標準' },
        zoneIds: [zoneId], fixedFeeMinor: 3_000, freeAboveMinor: 20_000, currency: 'HKD', estimatedMinDays: 1,
        estimatedMaxDays: 3, codEnabled: true, enabled: true }, 'SuccessEnvelope');
      assert.equal(rate.status, 201);
      methodId = rate.body.data.id;
      assert.equal(rate.body.data.code, 'STANDARD');
      assert.equal(rate.body.data.fixedFeeMinor, 3_000);
      assert.equal((await admin('POST', 'admin/shipping/rates', { code: 'usd', nameByLocale: { en: 'USD' },
        zoneIds: [zoneId], fixedFeeMinor: 1_000, currency: 'USD', enabled: true })).status, 422);
      assert.equal((await admin('POST', 'admin/shipping/rates', { code: 'ghost', nameByLocale: { en: 'Ghost' },
        zoneIds: [randomUUID()], fixedFeeMinor: 1_000, currency: 'HKD', enabled: true })).status, 422);

      const preview = await admin('POST', 'admin/shipping/quote-preview', { address: { ...address, countryCode: 'hk' },
        merchandiseSubtotalMinor: 10_000, currency: 'HKD' });
      assert.equal(preview.status, 200);
      assert.equal(preview.body.data.methods[0].feeMinor, 3_000);
      assert.equal((await admin('POST', 'admin/shipping/quote-preview', { address: { ...address, countryCode: 'MO' },
        merchandiseSubtotalMinor: 10_000, currency: 'HKD' })).body.data.methods.length, 0);
    });

    await t.test('guest cart only answers to its own cookie and CSRF token', async () => {
      await resetLimits();
      const created = await newCart();
      assert.equal(created.body.data.items.length, 0);
      assert.equal(created.body.data.subtotalMinor, 0);
      const cookies = created.response.headers.getSetCookie();
      assert.equal(cookies.length, 2);
      assert.ok(cookies[0]!.includes('HttpOnly'), '购物袋 token 不能被脚本读取');
      assert.ok(!cookies[1]!.includes('HttpOnly'), 'CSRF 令牌需要被前台脚本读取');
      assert.ok(cookies.every(value => value.includes('Secure') && value.includes('SameSite=Lax')));

      assert.equal((await front('GET', 'storefront/cart')).status, 200);
      const saved = { token: cart.token, csrf: cart.csrf };
      jar.delete('ez_guest_cart'); jar.delete('ez_cart_csrf');
      assert.equal((await request('GET', 'storefront/cart', undefined, {})).status, 401);
      setCart(saved);
      assert.equal((await request('GET', 'storefront/cart', undefined, { Cookie: `ez_guest_cart=${cart.token}` })).status, 200);
      // 没有 CSRF 头、以及令牌不匹配的写入都必须拒绝。
      assert.equal((await request('POST', 'storefront/cart/items', { variantId, quantity: 1 }, {})).status, 403);
      assert.equal((await request('POST', 'storefront/cart/items', { variantId, quantity: 1 },
        { 'X-CSRF-Token': 'A'.repeat(43) })).status, 403);
    });

    await t.test('cart rejects unsellable variants, bad quantities and client prices', async () => {
      await resetLimits();
      assert.equal((await front('POST', 'storefront/cart/items', { variantId, quantity: 0 })).status, 422);
      assert.equal((await front('POST', 'storefront/cart/items', { variantId, quantity: 100 })).status, 422);
      assert.equal((await front('POST', 'storefront/cart/items', { variantId, quantity: 6 })).status, 422);
      assert.equal((await front('POST', 'storefront/cart/items', { variantId: randomUUID(), quantity: 1 })).status, 422);
      assert.equal((await front('POST', 'storefront/cart/items', { variantId: draftVariantId, quantity: 1 })).status, 422);
      // 契约 additionalProperties:false：客户端递过来的价格字段一律 422，不静默忽略。
      assert.equal((await front('POST', 'storefront/cart/items', { variantId, quantity: 1, priceMinor: 1 })).status, 422);
      const added = await front('POST', 'storefront/cart/items', { variantId, quantity: 2 });
      assert.equal(added.status, 200);
      assert.equal(added.body.data.items[0].quantity, 2);
      assert.equal(added.body.data.subtotalMinor, 20_000);
      assert.equal(added.body.data.items[0].unitPriceMinor, 10_000);
    });

    await t.test('lines are updated in place and cannot be edited from another cart', async () => {
      await resetLimits();
      const first = { id: cart.id, token: cart.token, csrf: cart.csrf };
      const lineId = (await front('GET', 'storefront/cart')).body.data.items[0].id as string;
      assert.equal((await front('PATCH', `storefront/cart/items/${lineId}`, { quantity: 5 })).body.data.items[0].quantity, 5);
      assert.equal((await front('PATCH', `storefront/cart/items/${lineId}`, { quantity: 6 })).status, 409);
      assert.equal((await front('PATCH', `storefront/cart/items/${lineId}`, { quantity: 0 })).status, 422);

      await newCart();
      const foreign = await front('POST', 'storefront/cart/items', { variantId, quantity: 1 });
      assert.equal(foreign.status, 200);
      const foreignLine = foreign.body.data.items[0].id as string;
      const second = { id: cart.id, token: cart.token, csrf: cart.csrf };

      setCart(first);
      assert.equal((await front('DELETE', `storefront/cart/items/${foreignLine}`)).status, 404, '别的购物袋的行按不存在处理');
      setCart(second);
      assert.equal((await front('DELETE', `storefront/cart/items/${foreignLine}`)).status, 204);
      assert.equal((await front('GET', 'storefront/cart')).body.data.items.length, 0);

      // 回到第一袋，恢复数量 1，供后续报价使用。
      setCart(first); cart = first;
      assert.equal((await front('PATCH', `storefront/cart/items/${lineId}`, { quantity: 1 })).status, 200);
    });

    await t.test('quote freezes an immutable snapshot and refuses unavailable markets', async () => {
      await resetLimits();
      const unavailable = await front('POST', 'storefront/checkout/quote', { ...quoteBody(cart.id, methodId), marketCode: 'MO' });
      assert.equal(unavailable.status, 409);
      assert.equal(unavailable.body.error.code, 'MARKET_NOT_AVAILABLE');
      assert.equal((await front('POST', 'storefront/checkout/quote', { ...quoteBody(cart.id, methodId),
        shippingMethodId: randomUUID() })).status, 422);
      assert.equal((await front('POST', 'storefront/checkout/quote', { ...quoteBody(cart.id, methodId),
        contact: { email: null, phone: '  ', fullName: null } })).status, 422);
      // 不属于当前购物袋的 cartId 不能借来报价。
      assert.equal((await front('POST', 'storefront/checkout/quote', quoteBody(randomUUID(), methodId))).status, 422);

      const quoted = await front('POST', 'storefront/checkout/quote', { ...quoteBody(cart.id, methodId), couponCode: ' save10 ' },
        'QuoteEnvelope');
      assert.equal(quoted.status, 200);
      const quote = quoted.body.data;
      assert.equal(quote.version, 1);
      assert.equal(quote.subtotalMinor, 10_000);
      assert.equal(quote.shippingMinor, 3_000, '未达免邮线时按固定运费');
      assert.equal(quote.totalMinor, 13_000);
      assert.equal(quote.discountMinor, 0);
      assert.deepEqual(quote.warnings, ['COUPON_NOT_APPLIED']);
      assert.deepEqual(quote.ruleVersions, { price: 'catalog.v1', promotion: 'none', shipping: 'rate:1', tax: null });
      assert.equal(quote.shippingMethod.code, 'STANDARD');
      assert.ok(new Date(quote.expiresAt).getTime() > Date.now());
      // 报价响应不回显联系方式：快照留在服务端，响应只给顾客自己的行与金额。
      assert.ok(!JSON.stringify(quoted.body).includes('buyer@example.com'));

      const repeated = await front('POST', 'storefront/checkout/quote', quoteBody(cart.id, methodId), 'QuoteEnvelope');
      assert.equal(repeated.body.data.shippingMinor, 3_000);
      // 新的报价让旧报价失效，避免顾客同时持有两份有效价格。
      assert.equal(await db.checkoutQuote.count({ where: { cartId: cart.id, status: 'active' } }), 1);
      assert.equal(await db.checkoutQuote.count({ where: { cartId: cart.id, status: 'superseded' } }), 1);
    });

    let quoteId = '';
    let orderId = '';
    let orderNumber = '';
    await t.test('order creation is idempotent, consumes the quote and reserves stock', async () => {
      await resetLimits();
      quoteId = (await db.checkoutQuote.findFirstOrThrow({ where: { cartId: cart.id, status: 'active' } })).id;
      assert.equal((await front('POST', 'storefront/checkout/orders', { quoteId, confirmedQuoteVersion: 1,
        paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope', { 'Idempotency-Key': 'short' })).status, 422);
      // 客户端金额字段不能被接受：下单只认 quoteId 与确认版本。
      assert.equal((await front('POST', 'storefront/checkout/orders', { quoteId, confirmedQuoteVersion: 1,
        paymentMethodCode: 'cod', totalMinor: 1 }, 'OrderCreatedEnvelope', { 'Idempotency-Key': 'checkout-price-field-0001' })).status, 422);
      assert.equal((await front('POST', 'storefront/checkout/orders', { quoteId, confirmedQuoteVersion: 1,
        paymentMethodCode: 'card' }, 'OrderCreatedEnvelope', { 'Idempotency-Key': 'checkout-card-method-0001' })).status, 422);

      const key = 'checkout-idempotency-0001';
      const created = await front('POST', 'storefront/checkout/orders', { quoteId, confirmedQuoteVersion: 1,
        paymentMethodCode: 'cod', customerNote: 'Call before delivery' }, 'OrderCreatedEnvelope', { 'Idempotency-Key': key });
      assert.equal(created.status, 201);
      orderId = created.body.data.orderId;
      orderNumber = created.body.data.publicOrderNumber;
      assert.match(orderNumber, /^EZ-[0-9]{8}-[A-Z0-9]{6}$/);
      assert.equal(created.body.data.orderStatus, 'awaiting_confirmation');
      assert.equal(created.body.data.paymentStatus, 'cod_due');
      assert.equal(created.body.data.totalMinor, 13_000);
      assert.equal(created.body.data.paymentAction.type, 'instructions');

      const order = await db.shopOrder.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.quoteId, quoteId);
      assert.equal(await db.inventoryReservation.count({ where: { orderId, status: 'active' } }), 1);
      assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { variantId } })).reserved, 1);
      assert.equal((await db.checkoutQuote.findUniqueOrThrow({ where: { id: quoteId } })).status, 'consumed');
      assert.equal((await db.guestCart.findUniqueOrThrow({ where: { id: cart.id } })).status, 'converted');
      assert.equal(await db.orderItem.count({ where: { orderId } }), 1);

      const replay = await front('POST', 'storefront/checkout/orders', { quoteId, confirmedQuoteVersion: 1,
        paymentMethodCode: 'cod', customerNote: 'Call before delivery' }, 'OrderCreatedEnvelope', { 'Idempotency-Key': key });
      assert.equal(replay.status, 201);
      assert.equal(replay.body.data.orderId, orderId);
      assert.equal(await db.shopOrder.count(), 1, '同一幂等键不得重复建单');
      assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { variantId } })).reserved, 1);

      const conflict = await front('POST', 'storefront/checkout/orders', { quoteId, confirmedQuoteVersion: 1,
        paymentMethodCode: 'cod', customerNote: 'Different note' }, 'OrderCreatedEnvelope', { 'Idempotency-Key': key });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
    });

    await t.test('a consumed quote cannot produce a second order', async () => {
      await resetLimits();
      // 购物袋已转换，新的下单请求不能复用；先换一个新袋，再尝试用旧报价下单。
      await newCart();
      const attempt = await front('POST', 'storefront/checkout/orders', { quoteId, confirmedQuoteVersion: 1,
        paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope', { 'Idempotency-Key': 'checkout-second-order-0001' });
      assert.equal(attempt.status, 422);
      assert.equal(await db.shopOrder.count(), 1);
    });

    await t.test('order re-validates price, stock and quote expiry', async () => {
      await resetLimits();
      // 价格变化：报价后改价必须让旧报价失效，而不是按旧价成交。
      await newCart();
      await front('POST', 'storefront/cart/items', { variantId, quantity: 1 });
      const firstQuote = (await front('POST', 'storefront/checkout/quote', quoteBody(cart.id, methodId), 'QuoteEnvelope')).body.data;
      await db.productVariant.update({ where: { id: variantId }, data: { priceMinor: 11_000 } });
      const priced = await front('POST', 'storefront/checkout/orders', { quoteId: firstQuote.quoteId, confirmedQuoteVersion: 1,
        paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope', { 'Idempotency-Key': 'checkout-price-change-0001' });
      assert.equal(priced.status, 409);
      assert.equal(priced.body.error.code, 'PRICE_CHANGED');
      await db.productVariant.update({ where: { id: variantId }, data: { priceMinor: 10_000 } });

      // 报价过期：过期快照不能下单。
      const secondQuote = (await front('POST', 'storefront/checkout/quote', quoteBody(cart.id, methodId), 'QuoteEnvelope')).body.data;
      await db.checkoutQuote.update({ where: { id: secondQuote.quoteId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
      const expired = await front('POST', 'storefront/checkout/orders', { quoteId: secondQuote.quoteId, confirmedQuoteVersion: 1,
        paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope', { 'Idempotency-Key': 'checkout-expired-quote-0001' });
      assert.equal(expired.status, 409);
      assert.equal(expired.body.error.code, 'QUOTE_EXPIRED');

      // 库存被买走：下单必须在事务里扣不到预留就整体回滚。
      const thirdQuote = (await front('POST', 'storefront/checkout/quote', quoteBody(cart.id, methodId), 'QuoteEnvelope')).body.data;
      const before = await db.shopOrder.count();
      await db.inventoryItem.update({ where: { variantId }, data: { onHand: 1 } });
      const oversold = await front('POST', 'storefront/checkout/orders', { quoteId: thirdQuote.quoteId, confirmedQuoteVersion: 1,
        paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope', { 'Idempotency-Key': 'checkout-oversold-0001' });
      assert.equal(oversold.status, 409);
      assert.equal(oversold.body.error.code, 'OUT_OF_STOCK');
      assert.equal(await db.shopOrder.count(), before, '库存不足时不得留下半张订单');
      assert.equal(await db.inventoryReservation.count({ where: { orderId: { not: orderId } } }), 0);
      await db.inventoryItem.update({ where: { variantId }, data: { onHand: 5 } });
    });

    await t.test('rate limiting answers 429 instead of serving a stale quote', async () => {
      await resetLimits();
      await db.identityRateLimit.create({ data: { key: `ip:${digest('127.0.0.1')}`, count: 60, windowStart: new Date() } });
      const limited = await front('POST', 'storefront/checkout/quote', quoteBody(cart.id, methodId));
      assert.equal(limited.status, 429);
      assert.ok(limited.response.headers.get('retry-after'));
      await resetLimits();
    });
    // 兜底断言：若子测试未执行，orderNumber 为空会在这里失败，而不是静默“通过”。
    assert.match(orderNumber, /^EZ-[0-9]{8}-[A-Z0-9]{6}$/);
  } finally {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
  }
});
