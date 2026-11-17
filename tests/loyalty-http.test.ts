import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { csrf, decrypt, totp } from '../apps/api/src/identity/crypto.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { testPostgres } from './helpers/postgres.js';

test('loyalty: tier ladder, idempotent point ledger and order-completion earning', { timeout: 300_000 }, async t => {
  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  const contracts = new IdentityContracts();
  const origin = 'https://shop.example.test';
  const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
    bootstrapToken: randomBytes(32).toString('base64url') };
  const identity = new IdentityService(db, config, contracts.ownerPermissions);
  const owner = { email: 'owner@loyalty.test', displayName: 'Owner', password: 'A-long-test-password-1', locale: 'en' };
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
    else if (schema && response.status !== 204) contracts.assert(schema, data);
    return { status: response.status, body: data as any, response };
  };
  const admin = (method: string, path: string, body?: unknown, schema = 'SuccessEnvelope') =>
    request(method, path, body, { Origin: origin, 'X-CSRF-Token': adminCsrf }, schema);
  const adminIf = (method: string, path: string, body: unknown, ifMatch: string, schema = 'SuccessEnvelope') =>
    request(method, path, body, { Origin: origin, 'X-CSRF-Token': adminCsrf, 'If-Match': ifMatch }, schema);
  const front = (method: string, path: string, body?: unknown, schema = 'SuccessEnvelope',
    headers: Record<string, string> = {}) =>
    request(method, path, body, { ...(jar.has('ez_cart_csrf') ? { 'X-CSRF-Token': jar.get('ez_cart_csrf')! } : {}), ...headers }, schema);
  const resetLimits = () => db.identityRateLimit.deleteMany();

  /** 只有指定权限的员工会话：用来证明接口不是"登录就能改积分"。 */
  const sessionFor = async (permissions: string[]) => {
    const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
    const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@loyalty.test`, displayName: 'Staff',
      passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
    await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
    const token = randomBytes(32).toString('base64url');
    const csrfToken = csrf(token, config);
    await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
      lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
    return (method: string, path: string, body?: unknown, schema = 'SuccessEnvelope',
      headers: Record<string, string> = {}) =>
      request(method, path, body, { Origin: origin, 'X-CSRF-Token': csrfToken,
        Cookie: `ez_admin_session=${token}`, ...headers }, schema);
  };

  let variantId = '';
  let methodId = '';
  let cartId = '';

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

    await db.storeConfig.create({ data: { id: 1, displayName: 'Loyalty Store', locales: ['zh-CN', 'zh-HK', 'en'],
      defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
    await db.marketProfile.create({ data: { marketCode: 'HK', enabled: true, reviewStatus: 'approved' } });
    const product = await db.product.create({ data: { status: 'active', marketCodes: ['HK'],
      translations: { create: [{ locale: 'en', name: 'Loyalty Product', slug: 'loyalty-product' }] } } });
    variantId = (await db.productVariant.create({ data: { productId: product.id, sku: 'SKU-L1',
      optionValues: { size: 'M' }, priceMinor: 10_000, currency: 'HKD' } })).id;
    await db.inventoryItem.create({ data: { variantId, onHand: 10 } });
    const zone = await admin('POST', 'admin/shipping/zones', { code: 'hk', nameByLocale: { en: 'Hong Kong' },
      countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true });
    assert.equal(zone.status, 201);
    methodId = (await admin('POST', 'admin/shipping/rates', { code: 'standard', nameByLocale: { en: 'Standard' },
      zoneIds: [zone.body.data.id], fixedFeeMinor: 3_000, freeAboveMinor: 50_000, currency: 'HKD', estimatedMinDays: 1,
      estimatedMaxDays: 3, codEnabled: true, enabled: true })).body.data.id;
  } catch (error) {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
    throw error;
  }

  const memberEmail = 'loyal@example.com';
  const address = { recipientName: 'Member Buyer', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
    district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };
  const contact = { email: memberEmail, phone: null, fullName: 'Member Buyer' };

  try {
    let customerId = '';
    let memberId = '';
    let tierId = '';

    await t.test('point earning starts disabled and settings are version-guarded', async () => {
      const overview = await admin('GET', 'admin/loyalty');
      assert.equal(overview.status, 200);
      assert.equal(overview.body.data.settings.enabled, false);
      assert.equal(overview.body.data.settings.minorPerPoint, 100);
      assert.equal(overview.body.data.settings.version, 1);
      assert.deepEqual(overview.body.data.tiers, []);

      // 没有 If-Match 的写入不收：乐观并发是硬要求，不是体面的建议。
      assert.equal((await admin('PATCH', 'admin/loyalty/settings', { enabled: true })).status, 422);
      const enabled = await adminIf('PATCH', 'admin/loyalty/settings', { enabled: true, minorPerPoint: 100 }, '"1"');
      assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
      assert.equal(enabled.body.data.enabled, true);
      assert.equal(enabled.body.data.version, 2);
      assert.equal(enabled.response.headers.get('etag'), '"2"');
      // 用旧版本再写一次必须冲突，而不是覆盖别人刚改的值。
      assert.equal((await adminIf('PATCH', 'admin/loyalty/settings', { enabled: false }, '"1"')).status, 409);
    });

    await t.test('the tier ladder rejects duplicate ranks and duplicate codes', async () => {
      const bronze = await admin('POST', 'admin/loyalty/tiers', { code: 'bronze', nameByLocale: { en: 'Bronze', 'zh-HK': '銅級' },
        rank: 1, minLifetimeSpendMinor: 0, benefits: ['Member pricing'], status: 'active' });
      assert.equal(bronze.status, 201, JSON.stringify(bronze.body));
      assert.equal(bronze.body.data.code, 'BRONZE', '编码按大写存储');
      assert.equal(bronze.body.data.version, 1);

      const gold = await admin('POST', 'admin/loyalty/tiers', { code: 'GOLD', nameByLocale: { en: 'Gold' },
        rank: 2, minLifetimeSpendMinor: 20_000, benefits: [], status: 'active' });
      assert.equal(gold.status, 201);
      tierId = gold.body.data.id;

      // rank 与 code 各自唯一：撞了要说清是哪一项，而不是笼统的 409。
      const dupRank = await admin('POST', 'admin/loyalty/tiers', { code: 'SILVER', nameByLocale: { en: 'Silver' },
        rank: 2, minLifetimeSpendMinor: 5_000, benefits: [], status: 'active' });
      assert.equal(dupRank.status, 409);
      assert.equal(dupRank.body.error.code, 'TIER_RANK_TAKEN');
      const dupCode = await admin('POST', 'admin/loyalty/tiers', { code: 'GOLD', nameByLocale: { en: 'Gold again' },
        rank: 3, minLifetimeSpendMinor: 30_000, benefits: [], status: 'active' });
      assert.equal(dupCode.status, 409);
      assert.equal(dupCode.body.error.code, 'TIER_CODE_TAKEN');
      // 契约先挡形状：rank 0 与空补丁都进不了服务层。
      assert.equal((await admin('POST', 'admin/loyalty/tiers', { code: 'ODD', nameByLocale: { en: 'Odd' },
        rank: 0, minLifetimeSpendMinor: 0, benefits: [], status: 'active' })).status, 422);
      assert.equal((await adminIf('PATCH', `admin/loyalty/tiers/${tierId}`, {}, '"1"')).status, 422);
    });

    await t.test('a member can only be assigned a tier that exists and is active', async () => {
      const customer = await admin('POST', 'admin/customers', { displayName: 'Loyal Member', email: memberEmail });
      assert.equal(customer.status, 201, JSON.stringify(customer.body));
      customerId = customer.body.data.id;

      const member = await admin('POST', 'admin/members', { customerId, consentRef: 'consent-loyalty-1' });
      assert.equal(member.status, 201, JSON.stringify(member.body));
      memberId = member.body.data.id;
      assert.equal(member.body.data.tier, null);
      assert.equal(member.body.data.lifetimeSpendMinor, 0);

      // 未知等级不能悄悄存成 null。
      const unknown = await admin('POST', 'admin/members', { customerId, consentRef: 'consent-loyalty-2',
        tierId: randomUUID() });
      assert.equal(unknown.status, 409, '同一顾客只能有一个会员档案');
      const otherCustomer = await admin('POST', 'admin/customers', { displayName: 'Other Member', email: 'other@example.com' });
      const badTier = await admin('POST', 'admin/members', { customerId: otherCustomer.body.data.id,
        consentRef: 'consent-loyalty-3', tierId: randomUUID() });
      assert.equal(badTier.status, 422);
      assert.equal(badTier.body.error.code, 'MEMBER_TIER_UNKNOWN');
    });

    await t.test('manual adjustments are idempotent and cannot go negative', async () => {
      const key = 'loyalty-adjust-0001';
      const grant = await request('POST', `admin/members/${memberId}/points-adjustments`,
        { deltaPoints: 500, reasonCode: 'goodwill', reason: 'Apology for a late delivery' },
        { Origin: origin, 'X-CSRF-Token': adminCsrf, 'Idempotency-Key': key });
      assert.equal(grant.status, 201, JSON.stringify(grant.body));
      assert.equal(grant.body.data.deltaPoints, 500);
      assert.equal(grant.body.data.balanceAfter, 500);
      assert.equal(grant.body.data.entryType, 'adjust');

      // 重试同一笔：返回同一条流水，而不是再加 500。
      const replay = await request('POST', `admin/members/${memberId}/points-adjustments`,
        { deltaPoints: 500, reasonCode: 'goodwill', reason: 'Apology for a late delivery' },
        { Origin: origin, 'X-CSRF-Token': adminCsrf, 'Idempotency-Key': key });
      assert.equal(replay.status, 201);
      assert.equal(replay.body.data.id, grant.body.data.id);
      assert.equal(await db.pointLedger.count({ where: { memberId } }), 1);

      // 同一个键配不同金额 = 调用方用错了键，必须报错而不是按旧结果"成功"。
      const reused = await request('POST', `admin/members/${memberId}/points-adjustments`,
        { deltaPoints: 900, reasonCode: 'goodwill', reason: 'Different amount' },
        { Origin: origin, 'X-CSRF-Token': adminCsrf, 'Idempotency-Key': key });
      assert.equal(reused.status, 409);
      assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

      // 扣到负数直接拒绝，余额保持原样。
      const overdraw = await request('POST', `admin/members/${memberId}/points-adjustments`,
        { deltaPoints: -600, reasonCode: 'correction', reason: 'Reverse an incorrect grant' },
        { Origin: origin, 'X-CSRF-Token': adminCsrf, 'Idempotency-Key': 'loyalty-adjust-0002' });
      assert.equal(overdraw.status, 409);
      assert.equal(overdraw.body.error.code, 'POINT_BALANCE_INSUFFICIENT');
      assert.equal((await db.pointAccount.findUniqueOrThrow({ where: { memberId } })).balance, 500);

      const deduct = await request('POST', `admin/members/${memberId}/points-adjustments`,
        { deltaPoints: -200, reasonCode: 'correction', reason: 'Partial reversal' },
        { Origin: origin, 'X-CSRF-Token': adminCsrf, 'Idempotency-Key': 'loyalty-adjust-0003' });
      assert.equal(deduct.status, 201);
      assert.equal(deduct.body.data.balanceAfter, 300);

      // 幂等键是必填参数，不能靠"总会重试"蒙过去。
      assert.equal((await request('POST', `admin/members/${memberId}/points-adjustments`,
        { deltaPoints: 10, reasonCode: 'goodwill', reason: 'no key' },
        { Origin: origin, 'X-CSRF-Token': adminCsrf })).status, 422);
    });

    await t.test('the ledger is append-only', async () => {
      const entry = await db.pointLedger.findFirstOrThrow({ where: { memberId } });
      // 触发器挡在数据库层：应用层写错也改不了历史账。
      await assert.rejects(() => db.$executeRaw`UPDATE "PointLedger" SET "balanceAfter" = 0 WHERE "id" = ${entry.id}::uuid`,
        /append-only/i);
      await assert.rejects(() => db.$executeRaw`DELETE FROM "PointLedger" WHERE "id" = ${entry.id}::uuid`, /append-only/i);
    });

    await t.test('adjusting points needs points.adjust, not just members.manage', async () => {
      const limited = await sessionFor(['members.manage', 'customers.read_masked']);
      // 头带全了仍然是 403：挡它的是缺少 points.adjust，不是参数。
      const denied = await limited('POST', `admin/members/${memberId}/points-adjustments`,
        { deltaPoints: 100, reasonCode: 'goodwill', reason: 'Should be refused' }, 'SuccessEnvelope',
        { 'Idempotency-Key': 'limited-adjust-0001' });
      assert.equal(denied.status, 403);
      assert.equal(await db.pointLedger.count({ where: { memberId, deltaPoints: 100 } }), 0);
      // 读等级目录只需要 members.manage，读得到但改不了积分。
      assert.equal((await limited('GET', 'admin/loyalty')).status, 200);
    });

    let memberCookie = '';
    await t.test('the member sees only their own balance and history', async () => {
      await resetLimits();
      const requested = await front('POST', 'storefront/member/otp/request', { email: memberEmail, locale: 'en',
        purpose: 'member_login' }, 'OtpChallengeEnvelope');
      assert.equal(requested.status, 202);
      const job = await db.identityNotificationJob.findFirstOrThrow({ where: { kind: 'member_otp',
        otpChallengeId: requested.body.data.challengeId } });
      const payload = JSON.parse(decrypt(job.encryptedPayload!, requested.body.data.challengeId, config, 'member-otp')) as
        { code: string };
      const verified = await front('POST', 'storefront/member/otp/verify',
        { challengeId: requested.body.data.challengeId, code: payload.code });
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      memberCookie = jar.get('ez_member_session')!;

      const profile = await front('GET', 'storefront/member/profile');
      assert.equal(profile.status, 200);
      assert.equal(profile.body.data.loyalty.balance, 300);
      assert.equal(profile.body.data.loyalty.pointsEnabled, true);
      assert.equal(profile.body.data.loyalty.lifetimeSpendMinor, 0);

      const points = await front('GET', 'storefront/member/points');
      assert.equal(points.status, 200);
      assert.equal(points.body.data.balance, 300);
      assert.equal(points.body.data.items.length, 2);
      // 新到旧：最新一笔是刚才的扣减。
      assert.equal(points.body.data.items[0].deltaPoints, -200);
      assert.equal(points.body.data.items[1].deltaPoints, 500);
      assert.equal(points.body.data.hasMore, false);
      // 会员只能看到自己的账，接口不接受 memberId 参数。
      assert.equal((await request('GET', 'storefront/member/points', undefined, { Cookie: 'other=1' })).status, 401);
    });

    await t.test('completing an order earns points once and upgrades the tier', async () => {
      const created = await front('POST', 'storefront/cart', undefined, 'SuccessEnvelope');
      assert.equal(created.status, 201);
      cartId = created.body.data.cartId;
      assert.equal((await front('POST', 'storefront/cart/items', { variantId, quantity: 2 })).status, 200);
      const quote = await front('POST', 'storefront/checkout/quote', { cartId, locale: 'en', marketCode: 'HK',
        contact, shippingAddress: address, shippingMethodId: methodId, couponCode: null,
        policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }] }, 'QuoteEnvelope');
      assert.equal(quote.status, 200, JSON.stringify(quote.body));
      const order = await front('POST', 'storefront/checkout/orders', { quoteId: quote.body.data.quoteId,
        confirmedQuoteVersion: 1, paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope', { 'Idempotency-Key': 'loyalty-order-0001' });
      assert.equal(order.status, 201, JSON.stringify(order.body));
      const orderId = order.body.data.orderId as string;

      // 已登录会员下单即建立关联（source=checkout），不用等下次登录按邮箱补。
      const link = await db.orderMemberLink.findFirstOrThrow({ where: { orderId } });
      assert.equal(link.memberId, memberId);
      assert.equal(link.source, 'checkout');

      const detail = await admin('GET', `admin/orders/${orderId}`);
      assert.equal(detail.status, 200);
      const itemId = detail.body.data.lines[0].id as string;
      const shipment = await request('POST', `admin/orders/${orderId}/shipments`,
        { items: [{ orderItemId: itemId, quantity: 2 }], carrierCode: null, carrierName: null, trackingNumber: null, note: null },
        { Origin: origin, 'X-CSRF-Token': adminCsrf, 'Idempotency-Key': 'loyalty-shipment-0001' });
      assert.equal(shipment.status, 201, JSON.stringify(shipment.body));
      const shipmentId = shipment.body.data.id as string;
      const dispatched = await request('POST', `admin/shipments/${shipmentId}/dispatch`,
        { dispatchedAt: new Date().toISOString(), trackingNumber: null, evidenceRef: null },
        { Origin: origin, 'X-CSRF-Token': adminCsrf, 'Idempotency-Key': 'loyalty-dispatch-0001', 'If-Match': '"1"' });
      assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));
      const delivered = await request('POST', `admin/shipments/${shipmentId}/deliver`,
        { deliveredAt: new Date().toISOString(), evidenceRef: null, note: null },
        { Origin: origin, 'X-CSRF-Token': adminCsrf, 'Idempotency-Key': 'loyalty-deliver-0001' });
      assert.equal(delivered.status, 200, JSON.stringify(delivered.body));

      const completed = await db.shopOrder.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(completed.orderStatus, 'completed');
      // 20,000 分 ÷ 100 = 200 点；运费的 3,000 分不参与积分。
      const earn = await db.pointLedger.findFirstOrThrow({ where: { memberId, entryType: 'earn' } });
      assert.equal(earn.deltaPoints, 200);
      assert.equal(earn.balanceAfter, 500);
      assert.equal(earn.sourceType, 'order');
      assert.equal(earn.sourceRef, completed.publicOrderNumber);
      assert.equal(earn.idempotencyKey, `order:${orderId}:earn`);
      // 累计消费推进，并且按门槛自动升到金级。
      const member = await db.memberProfile.findUniqueOrThrow({ where: { id: memberId } });
      assert.equal(Number(member.lifetimeSpendMinor), 20_000);
      assert.equal(member.tierId, tierId);
      assert.equal(await db.pointLedger.count({ where: { memberId, entryType: 'earn' } }), 1);

      // 再签收一次不会二次发放（订单已完成，发货动作本身就被状态机挡住）。
      const again = await request('POST', `admin/shipments/${shipmentId}/deliver`,
        { deliveredAt: new Date().toISOString(), evidenceRef: null, note: null },
        { Origin: origin, 'X-CSRF-Token': adminCsrf, 'Idempotency-Key': 'loyalty-deliver-0002' });
      assert.equal(again.status, 409);
      assert.equal(await db.pointLedger.count({ where: { memberId, entryType: 'earn' } }), 1);

      const points = await front('GET', 'storefront/member/points');
      assert.equal(points.status, 200);
      assert.equal(points.body.data.balance, 500);
      assert.equal(points.body.data.tier.code, 'GOLD');
      assert.equal(points.body.data.lifetimeSpendMinor, 20_000);
    });

    await t.test('retiring a tier stops new assignments but keeps existing ones', async () => {
      // 金级升到版本 2 并退役：已有会员的归属保留，新分配被拒。
      const retired = await adminIf('PATCH', `admin/loyalty/tiers/${tierId}`, { status: 'retired' }, '"1"');
      assert.equal(retired.status, 200, JSON.stringify(retired.body));
      assert.equal(retired.body.data.status, 'retired');
      const other = await admin('POST', 'admin/customers', { displayName: 'Late Joiner', email: 'late@example.com' });
      const refused = await admin('POST', 'admin/members', { customerId: other.body.data.id,
        consentRef: 'consent-late', tierId });
      assert.equal(refused.status, 422);
      assert.equal(refused.body.error.code, 'MEMBER_TIER_RETIRED');
      assert.equal((await db.memberProfile.findUniqueOrThrow({ where: { id: memberId } })).tierId, tierId);
    });
  } finally {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
  }
});
