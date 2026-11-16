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

test('promotions: coupon rules, atomic quota, redemption lifecycle and refund return', { timeout: 900_000 },
  async t => {
  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  const contracts = new IdentityContracts();
  const origin = 'https://shop.example.test';
  const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
    bootstrapToken: randomBytes(32).toString('base64url') };
  const identity = new IdentityService(db, config, contracts.ownerPermissions);
  const jar = new Map<string, string>();
  let app: INestApplication | undefined;
  let base = '';

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
    else if (schema) contracts.assert(schema, data);
    return { status: response.status, body: data as any, response };
  };
  const resetLimits = () => db.identityRateLimit.deleteMany();

  const sessionFor = async (permissions: string[]) => {
    const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
    const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@promotions.test`, displayName: 'Staff',
      passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
    await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
    const token = randomBytes(32).toString('base64url');
    const csrfToken = csrf(token, config);
    await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
      lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
    const call = (method: string, path: string, body?: unknown, schema = 'SuccessEnvelope',
      opts: { key?: string; ifMatch?: string } = {}) =>
      request(method, path, body, { Origin: origin, 'X-CSRF-Token': csrfToken,
        ...(method !== 'GET' ? { 'Idempotency-Key': opts.key ?? randomUUID() } : {}),
        ...(opts.ifMatch ? { 'If-Match': opts.ifMatch } : {}),
        Cookie: `ez_admin_session=${token}` }, schema);
    return { call, userId: user.id };
  };

  const front = (method: string, path: string, body?: unknown, schema = 'SuccessEnvelope',
    headers: Record<string, string> = {}) =>
    request(method, path, body, { ...(jar.has('ez_cart_csrf') ? { 'X-CSRF-Token': jar.get('ez_cart_csrf')! } : {}), ...headers }, schema);

  interface CartSession { id: string; token: string; csrf: string }
  const newCart = async (): Promise<CartSession> => {
    const created = await front('POST', 'storefront/cart', undefined, 'SuccessEnvelope');
    assert.equal(created.status, 201);
    return { id: created.body.data.cartId, token: jar.get('ez_guest_cart')!, csrf: jar.get('ez_cart_csrf')! };
  };
  const cartRequest = (cart: CartSession, method: string, path: string, body: unknown, schema: string,
    headers: Record<string, string> = {}) =>
    request(method, path, body, { Cookie: `ez_guest_cart=${cart.token}; ez_cart_csrf=${cart.csrf}`,
      'X-CSRF-Token': cart.csrf, ...headers }, schema);

  const address = { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
    district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };
  const quoteBody = (cartId: string, couponCode: string | null, email = 'buyer@example.com') =>
    ({ cartId, locale: 'en', marketCode: 'HK', contact: { email, phone: null, fullName: 'Buyer' }, shippingAddress: address,
      shippingMethodId: methodId, couponCode, policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }] });

  let methodId = '';
  let productAId = '';
  let variantA = '';
  let variantB = '';
  let categoryId = '';
  let fixedCouponId = '';

  const couponWrite = (overrides: Record<string, unknown>) => ({
    code: `C-${randomUUID().slice(0, 8)}`, discountType: 'fixed', discountValue: 1_000,
    validFrom: new Date(Date.now() - 86_400_000).toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    minSubtotalMinor: 5_000, totalLimit: 100, perCustomerLimit: 1, eligibleProductIds: [], eligibleCategoryIds: [],
    memberTierIds: [], refundPolicy: 'restore', status: 'active', ...overrides });

  try {
    await identity.initialize();
    app = await createApp(identity); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    await db.storeConfig.create({ data: { id: 1, displayName: 'Promo Store', locales: ['zh-CN', 'zh-HK', 'en'],
      defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
    await db.marketProfile.create({ data: { marketCode: 'HK', enabled: true, reviewStatus: 'approved' } });
    const category = await db.category.create({ data: { enabled: true,
      translations: { create: [{ locale: 'en', name: 'Shirts', slug: 'shirts' }] } } });
    categoryId = category.id;
    const productA = await db.product.create({ data: { status: 'active', marketCodes: ['HK'],
      translations: { create: [{ locale: 'en', name: 'Linen Shirt', slug: 'linen-shirt' }] } } });
    productAId = productA.id;
    variantA = (await db.productVariant.create({ data: { productId: productA.id, sku: 'SKU-A',
      optionValues: { size: 'M' }, priceMinor: 6_000, currency: 'HKD' } })).id;
    const productB = await db.product.create({ data: { status: 'active', marketCodes: ['HK'],
      translations: { create: [{ locale: 'en', name: 'Cotton Tee', slug: 'cotton-tee' }] } } });
    variantB = (await db.productVariant.create({ data: { productId: productB.id, sku: 'SKU-B',
      optionValues: { size: 'L' }, priceMinor: 4_000, currency: 'HKD' } })).id;
    await db.productCategory.create({ data: { productId: productB.id, categoryId } });
    for (const variantId of [variantA, variantB]) await db.inventoryItem.create({ data: { variantId, onHand: 50 } });

    const owner = await sessionFor(contracts.ownerPermissions);
    const zone = await owner.call('POST', 'admin/shipping/zones', { code: 'hk', nameByLocale: { en: 'Hong Kong' },
      countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true }, 'SuccessEnvelope');
    const rate = await owner.call('POST', 'admin/shipping/rates', { code: 'standard',
      nameByLocale: { en: 'Standard' }, zoneIds: [zone.body.data.id], fixedFeeMinor: 3_000, freeAboveMinor: 20_000,
      currency: 'HKD', estimatedMinDays: 1, estimatedMaxDays: 3, codEnabled: true, enabled: true }, 'SuccessEnvelope');
    methodId = rate.body.data.id;
  } catch (error) {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
    throw error;
  }

  try {
    await t.test('coupons are created, versioned, disabled and never silently accepted', async () => {
      await resetLimits();
      const reader = await sessionFor(['coupons.read']);
      const outsider = await sessionFor(['orders.read']);
      const manager = await sessionFor(['coupons.read', 'coupons.manage']);

      assert.equal((await outsider.call('GET', 'admin/coupons')).status, 403);
      assert.equal((await reader.call('POST', 'admin/coupons', couponWrite({}))).status, 403, '只读不能建券');

      const created = await manager.call('POST', 'admin/coupons', couponWrite({ code: ' fixed10 ' }),
        'CouponEnvelope');
      assert.equal(created.status, 201);
      fixedCouponId = created.body.data.id;
      assert.equal(created.body.data.code, 'FIXED10');
      assert.equal(created.body.data.codeMasked, 'FI***10');
      assert.equal(created.body.data.currency, 'HKD', '币种来自店铺基础币种');
      assert.equal(created.body.data.version, 1);
      assert.deepEqual(created.body.data.usage, { reservedCount: 0, redeemedCount: 0, releasedCount: 0,
        expiredCount: 0, returnedCount: 0, usedCount: 0 });
      assert.ok(created.response.headers.get('etag'), '可编辑资源必须带 ETag');

      assert.equal((await manager.call('POST', 'admin/coupons', couponWrite({ code: 'FIXED10' }))).status, 409,
        '码唯一');
      assert.equal((await manager.call('POST', 'admin/coupons', couponWrite({ discountType: 'percent',
        discountValue: 10_001 }))).status, 422);
      assert.equal((await manager.call('POST', 'admin/coupons', couponWrite({ validUntil: new Date(Date.now() - 172_800_000).toISOString() })))
        .status, 422, '结束时间必须晚于开始时间');
      const memberOnly = await manager.call('POST', 'admin/coupons', couponWrite({ memberTierIds: [randomUUID()] }));
      assert.equal(memberOnly.status, 422);
      assert.equal(memberOnly.body.error.code, 'MEMBER_TIERS_UNAVAILABLE', '没有会员目录就不建会员专属券');

      const list = await reader.call('GET', 'admin/coupons?q=fixed', undefined, 'CouponListEnvelope');
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.data.items.map((item: any) => item.code), ['FIXED10']);
      assert.equal((await reader.call('GET', 'admin/coupons?status=bogus')).status, 422);

      // 旧版本改券是冲突，不是覆盖。
      const stale = await manager.call('PATCH', `admin/coupons/${fixedCouponId}`, { discountValue: 2_000 },
        'CouponEnvelope', { ifMatch: '"9"' });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
      const patched = await manager.call('PATCH', `admin/coupons/${fixedCouponId}`, { discountValue: 1_000,
        minSubtotalMinor: 5_000 }, 'CouponEnvelope', { ifMatch: '"1"' });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.data.version, 2);

      const disabled = await manager.call('POST', `admin/coupons/${fixedCouponId}/disable`,
        { reason: 'Campaign ended' }, 'CouponEnvelope');
      assert.equal(disabled.status, 200);
      assert.equal(disabled.body.data.status, 'disabled');
      const again = await manager.call('POST', `admin/coupons/${fixedCouponId}/disable`,
        { reason: 'Campaign ended' }, 'CouponEnvelope');
      assert.equal(again.status, 200);
      assert.equal(again.body.data.version, disabled.body.data.version, '重复停用不再推进版本');

      const reenabled = await manager.call('PATCH', `admin/coupons/${fixedCouponId}`, { status: 'active' },
        'CouponEnvelope', { ifMatch: `"${disabled.body.data.version}"` });
      assert.equal(reenabled.status, 200);
      assert.equal(reenabled.body.data.status, 'active');
    });

    await t.test('a quote applies the coupon, splits it across lines and freezes the rule', async () => {
      await resetLimits();
      const cart = await newCart();
      await cartRequest(cart, 'POST', 'storefront/cart/items', { variantId: variantA, quantity: 1 }, 'SuccessEnvelope');
      await cartRequest(cart, 'POST', 'storefront/cart/items', { variantId: variantB, quantity: 1 }, 'SuccessEnvelope');

      // 报价时把码写成小写带空格，匹配必须靠规范化而不是靠运气。
      const quoted = await cartRequest(cart, 'POST', 'storefront/checkout/quote',
        quoteBody(cart.id, ' fixed10 '), 'QuoteEnvelope');
      assert.equal(quoted.status, 200);
      const quote = quoted.body.data;
      assert.equal(quote.subtotalMinor, 10_000);
      assert.equal(quote.discountMinor, 1_000);
      assert.equal(quote.shippingMinor, 3_000);
      assert.equal(quote.totalMinor, 12_000, '总额 = 商品 − 优惠 + 运费');
      assert.equal(quote.couponSummary.codeMasked, 'FI***10');
      assert.equal(quote.couponSummary.discountMinor, 1_000);
      // 1000 分按 60/40 分摊到 6000/4000 两行，余数为 0。
      assert.deepEqual(quote.lines.map((line: any) => line.lineDiscountMinor).sort(), [400, 600]);
      assert.deepEqual(quote.lines.map((line: any) => line.lineTotalMinor).sort((a: number, b: number) => a - b),
        [3_600, 5_400]);

      const stored = await db.checkoutQuote.findUniqueOrThrow({ where: { id: quote.quoteId } });
      assert.equal(stored.couponId, fixedCouponId);
      assert.equal((stored.couponSnapshot as any).ruleVersion, 4);
      const ruleVersions = stored.ruleVersions as Record<string, string | null>;
      assert.equal(ruleVersions.promotion, `coupon:${fixedCouponId}:v4`);
      assert.deepEqual(stored.warnings, []);

      // 低于最低消费：拒绝，而不是给 0 元优惠。
      const belowMin = await newCart();
      await cartRequest(belowMin, 'POST', 'storefront/cart/items', { variantId: variantB, quantity: 1 }, 'SuccessEnvelope');
      const rejected = await cartRequest(belowMin, 'POST', 'storefront/checkout/quote',
        quoteBody(belowMin.id, 'FIXED10'), 'QuoteEnvelope');
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.error.code, 'COUPON_MIN_SUBTOTAL_NOT_MET');
    });

    await t.test('unknown, expired, not-yet-valid, disabled and out-of-scope coupons fail loudly', async () => {
      await resetLimits();
      const manager = await sessionFor(['coupons.read', 'coupons.manage']);
      const late = await manager.call('POST', 'admin/coupons', couponWrite({ code: 'LATE',
        validFrom: new Date(Date.now() + 86_400_000).toISOString(),
        validUntil: new Date(Date.now() + 172_800_000).toISOString() }), 'CouponEnvelope');
      assert.equal(late.status, 201);
      const expired = await manager.call('POST', 'admin/coupons', couponWrite({ code: 'EXPIRED',
        validFrom: new Date(Date.now() - 172_800_000).toISOString(),
        validUntil: new Date(Date.now() - 86_400_000).toISOString() }), 'CouponEnvelope');
      assert.equal(expired.status, 201);
      const scoped = await manager.call('POST', 'admin/coupons', couponWrite({ code: 'CATONLY',
        eligibleCategoryIds: [categoryId], totalLimit: 50 }), 'CouponEnvelope');
      assert.equal(scoped.status, 201);
      const off = await manager.call('POST', 'admin/coupons', couponWrite({ code: 'OFF', status: 'disabled' }),
        'CouponEnvelope');
      assert.equal(off.status, 201);

      const cart = await newCart();
      await cartRequest(cart, 'POST', 'storefront/cart/items', { variantId: variantA, quantity: 1 }, 'SuccessEnvelope');
      const expect = async (code: string, status: number, reason: string) => {
        const response = await cartRequest(cart, 'POST', 'storefront/checkout/quote',
          quoteBody(cart.id, code), 'QuoteEnvelope');
        assert.equal(response.status, status, `${code} 应返回 ${status}`);
        assert.equal(response.body.error.code, reason);
      };
      await expect('NOPE123', 409, 'COUPON_NOT_FOUND');
      await expect('LATE', 409, 'COUPON_NOT_STARTED');
      await expect('EXPIRED', 409, 'COUPON_EXPIRED');
      await expect('OFF', 409, 'COUPON_DISABLED');
      // CATONLY 只覆盖分类（毛线衫），购物袋里是衬衫：不适用。
      await expect('CATONLY', 409, 'COUPON_NOT_APPLICABLE');
    });

    await t.test('an order reserves one use and cancelling the order releases it', async () => {
      await resetLimits();
      const manager = await sessionFor(['coupons.read', 'coupons.manage']);
      const limited = await manager.call('POST', 'admin/coupons', couponWrite({ code: 'ONCE', totalLimit: 1,
        perCustomerLimit: null, minSubtotalMinor: null }), 'CouponEnvelope');
      assert.equal(limited.status, 201);

      const cart = await newCart();
      await cartRequest(cart, 'POST', 'storefront/cart/items', { variantId: variantA, quantity: 1 }, 'SuccessEnvelope');
      await cartRequest(cart, 'POST', 'storefront/cart/items', { variantId: variantB, quantity: 1 }, 'SuccessEnvelope');
      const quote = (await cartRequest(cart, 'POST', 'storefront/checkout/quote',
        quoteBody(cart.id, 'ONCE'), 'QuoteEnvelope')).body.data;

      const order = await cartRequest(cart, 'POST', 'storefront/checkout/orders',
        { quoteId: quote.quoteId, confirmedQuoteVersion: 1, paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope',
        { 'Idempotency-Key': `promo-order-${randomUUID()}` });
      assert.equal(order.status, 201);

      const redemption = await db.couponRedemption.findUniqueOrThrow({ where: { orderId: order.body.data.orderId } });
      assert.equal(redemption.status, 'reserved');
      assert.equal(redemption.discountMinor, 1_000);
      assert.equal(redemption.expiresAt !== null, true, '预占带过期时间');
      const detail = await manager.call('GET', `admin/coupons/${limited.body.data.id}`, undefined, 'CouponEnvelope');
      assert.equal(detail.body.data.usage.reservedCount, 1);
      assert.equal(detail.body.data.usage.usedCount, 1);

      // 额度用尽后，报价也要立刻拒绝：不能让顾客填完地址才在最后一步失败。
      const second = await newCart();
      await cartRequest(second, 'POST', 'storefront/cart/items', { variantId: variantA, quantity: 1 }, 'SuccessEnvelope');
      const exhausted = await cartRequest(second, 'POST', 'storefront/checkout/quote',
        quoteBody(second.id, 'ONCE'), 'QuoteEnvelope');
      assert.equal(exhausted.status, 409);
      assert.equal(exhausted.body.error.code, 'COUPON_LIMIT_REACHED');

      const canceller = await sessionFor(['orders.cancel', 'orders.read']);
      const cancelled = await canceller.call('POST', `admin/orders/${order.body.data.orderId}/cancel`,
        { reason: 'Customer changed mind', expectedVersion: 1 }, 'SuccessEnvelope');
      assert.equal(cancelled.status, 200);
      const released = await db.couponRedemption.findUniqueOrThrow({ where: { orderId: order.body.data.orderId } });
      assert.equal(released.status, 'released');
      assert.notEqual(released.releasedAt, null);
      const events = await db.couponRedemptionEvent.findMany({ where: { redemptionId: released.id },
        orderBy: { createdAt: 'asc' } });
      assert.deepEqual(events.map(event => `${event.fromStatus ?? 'null'}->${event.toStatus}`), ['null->reserved', 'reserved->released']);

      const again = await manager.call('GET', `admin/coupons/${limited.body.data.id}`, undefined, 'CouponEnvelope');
      assert.equal(again.body.data.usage.usedCount, 0, '释放后额度回到 0');

      // 释放后用同一张券重新下单可以成功。
      const retry = await newCart();
      await cartRequest(retry, 'POST', 'storefront/cart/items', { variantId: variantA, quantity: 1 }, 'SuccessEnvelope');
      const requote = await cartRequest(retry, 'POST', 'storefront/checkout/quote',
        quoteBody(retry.id, 'ONCE'), 'QuoteEnvelope');
      assert.equal(requote.status, 200);
      assert.equal(requote.body.data.discountMinor, 1_000);
    });

    await t.test('the per-customer limit follows the contact, not the cart', async () => {
      await resetLimits();
      const manager = await sessionFor(['coupons.read', 'coupons.manage']);
      const open = await manager.call('POST', 'admin/coupons', couponWrite({ code: 'ONEPER', totalLimit: null,
        perCustomerLimit: 1, minSubtotalMinor: null }), 'CouponEnvelope');
      assert.equal(open.status, 201);

      const cart = await newCart();
      await cartRequest(cart, 'POST', 'storefront/cart/items', { variantId: variantA, quantity: 1 }, 'SuccessEnvelope');
      const quote = (await cartRequest(cart, 'POST', 'storefront/checkout/quote',
        quoteBody(cart.id, 'ONEPER', 'same@example.com'), 'QuoteEnvelope')).body.data;
      assert.equal((await cartRequest(cart, 'POST', 'storefront/checkout/orders',
        { quoteId: quote.quoteId, confirmedQuoteVersion: 1, paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope',
        { 'Idempotency-Key': `promo-once-${randomUUID()}` })).status, 201);

      // 同一邮箱换一个购物袋：仍然被拦住。
      const sibling = await newCart();
      await cartRequest(sibling, 'POST', 'storefront/cart/items', { variantId: variantA, quantity: 1 }, 'SuccessEnvelope');
      const blocked = await cartRequest(sibling, 'POST', 'storefront/checkout/quote',
        quoteBody(sibling.id, 'ONEPER', 'SAME@example.com'), 'QuoteEnvelope');
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error.code, 'COUPON_CUSTOMER_LIMIT_REACHED');

      // 换一个邮箱就能用：限额按顾客，而不是按券的全局次数。
      const other = await newCart();
      await cartRequest(other, 'POST', 'storefront/cart/items', { variantId: variantA, quantity: 1 }, 'SuccessEnvelope');
      const allowed = await cartRequest(other, 'POST', 'storefront/checkout/quote',
        quoteBody(other.id, 'ONEPER', 'other@example.com'), 'QuoteEnvelope');
      assert.equal(allowed.status, 200);
      assert.equal(allowed.body.data.discountMinor, 1_000);
    });

    await t.test('two checkouts cannot spend the last use of a coupon', async () => {
      await resetLimits();
      const manager = await sessionFor(['coupons.read', 'coupons.manage']);
      const last = await manager.call('POST', 'admin/coupons', couponWrite({ code: 'LASTONE', totalLimit: 1,
        perCustomerLimit: null, minSubtotalMinor: null }), 'CouponEnvelope');
      assert.equal(last.status, 201);

      const carts: CartSession[] = [];
      for (const index of [0, 1]) {
        const cart = await newCart();
        await cartRequest(cart, 'POST', 'storefront/cart/items', { variantId: variantA, quantity: 1 }, 'SuccessEnvelope');
        const quoted = await cartRequest(cart, 'POST', 'storefront/checkout/quote',
          quoteBody(cart.id, 'LASTONE', `racer-${index}@example.com`), 'QuoteEnvelope');
        assert.equal(quoted.status, 200);
        carts.push(cart);
      }
      const quoteIds = await db.checkoutQuote.findMany({ where: { couponId: last.body.data.id, status: 'active' },
        orderBy: { createdAt: 'asc' } });
      assert.equal(quoteIds.length, 2);

      // 两个不同的购物袋同时下单：只有一笔能占到额度。
      const results = await Promise.all(quoteIds.map((quote, index) =>
        cartRequest(carts[index]!, 'POST', 'storefront/checkout/orders',
          { quoteId: quote.id, confirmedQuoteVersion: 1, paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope',
          { 'Idempotency-Key': `promo-race-${index}-${randomUUID()}` })));
      const created = results.filter(result => result.status === 201);
      const rejected = results.filter(result => result.status === 409);
      assert.equal(created.length, 1, '限 1 次的券不能被两笔订单同时用掉');
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0]!.body.error.code, 'COUPON_LIMIT_REACHED');
      assert.equal(await db.couponRedemption.count({ where: { couponId: last.body.data.id, status: 'reserved' } }), 1);
      assert.equal(await db.shopOrder.count({ where: { couponId: last.body.data.id } }), 1);
    });

    await t.test('collecting payment redeems it, a rule edit forces a re-quote, a full refund returns quota', async () => {
      await resetLimits();
      const manager = await sessionFor(['coupons.read', 'coupons.manage']);
      const cart = await newCart();
      await cartRequest(cart, 'POST', 'storefront/cart/items', { variantId: variantA, quantity: 1 }, 'SuccessEnvelope');
      await cartRequest(cart, 'POST', 'storefront/cart/items', { variantId: variantB, quantity: 1 }, 'SuccessEnvelope');
      const quote = (await cartRequest(cart, 'POST', 'storefront/checkout/quote',
        quoteBody(cart.id, 'FIXED10'), 'QuoteEnvelope')).body.data;
      const key = `promo-paid-${randomUUID()}`;
      const order = await cartRequest(cart, 'POST', 'storefront/checkout/orders',
        { quoteId: quote.quoteId, confirmedQuoteVersion: 1, paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope',
        { 'Idempotency-Key': key });
      assert.equal(order.status, 201);
      const orderId = order.body.data.orderId as string;
      const orderRow = await db.shopOrder.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.discountMinor, 1_000);
      assert.equal((orderRow.couponSnapshot as any).ruleVersion, 4, '订单快照冻结券版本');

      // 改券不改历史订单：金额与快照都不动。
      const before = await manager.call('GET', `admin/coupons/${fixedCouponId}`, undefined, 'CouponEnvelope');
      await manager.call('PATCH', `admin/coupons/${fixedCouponId}`, { discountValue: 1_500 },
        'CouponEnvelope', { ifMatch: `"${before.body.data.version}"` });
      const untouched = await db.shopOrder.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(untouched.totalMinor, orderRow.totalMinor);
      assert.equal((untouched.couponSnapshot as any).discountMinor, 1_000);
      assert.equal((untouched.couponSnapshot as any).ruleVersion, 4);

      // 旧报价在新规则下不能被沿用。
      const staleCart = await newCart();
      await cartRequest(staleCart, 'POST', 'storefront/cart/items', { variantId: variantA, quantity: 1 }, 'SuccessEnvelope');
      const staleQuote = (await cartRequest(staleCart, 'POST', 'storefront/checkout/quote',
        quoteBody(staleCart.id, 'FIXED10', 'stale@example.com'), 'QuoteEnvelope')).body.data;
      const patched = await manager.call('GET', `admin/coupons/${fixedCouponId}`, undefined, 'CouponEnvelope');
      await manager.call('PATCH', `admin/coupons/${fixedCouponId}`, { discountValue: 1_800 },
        'CouponEnvelope', { ifMatch: `"${patched.body.data.version}"` });
      const staleOrder = await cartRequest(staleCart, 'POST', 'storefront/checkout/orders',
        { quoteId: staleQuote.quoteId, confirmedQuoteVersion: 1, paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope',
        { 'Idempotency-Key': `promo-stale-${randomUUID()}` });
      assert.equal(staleOrder.status, 409);
      assert.equal(staleOrder.body.error.code, 'COUPON_CHANGED');

      // 发货后登记 COD 收款：预占转核销。
      await db.shipment.create({ data: { orderId, status: 'dispatched', dispatchedAt: new Date(), carrierCode: 'SF' } });
      const collector = await sessionFor(['payments.collect', 'orders.read']);
      const collected = await collector.call('POST', `admin/orders/${orderId}/payment-result`,
        { outcome: 'collected', amountMinor: 12_000, occurredAt: new Date().toISOString(), reference: 'COD-1',
          expectedVersion: 1, reason: 'Cash on delivery' }, 'SuccessEnvelope', { ifMatch: '"1"' });
      assert.equal(collected.status, 200);
      const redeemed = await db.couponRedemption.findUniqueOrThrow({ where: { orderId } });
      assert.equal(redeemed.status, 'redeemed');
      assert.notEqual(redeemed.redeemedAt, null);
      assert.equal(redeemed.expiresAt, null, '核销后不再按时间过期');

      // 整单退款：券配置 restore，返还额度但保留原核销记录。
      const payment = await db.payment.findFirstOrThrow({ where: { orderId } });
      const requester = await sessionFor(['refunds.create']);
      const approver = await sessionFor(['refund.approve']);
      const executor = await sessionFor(['refund.execute']);
      const refund = await requester.call('POST', 'admin/refunds', { orderId, paymentId: payment.id, amountMinor: 12_000,
        currency: 'HKD', reason: 'Full refund' }, 'SuccessEnvelope');
      assert.equal(refund.status, 201);
      const refundId = refund.body.data.id as string;
      assert.equal((await approver.call('POST', `admin/refunds/${refundId}/approve`, { reason: 'Approved' },
        'SuccessEnvelope')).status, 200);
      const executed = await executor.call('POST', `admin/refunds/${refundId}/execute`,
        { reason: 'Bank transfer', reference: 'BANK-991' }, 'SuccessEnvelope');
      assert.equal(executed.status, 200);

      const restored = await db.couponQuotaReturn.findUnique({ where: { redemptionId: redeemed.id } });
      assert.ok(restored, '整单退款按 refundPolicy=restore 返还额度');
      const usage = await manager.call('GET', `admin/coupons/${fixedCouponId}`, undefined, 'CouponEnvelope');
      assert.equal(usage.body.data.usage.returnedCount, 1);
      assert.equal(usage.body.data.usage.usedCount, 0, '返还后额度回到 0');
      const stillRedeemed = await db.couponRedemption.findUniqueOrThrow({ where: { orderId } });
      assert.equal(stillRedeemed.status, 'redeemed', '返还不改写原核销记录');
    });

    await t.test('redemption history is permissioned and never exposes contacts', async () => {
      await resetLimits();
      const reader = await sessionFor(['coupons.read']);
      const outsider = await sessionFor(['orders.read']);
      assert.equal((await outsider.call('GET', `admin/coupons/${fixedCouponId}/redemptions`)).status, 403);
      const page = await reader.call('GET', `admin/coupons/${fixedCouponId}/redemptions`, undefined,
        'CouponRedemptionListEnvelope');
      assert.equal(page.status, 200);
      assert.ok(page.body.data.items.length >= 1);
      for (const item of page.body.data.items) {
        if (item.customerRef !== null) assert.equal(item.customerRef.length, 8, '只给不可逆摘要的前 8 位');
        assert.equal('customerKey' in item, false);
        assert.match(item.publicOrderNumber, /^EZ-[0-9]{8}-[A-Z0-9]{6}$/);
      }
      assert.ok(!JSON.stringify(page.body).includes('@example.com'));
      // 不存在的券按 404 处理，而不是空列表。
      assert.equal((await reader.call('GET', `admin/coupons/${randomUUID()}/redemptions`)).status, 404);
    });

    await t.test('batch issuing is refused while there is no member directory', async () => {
      await resetLimits();
      const issuer = await sessionFor(['coupons.issue']);
      const batch = await issuer.call('POST', 'admin/coupon-batches', { couponId: fixedCouponId, channel: 'email' });
      assert.equal(batch.status, 422);
      assert.equal(batch.body.error.code, 'MEMBER_AUDIENCE_UNAVAILABLE');
      const issue = await issuer.call('POST', `admin/coupon-batches/${randomUUID()}/issue`, { confirmedRecipientCount: 0 });
      assert.equal(issue.status, 422);
      assert.equal(issue.body.error.code, 'MEMBER_AUDIENCE_UNAVAILABLE');
    });

    // 兜底断言：子测试没有执行时这里会失败，而不是静默通过。
    assert.ok(await db.coupon.count() >= 6);
    assert.ok(await db.couponRedemption.count() >= 3);
  } finally {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
  }
});
