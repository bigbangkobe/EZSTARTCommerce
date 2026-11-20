/**
 * 线上退款端到端：发起 → 渠道执行 → 收敛 → 幂等重放 → 渠道拒绝落 failed。
 *
 * 与 payments-online-http 互补：那边验"收钱"，这边验"退钱"。
 * 关键不变量：
 * 1. 退款必须先落 processing 再调渠道，崩溃后能靠这个状态判断钱可能已退出。
 * 2. 渠道成功才落 refunded；渠道拒绝落 failed 且写 failureCode；拒绝对不能当成成功。
 * 3. 同一幂等键重放不产生第二笔退款，也不会重复调渠道。
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { csrf } from '../apps/api/src/identity/crypto.js';
import { MockPaymentAdapter } from '../apps/api/src/payments/adapters/mock.js';
import { adapterFor } from '../apps/api/src/payments/adapters/registry.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { testPostgres } from './helpers/postgres.js';

const CREDENTIALS = JSON.stringify({ apiKey: 'test_api_key_1234', webhookSecret: 'test_webhook_secret_1234' });
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('online refunds: dispatch, settle, idempotent replay and provider rejection', { timeout: 300_000 },
  async (t) => {
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

    const post = async (path: string, body: unknown, headers: Record<string, string>) => {
      const response = await fetch(base + '/api/v1/' + path, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
    };

    /** 直接建会话：这里只关心退款权限链，登录细节有独立测试。 */
    const sessionFor = async (permissions: string[]) => {
      const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom',
        permissionCodes: permissions } });
      const user = await db.adminUser.create({ data: { email: `refund-${randomUUID()}@test.local`,
        displayName: 'Finance', passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
      await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
      const token = randomBytes(32).toString('base64url');
      const csrfToken = csrf(token, config);
      await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
        lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
      const headers = { Origin: origin, 'X-CSRF-Token': csrfToken, Cookie: `ez_admin_session=${token}` };
      return {
        call: async (method: string, path: string, body?: unknown, key?: string) => {
          const response = await fetch(base + '/api/v1/' + path, { method,
            headers: { 'Content-Type': 'application/json', ...headers,
              ...(method === 'GET' ? {} : { 'Idempotency-Key': key ?? randomUUID() }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
          const text = await response.text();
          return { status: response.status, body: text ? JSON.parse(text) as any : null };
        },
      };
    };

    let rateId = '';
    const contact = { email: 'buyer@example.com', phone: '+85291234567', fullName: 'Buyer' };
    const address = { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null,
      city: 'Hong Kong', district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };

    /** 造一张已收款（或指定状态）的线上支付订单，并把渠道单号登记进 mock 网关。 */
    const makeOnlineOrder = async (options: { settleInProvider?: boolean } = {}) => {
      const now = new Date();
      // 每单一个购物袋凭证：/pay 用 cartId 校验归属，用同一个 token 会串单。
      const orderCartToken = randomBytes(32).toString('base64url');
      const orderHeaders = { Origin: origin, 'X-CSRF-Token': csrfToken,
        Cookie: `ez_guest_cart=${orderCartToken}; ez_cart_csrf=${csrfToken}` };
      const cart = await db.guestCart.create({ data: { tokenDigest: sha256(orderCartToken),
        status: 'converted', currency: 'HKD', expiresAt: new Date(now.getTime() + 86_400_000) } });
      const quote = await db.checkoutQuote.create({ data: { cartId: cart.id, status: 'consumed', version: 1,
        locale: 'en', marketCode: 'HK', currency: 'HKD', contact, shippingAddress: address, shippingMethodId: rateId,
        shippingMethodSnapshot: { code: 'STANDARD', name: 'Standard' }, subtotalMinor: 20_000, discountMinor: 0,
        shippingMinor: 3_000, taxMinor: 0, totalMinor: 23_000,
        ruleVersions: { price: 'catalog.v1', promotion: 'none', shipping: 'rate:1', tax: null }, warnings: [],
        policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }],
        expiresAt: new Date(now.getTime() + 900_000) } });
      const order = await db.shopOrder.create({ data: {
        publicOrderNumber: `EZ-20261120-${randomBytes(3).toString('hex').toUpperCase()}`,
        idempotencyKey: randomUUID(), requestDigest: sha256(randomUUID()), quoteId: quote.id, cartId: cart.id,
        shippingRateId: rateId, orderStatus: 'awaiting_confirmation', paymentStatus: 'succeeded',
        currency: 'HKD', subtotalMinor: 20_000, discountMinor: 0, shippingMinor: 3_000, taxMinor: 0,
        totalMinor: 23_000, locale: 'en', marketCode: 'HK', contact, shippingAddress: address,
        shippingMethodSnapshot: { code: 'STANDARD', name: 'Standard' }, paymentMethodCode: 'mock',
        policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }], placedAt: now } });
      const payment = await db.payment.create({ data: { publicPaymentNumber:
        `PAY-20261120-${randomBytes(3).toString('hex').toUpperCase()}`, dedupeKey: `mock:${order.id}`,
        orderId: order.id, methodConfigId: methodConfigId, providerCode: 'mock', environment: 'sandbox',
        channel: 'online', status: 'pending', amountMinor: 23_000, currency: 'HKD', metadata: {} } });

      // 走真实发起接口：渠道单号由适配器生成并回写台账，退款才有可退对象。
      const intent = await post(`storefront/checkout/orders/${order.id}/pay`, {}, orderHeaders);
      assert.equal(intent.status, 200, JSON.stringify(intent.body));
      const providerTransactionId = (intent.body as { data: { providerTransactionId: string } }).data
        .providerTransactionId;

      if (options.settleInProvider !== false) {
        (adapterFor('mock', 'sandbox') as MockPaymentAdapter).simulatePaid(payment.publicPaymentNumber);
        await db.payment.update({ where: { id: payment.id }, data: { status: 'succeeded', paidAt: now } });
      }
      return { order, payment, providerTransactionId };
    };

    let methodConfigId = '';

    try {
      await identity.initialize();
      app = await createApp(identity);
      await app.listen(0, '127.0.0.1');
      base = await app.getUrl();

      await db.storeConfig.create({ data: { id: 1, displayName: 'Refund Store', locales: ['en'],
        defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
      const zone = await db.shippingZone.create({ data: { code: 'HK', nameByLocale: { en: 'Hong Kong' },
        countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true } });
      rateId = (await db.shippingRate.create({ data: { code: 'STANDARD', nameByLocale: { en: 'Standard' },
        fixedFeeMinor: 3_000, freeAboveMinor: 50_000, currency: 'HKD', estimatedMinDays: 1, estimatedMaxDays: 3,
        enabled: true, codEnabled: false, zones: { create: [{ zoneId: zone.id }] } } })).id;
      methodConfigId = (await db.paymentMethodConfig.create({ data: { providerCode: 'mock',
        environment: 'sandbox', displayName: 'Mock gateway', enabled: true, approvalReference: 'test-approval',
        approvedAt: new Date(), publicConfig: { providerAccountRef: 'MOCK-MERCHANT-1',
          checkoutBase: 'https://sandbox.invalid/mock-pay' }, secretRef: 'secret://env/MOCK_PAYMENT_SECRET',
        connectionStatus: 'ok', lastCheckedAt: new Date() } })).id;

      const finance = await sessionFor(['refunds.create', 'refund.approve', 'refund.execute', 'payments.read',
        'aftersales.read']);
      // 四眼原则：申请人和批准人不能是同一个人，所以必须分开建会话。
      const approver = await sessionFor(['refund.approve', 'refund.execute', 'payments.read']);
      const executorOnly = await sessionFor(['refund.execute']);

      // ---- 1. 渠道退款成功：processing → refunded --------------------------------
      const paid = await makeOnlineOrder();
      const created = await finance.call('POST', 'admin/refunds', { orderId: paid.order.id, paymentId: paid.payment.id,
        amountMinor: 23_000, currency: 'HKD', reason: 'Customer returned everything' });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const refundId = created.body.data.id as string;
      assert.equal(created.body.data.channel, 'online');
      assert.equal(created.body.data.status, 'requested');

      // 未批准不能执行。
      const early = await finance.call('POST', `admin/refunds/${refundId}/execute`, { reason: 'too early' });
      assert.equal(early.status, 409);

      const approved = await approver.call('POST', `admin/refunds/${refundId}/approve`, { reason: 'Approved' });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.data.status, 'approved');

      const key = randomUUID();
      const executed = await executorOnly.call('POST', `admin/refunds/${refundId}/execute`,
        { reason: 'refunded via gateway' }, key);
      assert.equal(executed.status, 200, JSON.stringify(executed.body));
      assert.equal(executed.body.data.status, 'refunded');
      assert.match(String(executed.body.data.externalRefundId), /^mockr_/, '渠道退款单号必须回写');
      assert.ok(executed.body.data.executedAt);
      // 事件链必须留下"已发出"和"已落定"两条，崩溃时可据此判断钱可能已退出。
      const types = (executed.body.data.events as { type: string }[]).map(event => event.type);
      assert.ok(types.includes('dispatched'), `events: ${types.join(',')}`);
      assert.ok(types.includes('refunded'), `events: ${types.join(',')}`);

      const settledRow = await db.refund.findUniqueOrThrow({ where: { id: refundId } });
      assert.equal(settledRow.status, 'refunded');
      assert.equal(settledRow.executedAt instanceof Date, true);

      // ---- 2. 同键重放：不产生第二笔，也不重复调渠道 ------------------------------
      const replay = await executorOnly.call('POST', `admin/refunds/${refundId}/execute`,
        { reason: 'refunded via gateway' }, key);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.data.id, refundId);
      assert.equal(await db.refund.count({ where: { orderId: paid.order.id } }), 1);

      // 已退款不能再退一次（状态机挡住）。
      const again = await executorOnly.call('POST', `admin/refunds/${refundId}/execute`, { reason: 'again' });
      assert.equal(again.status, 409);

      // ---- 3. 渠道拒绝：落 failed 并留 failureCode，绝不改成功 --------------------
      const unsettled = await makeOnlineOrder({ settleInProvider: false });
      // 台账说已收（否则创建退款会被挡），渠道侧其实没收款 —— 模拟渠道拒退。
      await db.payment.update({ where: { id: unsettled.payment.id }, data: { status: 'succeeded',
        paidAt: new Date() } });
      const rejectedRefund = await finance.call('POST', 'admin/refunds', { orderId: unsettled.order.id,
        paymentId: unsettled.payment.id, amountMinor: 5_000, currency: 'HKD', reason: 'partial refund' });
      assert.equal(rejectedRefund.status, 201, JSON.stringify(rejectedRefund.body));
      const rejectedId = rejectedRefund.body.data.id as string;
      await approver.call('POST', `admin/refunds/${rejectedId}/approve`, { reason: 'Approved' });

      const failed = await executorOnly.call('POST', `admin/refunds/${rejectedId}/execute`, { reason: 'try' });
      assert.equal(failed.status, 200, JSON.stringify(failed.body));
      assert.equal(failed.body.data.status, 'failed');
      assert.equal(failed.body.data.failureCode, 'REFUND_NOT_SETTLED');
      assert.equal(failed.body.data.executedAt, null);

      const failedRow = await db.refund.findUniqueOrThrow({ where: { id: rejectedId } });
      assert.equal(failedRow.status, 'failed');
      // 失败的退款不参与"已退金额"，可退余额不能被它吃掉。
      assert.equal(failedRow.executedAt, null);
    } finally {
      await app?.close();
      await db.$disconnect();
      await cluster.stop();
    }
  });
