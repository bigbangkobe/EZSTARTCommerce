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
import { otpEmailDigest } from '../packages/domain/src/members.js';
import { testPostgres } from './helpers/postgres.js';

test('members: verified email login, guest order linkage and admin customer records', { timeout: 300_000 }, async t => {
  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  const contracts = new IdentityContracts();
  const origin = 'https://shop.example.test';
  const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
    bootstrapToken: randomBytes(32).toString('base64url') };
  const identity = new IdentityService(db, config, contracts.ownerPermissions);
  const owner = { email: 'owner@members.test', displayName: 'Owner', password: 'A-long-test-password-1', locale: 'en' };
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
  /** 后台改资源必须带 If-Match：版本来自读取时的 ETag。 */
  const adminIf = (method: string, path: string, body: unknown, ifMatch: string, schema = 'SuccessEnvelope') =>
    request(method, path, body, { Origin: origin, 'X-CSRF-Token': adminCsrf, 'If-Match': ifMatch }, schema);
  /** 游客请求不带会话：会员登录不得是结账的前置条件。 */
  const front = (method: string, path: string, body?: unknown, schema = 'SuccessEnvelope',
    headers: Record<string, string> = {}) =>
    request(method, path, body, { ...(jar.has('ez_cart_csrf') ? { 'X-CSRF-Token': jar.get('ez_cart_csrf')! } : {}), ...headers }, schema);
  const resetLimits = () => db.identityRateLimit.deleteMany();

  const sessionFor = async (permissions: string[]) => {
    const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
    const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@members.test`, displayName: 'Staff',
      passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
    await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
    const token = randomBytes(32).toString('base64url');
    const csrfToken = csrf(token, config);
    await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
      lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
    /** csrf:false 用来证明缺少令牌的写请求会被拒绝，而不是悄悄沿用会话里的令牌。 */
    const call = (method: string, path: string, body?: unknown, schema = 'SuccessEnvelope',
      opts: { ifMatch?: string; csrf?: false } = {}) =>
      request(method, path, body, { Origin: origin,
        ...(opts.csrf === false ? {} : { 'X-CSRF-Token': csrfToken }),
        ...(opts.ifMatch ? { 'If-Match': opts.ifMatch } : {}), Cookie: `ez_admin_session=${token}` }, schema);
    return { call, userId: user.id };
  };

  let variantId = '';
  let methodId = '';
  let cart = { id: '', token: '', csrf: '' };

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

    await db.storeConfig.create({ data: { id: 1, displayName: 'Members Store', locales: ['zh-CN', 'zh-HK', 'en'],
      defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
    await db.marketProfile.create({ data: { marketCode: 'HK', enabled: true, reviewStatus: 'approved' } });
    const product = await db.product.create({ data: { status: 'active', marketCodes: ['HK'],
      translations: { create: [{ locale: 'en', name: 'Member Product', slug: 'member-product' }] } } });
    variantId = (await db.productVariant.create({ data: { productId: product.id, sku: 'SKU-M1',
      optionValues: { size: 'M' }, priceMinor: 10_000, currency: 'HKD' } })).id;
    await db.inventoryItem.create({ data: { variantId, onHand: 5 } });
    const zone = await admin('POST', 'admin/shipping/zones', { code: 'hk', nameByLocale: { en: 'Hong Kong' },
      countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true }, 'SuccessEnvelope');
    assert.equal(zone.status, 201);
    methodId = (await admin('POST', 'admin/shipping/rates', { code: 'standard', nameByLocale: { en: 'Standard' },
      zoneIds: [zone.body.data.id], fixedFeeMinor: 3_000, freeAboveMinor: 20_000, currency: 'HKD', estimatedMinDays: 1,
      estimatedMaxDays: 3, codEnabled: true, enabled: true }, 'SuccessEnvelope')).body.data.id;
  } catch (error) {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
    throw error;
  }

  const address = { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
    district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };
  const memberEmail = 'link@example.com';
  const contact = { email: memberEmail, phone: null, fullName: 'Buyer' };
  const otpCodeOf = async (challengeId: string) => {
    const job = await db.identityNotificationJob.findFirstOrThrow({ where: { kind: 'member_otp', otpChallengeId: challengeId } });
    const payload = JSON.parse(decrypt(job.encryptedPayload!, challengeId, config, 'member-otp')) as
      { code: string; email: string };
    return { job, payload };
  };

  try {
    let orderNumber = '';

    await t.test('a guest order is placed without any member session', async () => {
      await resetLimits();
      const created = await front('POST', 'storefront/cart', undefined, 'SuccessEnvelope');
      assert.equal(created.status, 201);
      cart = { id: created.body.data.cartId, token: jar.get('ez_guest_cart')!, csrf: jar.get('ez_cart_csrf')! };
      assert.equal((await front('POST', 'storefront/cart/items', { variantId, quantity: 1 })).status, 200);
      const quote = await front('POST', 'storefront/checkout/quote', { cartId: cart.id, locale: 'en', marketCode: 'HK',
        contact, shippingAddress: address, shippingMethodId: methodId, couponCode: null,
        policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }] }, 'QuoteEnvelope');
      assert.equal(quote.status, 200, JSON.stringify(quote.body));
      const order = await front('POST', 'storefront/checkout/orders', { quoteId: quote.body.data.quoteId,
        confirmedQuoteVersion: 1, paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope',
      { 'Idempotency-Key': 'members-guest-order-0001' });
      assert.equal(order.status, 201);
      orderNumber = order.body.data.publicOrderNumber;
      // 下单不需要会员：这一单此刻不持有任何会员关联。
      assert.equal(await db.orderMemberLink.count(), 0);
    });

    let profileChallenge = '';
    await t.test('the OTP request is uniform and never leaks the code or the address', async () => {
      await resetLimits();
      // 大小写混写由服务端规范化：契约只校验形状，规范化是业务规则。
      const requested = await front('POST', 'storefront/member/otp/request', { email: 'Link@Example.com',
        locale: 'zh-HK', purpose: 'member_login' }, 'OtpChallengeEnvelope');
      assert.equal(requested.status, 202, JSON.stringify(requested.body));
      const data = requested.body.data;
      assert.equal(data.challengeAccepted, true);
      assert.equal(data.resendAfterSeconds, 60);
      assert.ok(data.expiresInSeconds > 0 && data.expiresInSeconds <= 600);
      profileChallenge = data.challengeId;
      assert.match(profileChallenge, /^[0-9a-f-]{36}$/);

      const { payload } = await otpCodeOf(profileChallenge);
      assert.match(payload.code, /^\d{6}$/);
      assert.equal(payload.email, memberEmail, '邮箱按小写存储与投递');
      // 验证码只在邮件里：响应体（含 meta）任何位置都不得出现。
      assert.equal(JSON.stringify(requested.body).includes(payload.code), false);

      const row = await db.memberOtpChallenge.findUniqueOrThrow({ where: { id: profileChallenge } });
      assert.match(row.emailDigest, /^[0-9a-f]{64}$/);
      assert.match(row.codeDigest, /^[0-9a-f]{64}$/);
      // 挑战表不存明文邮箱与明文验证码：库被读也拿不到可用的登录材料。
      assert.equal(row.emailCipher.includes(memberEmail), false);
      assert.equal(row.emailCipher.includes(payload.code), false);
      assert.equal(row.status, 'pending');
      assert.equal(row.maxAttempts, 5);

      // 未登记的地址得到完全相同的响应：不能用它探测会员是否存在。
      const unknown = await front('POST', 'storefront/member/otp/request', { email: 'nobody@example.com',
        locale: 'zh-HK', purpose: 'member_login' }, 'OtpChallengeEnvelope');
      assert.equal(unknown.status, 202);
      assert.deepEqual(Object.keys(unknown.body.data).sort(), Object.keys(data).sort());
      assert.equal(unknown.body.data.challengeAccepted, data.challengeAccepted);
      assert.equal(unknown.body.data.resendAfterSeconds, data.resendAfterSeconds);
    });

    await t.test('the same mailbox cannot request a second code within a minute', async () => {
      await resetLimits();
      const again = await front('POST', 'storefront/member/otp/request', { email: memberEmail, locale: 'en',
        purpose: 'member_login' });
      assert.equal(again.status, 429);
      assert.equal(again.body.error.code, 'RATE_LIMITED');
      // 冷却只挡同一邮箱：别的顾客不受影响。
      assert.equal((await front('POST', 'storefront/member/otp/request', { email: 'other@example.com', locale: 'en',
        purpose: 'member_login' }, 'OtpChallengeEnvelope')).status, 202);
      // 未启用语言与未知用途都按请求错误处理，而不是悄悄改成默认值。
      assert.equal((await front('POST', 'storefront/member/otp/request', { email: 'x@example.com', locale: 'fr',
        purpose: 'member_login' })).status, 422);
      assert.equal((await front('POST', 'storefront/member/otp/request', { email: 'x@example.com', locale: 'en',
        purpose: 'password_reset' })).status, 422);
    });

    await t.test('a wrong code spends attempt budget without revealing anything', async () => {
      await resetLimits();
      const { payload } = await otpCodeOf(profileChallenge);
      const wrong = payload.code === '000000' ? '111111' : '000000';
      const failed = await front('POST', 'storefront/member/otp/verify', { challengeId: profileChallenge, code: wrong });
      assert.equal(failed.status, 401);
      const row = await db.memberOtpChallenge.findUniqueOrThrow({ where: { id: profileChallenge } });
      assert.equal(row.attempts, 1);
      assert.equal(row.status, 'pending');
      // 未知挑战与错误验证码走同一个 401，不区分“存在但错”与“不存在”。
      assert.equal((await front('POST', 'storefront/member/otp/verify',
        { challengeId: randomUUID(), code: payload.code })).status, 401);
      assert.equal((await front('POST', 'storefront/member/otp/verify', { challengeId: profileChallenge, code: '12345' })).status, 422);
    });

    let memberCookie = '';
    let memberCsrf = '';
    let memberId = '';
    await t.test('the right code creates the customer and member exactly once', async () => {
      await resetLimits();
      const { payload } = await otpCodeOf(profileChallenge);
      const verified = await front('POST', 'storefront/member/otp/verify', { challengeId: profileChallenge, code: payload.code });
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      const member = verified.body.data.member;
      assert.match(member.memberNo, /^MB-[0-9]{8}-[A-Z0-9]{6}$/);
      assert.equal(member.email, memberEmail);
      assert.equal(member.displayName, 'link');
      assert.equal(member.status, 'active');
      assert.match(verified.body.data.csrfToken, /^[0-9a-f]{64}$/);
      memberCsrf = verified.body.data.csrfToken;
      memberCookie = jar.get('ez_member_session')!;
      assert.match(memberCookie, /^[A-Za-z0-9_-]{43}$/);

      const cookie = verified.response.headers.getSetCookie().find(value => value.startsWith('ez_member_session='))!;
      assert.ok(cookie.includes('HttpOnly'), '会员会话不能被脚本读取');
      assert.ok(cookie.includes('Secure') && cookie.includes('SameSite=Lax') && cookie.includes('Path=/api/v1'));

      const customer = await db.customer.findUniqueOrThrow({ where: { emailNormalized: memberEmail } });
      assert.equal(customer.displayName, 'link');
      const stored = await db.memberProfile.findUniqueOrThrow({ where: { customerId: customer.id } });
      memberId = stored.id;
      assert.equal(stored.memberNo, member.memberNo);
      // 会话表只有 token 摘要：cookie 被读走也无法从库里拼回可用凭据。
      const session = await db.memberSession.findFirstOrThrow({ where: { memberId } });
      assert.match(session.tokenDigest, /^[0-9a-f]{64}$/);
      assert.notEqual(session.tokenDigest, memberCookie);

      // 一次性消费：同一挑战不能换出第二个会话。
      assert.equal((await front('POST', 'storefront/member/otp/verify', { challengeId: profileChallenge, code: payload.code })).status, 401);
      assert.equal(await db.memberSession.count({ where: { memberId } }), 1);
    });

    await t.test('the verified mailbox adopts existing guest orders', async () => {
      const links = await db.orderMemberLink.findMany({ where: { memberId } });
      assert.equal(links.length, 1);
      assert.equal(links[0]!.source, 'email_match');
      const orders = await front('GET', 'storefront/member/orders', undefined, 'SuccessEnvelope');
      assert.equal(orders.status, 200);
      assert.equal(orders.body.data.items.length, 1);
      assert.equal(orders.body.data.items[0].orderNumber, orderNumber);
      assert.equal(orders.body.data.items[0].totalMinor, 13_000);
      assert.equal(orders.body.data.items[0].paymentStatus, 'cod_due');
      assert.equal(orders.body.data.hasMore, false);
      assert.equal(orders.body.data.nextCursor, null);
      // 会员摘要只给订单层面的字段：没有地址、联系方式或成本。
      const text = JSON.stringify(orders.body);
      assert.equal(text.includes('Queen Road'), false);
      assert.equal(text.includes(memberEmail), false);
    });

    await t.test('the profile endpoint requires a live member session', async () => {
      const profile = await front('GET', 'storefront/member/profile', undefined, 'SuccessEnvelope');
      assert.equal(profile.status, 200);
      assert.equal(profile.body.data.email, memberEmail);
      assert.equal(profile.body.data.memberNo, (await db.memberProfile.findUniqueOrThrow({ where: { id: memberId } })).memberNo);
      // 会员 cookie 不能当后台会话用。
      const asAdmin = await request('GET', 'admin/customers', undefined, { Cookie: `ez_member_session=${memberCookie}` });
      assert.equal(asAdmin.status, 401);
      const forged = await request('GET', 'storefront/member/profile', undefined, { Cookie: `ez_member_session=${'A'.repeat(43)}` });
      assert.equal(forged.status, 401);
      // 不带会员 cookie（这里用无关 cookie 覆盖，避免命中 jar 里的会话）。
      assert.equal((await request('GET', 'storefront/member/profile', undefined, { Cookie: 'other=1' })).status, 401);
    });

    await t.test('logout needs the session-derived CSRF token and revokes the session', async () => {
      assert.equal((await front('POST', 'storefront/member/logout')).status, 403);
      assert.equal((await front('POST', 'storefront/member/logout', undefined, 'SuccessEnvelope',
        { 'X-CSRF-Token': 'B'.repeat(64) })).status, 403);
      const out = await front('POST', 'storefront/member/logout', undefined, undefined, { 'X-CSRF-Token': memberCsrf });
      assert.equal(out.status, 204);
      // 只认本 cookie 派生的那一行：同一个人可能有多个历史会话。
      const revoked = await db.memberSession.findUniqueOrThrow({ where: { tokenDigest: digest(memberCookie) } });
      assert.equal(revoked.status, 'revoked');
      assert.ok(revoked.revokedAt);
      assert.equal((await request('GET', 'storefront/member/profile', undefined,
        { Cookie: `ez_member_session=${memberCookie}` })).status, 401);
    });

    await t.test('a suspended member keeps no session and a closed member is terminal', async () => {
      await resetLimits();
      // 重新登录拿到会话，再由后台停用：会话必须当场失效。
      // 60 秒冷却里没有时钟可推进，直接把上一批挑战挪到窗口外。
      await db.memberOtpChallenge.updateMany({
        where: { emailDigest: otpEmailDigest(config.encryptionKey, config.instanceId, memberEmail) },
        data: { createdAt: new Date(Date.now() - 120_000) } });
      await resetLimits();
      const requested = await front('POST', 'storefront/member/otp/request', { email: memberEmail, locale: 'en',
        purpose: 'member_login' }, 'OtpChallengeEnvelope');
      assert.equal(requested.status, 202, JSON.stringify(requested.body));
      const { payload } = await otpCodeOf(requested.body.data.challengeId);
      const verified = await front('POST', 'storefront/member/otp/verify',
        { challengeId: requested.body.data.challengeId, code: payload.code });
      assert.equal(verified.status, 200);
      // 第二次登录不重复链接订单。
      assert.equal(await db.orderMemberLink.count({ where: { memberId } }), 1);
      const live = jar.get('ez_member_session')!;

      const suspended = await adminIf('PATCH', `admin/members/${memberId}`, { status: 'suspended', reason: 'abuse report' }, '"1"');
      assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
      assert.equal(suspended.body.data.status, 'suspended');
      assert.equal(suspended.body.data.version, 2);
      assert.equal((await request('GET', 'storefront/member/profile', undefined,
        { Cookie: `ez_member_session=${live}` })).status, 401);
      assert.equal(await db.memberSession.count({ where: { memberId, status: 'active' } }), 0);

      const closed = await adminIf('PATCH', `admin/members/${memberId}`, { status: 'closed', reason: 'requested deletion' }, '"2"');
      assert.equal(closed.status, 200);
      // closed 是终态：不能再被“重新激活”。
      const reopen = await adminIf('PATCH', `admin/members/${memberId}`, { status: 'active', reason: 'comeback' }, '"3"');
      assert.equal(reopen.status, 422);
      assert.equal(reopen.body.error.code, 'MEMBER_CLOSED');
      // 停用的会员即使验证码正确也拿不到会话。
      await db.identityRateLimit.deleteMany();
      const denied = await front('POST', 'storefront/member/otp/request', { email: memberEmail, locale: 'en',
        purpose: 'member_login' });
      assert.equal(denied.status, 429, '冷却仍然生效');
    });

    let customerId = '';
    await t.test('admin customer records are masked unless the actor may read PII', async () => {
      await resetLimits();
      const created = await admin('POST', 'admin/customers', { displayName: 'Walk-in', email: 'Walkin@Example.com',
        phone: '+852 1234 5678', tags: ['vip'], internalNote: 'called the shop' });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      customerId = created.body.data.id;
      assert.equal(created.body.data.email, 'walkin@example.com');
      assert.equal(created.body.data.version, 1);
      assert.equal(created.body.data.member, null);
      assert.ok(created.response.headers.get('etag'));

      // 同一邮箱规范化后唯一：不会出现两个“同一个人”。
      const duplicate = await admin('POST', 'admin/customers', { displayName: 'Dupe', email: 'walkin@example.com' });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.error.code, 'CUSTOMER_EMAIL_TAKEN');
      assert.equal((await admin('POST', 'admin/customers', { displayName: '' })).status, 422);

      const list = await admin('GET', 'admin/customers?q=walkin');
      assert.equal(list.status, 200);
      assert.equal(list.body.data.items.length, 1);
      assert.equal(list.body.data.items[0].id, customerId);

      const masked = await sessionFor(['customers.read_masked']);
      const seen = await masked.call('GET', 'admin/customers');
      assert.equal(seen.status, 200);
      const row = seen.body.data.items.find((item: { id: string }) => item.id === customerId);
      assert.ok(row.email.includes('*'), `默认必须遮蔽邮箱，实际 ${row.email}`);
      assert.notEqual(row.email, 'walkin@example.com');
      assert.equal(row.phone.includes('*'), true);
      assert.equal(row.internalNote, null, '内部备注属于 PII，默认不可见');
      // 有读权限但没有写权限：写操作 403。
      assert.equal((await masked.call('POST', 'admin/customers', { displayName: 'Nope' })).status, 403);
      assert.equal((await masked.call('PATCH', `admin/customers/${customerId}`, { displayName: 'Nope' },
        'SuccessEnvelope', { ifMatch: '"1"' })).status, 403);
      const unrelated = await sessionFor(['catalog.read']);
      assert.equal((await unrelated.call('GET', 'admin/customers')).status, 403);
      // 没有后台会话（这里显式给一个无效 cookie，避免带上 bootstrap 得到的 owner 会话）。
      assert.equal((await request('GET', 'admin/customers', undefined,
        { Cookie: `ez_admin_session=${'A'.repeat(43)}` })).status, 401);
      assert.equal((await request('PATCH', `admin/customers/${customerId}`, { displayName: 'No origin' },
        { 'X-CSRF-Token': adminCsrf })).status, 403);
      // 有写权限但没有 CSRF 令牌：跨站请求不能改顾客资料。
      const writer = await sessionFor(['customers.manage']);
      assert.equal((await writer.call('PATCH', `admin/customers/${customerId}`, { displayName: 'No CSRF' },
        'SuccessEnvelope', { ifMatch: '"1"', csrf: false })).status, 403);
    });

    await t.test('customer edits are versioned and audited', async () => {
      await resetLimits();
      assert.equal((await admin('PATCH', `admin/customers/${customerId}`, { displayName: 'Walk-in' })).status, 422,
        'If-Match 缺失时不能盲写');
      const updated = await request('PATCH', `admin/customers/${customerId}`, { phone: null, tags: ['vip', 'wholesale'] },
        { Origin: origin, 'X-CSRF-Token': adminCsrf, 'If-Match': '"1"' });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal(updated.body.data.version, 2);
      assert.equal(updated.body.data.phone, null);
      assert.deepEqual(updated.body.data.tags, ['vip', 'wholesale']);
      const stale = await request('PATCH', `admin/customers/${customerId}`, { displayName: 'Again' },
        { Origin: origin, 'X-CSRF-Token': adminCsrf, 'If-Match': '"1"' });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
      assert.equal(await db.auditLog.count({ where: { action: 'customer.updated', objectId: customerId } }), 1);
    });

    await t.test('member records are created for a known customer and audited', async () => {
      await resetLimits();
      const foreign = await admin('POST', 'admin/members', { customerId: randomUUID(), consentRef: 'consent-1' });
      assert.equal(foreign.status, 404);
      const created = await admin('POST', 'admin/members', { customerId, consentRef: 'consent-2026-11' });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.match(created.body.data.memberNo, /^MB-[0-9]{8}-[A-Z0-9]{6}$/);
      assert.equal(created.body.data.customer.id, customerId);
      assert.equal(created.body.data.consentRef, 'consent-2026-11');
      assert.equal((await admin('POST', 'admin/members', { customerId, consentRef: 'consent-2026-11' })).status, 409);
      // 等级目录尚未落地：带 tierId 明确拒绝，而不是静默忽略。
      const tier = await admin('POST', 'admin/members', { customerId: randomUUID(), consentRef: 'c',
        tierId: randomUUID() });
      assert.equal(tier.status, 422);
      assert.equal(tier.body.error.code, 'MEMBER_TIERS_UNAVAILABLE');
      const list = await admin('GET', 'admin/members');
      assert.equal(list.status, 200);
      assert.ok(list.body.data.items.some((item: { customer: { id: string } }) => item.customer.id === customerId));
      assert.equal(await db.auditLog.count({ where: { action: 'member.created' } }), 1);
    });

    await t.test('exhausted challenges stop accepting any code', async () => {
      await resetLimits();
      const requested = await front('POST', 'storefront/member/otp/request', { email: 'exhaust@example.com', locale: 'en',
        purpose: 'member_login' }, 'OtpChallengeEnvelope');
      // 同一 IP 一小时内已多次申请：这里换一个新地址仍应通过。
      assert.equal(requested.status, 202, JSON.stringify(requested.body));
      const challengeId = requested.body.data.challengeId as string;
      const { payload } = await otpCodeOf(challengeId);
      const wrong = payload.code === '000000' ? '111111' : '000000';
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await resetLimits();
        assert.equal((await front('POST', 'storefront/member/otp/verify', { challengeId, code: wrong })).status, 401);
      }
      await resetLimits();
      // 第五次失败把挑战作废，并明确回报“别再试了”。
      const fifth = await front('POST', 'storefront/member/otp/verify', { challengeId, code: wrong });
      assert.equal(fifth.status, 429);
      const row = await db.memberOtpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
      assert.equal(row.status, 'failed');
      assert.equal(row.attempts, 5);
      await resetLimits();
      // 作废之后即使给出正确验证码也不再受理。
      assert.equal((await front('POST', 'storefront/member/otp/verify', { challengeId, code: payload.code })).status, 401);
      assert.equal(await db.customer.count({ where: { emailNormalized: 'exhaust@example.com' } }), 0);
    });
  } finally {
    if (app) await app.close();
    await identity.onModuleDestroy().catch(() => {});
    await cluster.stop();
  }
});
