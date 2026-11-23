/**
 * 支付方式自助配置：这是"客户自己接收单账号、不改代码不重启"的产品承诺对应的验收。
 *
 * 四个必须成立的事实：
 * 1. 全新实例里，白名单里的每个渠道都有配置行（否则后台只能改、不能加）。
 * 2. 新建行默认关闭，不会被误当成可用渠道。
 * 3. 启用但没测通凭据时，结账页看不到它——配错凭据最坏是"看不见"，不是"下单必失败"。
 * 4. 测通之后立刻可用，不需要重启服务。
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { csrf } from '../apps/api/src/identity/crypto.js';
import { PaymentsService } from '../apps/api/src/payments/service.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { testPostgres } from './helpers/postgres.js';
const CREDENTIALS = JSON.stringify({ apiKey: 'test_api_key_1234', webhookSecret: 'test_webhook_secret_1234' });
test('payment methods can be configured, tested and toggled without code changes', { timeout: 300_000 }, async () => {
    process.env.MOCK_PAYMENT_SECRET = CREDENTIALS;
    process.env.PAYMENTS_BASE_URL = 'https://shop.example.test';
    // staging 实例用沙箱渠道；mock 这类渠道只存在于 sandbox。
    process.env.PAYMENTS_ENVIRONMENT = 'sandbox';
    const cluster = await testPostgres();
    const db = connectDatabase(cluster.url);
    const contracts = new IdentityContracts();
    const origin = 'https://shop.example.test';
    const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
        bootstrapToken: randomBytes(32).toString('base64url') };
    const identity = new IdentityService(db, config, contracts.ownerPermissions);
    const payments = new PaymentsService(identity, null);
    let app;
    let base = '';
    const request = async (method, path, body, headers = {}) => {
        const response = await fetch(base + '/api/v1/' + path, { method,
            headers: { 'Content-Type': 'application/json', ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    try {
        await identity.initialize();
        app = await createApp(identity);
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();
        await db.storeConfig.create({ data: { id: 1, displayName: 'Methods Store', locales: ['en'],
                defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
        const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom',
                permissionCodes: ['payment.config', 'payments.read'] } });
        const user = await db.adminUser.create({ data: { email: `finance-${randomUUID()}@test.local`,
                displayName: 'Finance', passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
        await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
        const token = randomBytes(32).toString('base64url');
        const csrfToken = csrf(token, config);
        await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
                lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
                absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
        const admin = { Origin: origin, 'X-CSRF-Token': csrfToken, Cookie: `ez_admin_session=${token}` };
        // ---- 1. 全新实例：每个渠道都有行，且默认关闭 --------------------------------
        const list = await request('GET', 'admin/payment-methods', undefined, admin);
        assert.equal(list.status, 200, JSON.stringify(list.body));
        const methods = list.body.data.items;
        const codes = methods.map(method => `${method.providerCode}:${method.environment}`).sort();
        assert.ok(codes.includes('mock:sandbox'), `缺少 mock 沙箱配置行：${codes.join(',')}`);
        assert.ok(codes.includes('cod:production'));
        const mock = methods.find(method => method.providerCode === 'mock' && method.environment === 'sandbox');
        assert.equal(mock.enabled, false, '新建渠道不能默认启用');
        assert.equal(mock.connectionStatus, 'unverified');
        assert.equal(mock.secretConfigured, false);
        // 关闭状态下结账不可见（这里直接问结账解析逻辑，比只断言字段更接近真实后果）。
        await assert.rejects(() => payments.resolveCheckout(db, 'mock', false), (error) => error.code === 'PAYMENT_METHOD_UNAVAILABLE');
        // ---- 2. 填配置并启用：仍未测通，结账依旧不可见 ------------------------------
        const patched = await request('PATCH', 'admin/payment-methods', { providerCode: 'mock', environment: 'sandbox',
            enabled: true, displayName: 'Mock gateway', approvalReference: 'OPS-2026-001',
            secretRef: 'secret://env/MOCK_PAYMENT_SECRET', publicConfig: { providerAccountRef: 'MOCK-1' } }, { ...admin, 'If-Match': `"${mock.version}"` });
        assert.equal(patched.status, 200, JSON.stringify(patched.body));
        assert.equal(patched.body.data.enabled, true);
        assert.equal(patched.body.data.connectionStatus, 'unverified');
        assert.equal(patched.body.data.secretConfigured, true);
        // 指纹可见、明文不可见。
        assert.ok(patched.body.data.secretFingerprint);
        assert.equal(JSON.stringify(patched.body).includes('test_api_key_1234'), false, '响应里不能出现密钥明文');
        await assert.rejects(() => payments.resolveCheckout(db, 'mock', false), (error) => error.code === 'PAYMENT_METHOD_UNAVAILABLE');
        // ---- 3. 测试连接通过后立刻可用，无需重启 -----------------------------------
        const checked = await request('POST', 'admin/payment-methods/mock/connection-test?environment=sandbox', undefined, admin);
        assert.equal(checked.status, 200, JSON.stringify(checked.body));
        assert.equal(checked.body.data.connectionStatus, 'ok');
        const resolved = await payments.resolveCheckout(db, 'mock', false);
        assert.equal(resolved.definition.code, 'mock');
        assert.equal(resolved.row.environment, 'sandbox');
        // ---- 4. 停用后重新不可用，且凭证引用保留 ------------------------------------
        const current = await request('GET', 'admin/payment-methods', undefined, admin);
        const latest = current.body.data.items
            .find(method => method.providerCode === 'mock' && method.environment === 'sandbox');
        const disabled = await request('PATCH', 'admin/payment-methods', { providerCode: 'mock', environment: 'sandbox',
            enabled: false }, { ...admin, 'If-Match': `"${latest.version}"` });
        assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
        assert.equal(disabled.body.data.enabled, false);
        // 停用不清凭证：重新开启时不必再让客户翻一遍密钥。
        assert.equal(disabled.body.data.secretConfigured, true);
        await assert.rejects(() => payments.resolveCheckout(db, 'mock', false), (error) => error.code === 'PAYMENT_METHOD_UNAVAILABLE');
    }
    finally {
        delete process.env.PAYMENTS_ENVIRONMENT;
        await app?.close();
        await db.$disconnect();
        await cluster.stop();
    }
});
