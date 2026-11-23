import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { passwordHash } from '../apps/api/src/identity/crypto.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { testPostgres } from './helpers/postgres.js';
/**
 * 工作台聚合接口。三条不变量：
 * 1. 门槛是 orders.read，没有它直接 403（不是返回空壳）；
 * 2. 拿不到数据权限的块返回 null 而不是 0 —— 0 会被读成「没有待办」；
 * 3. 最近订单只给摘要字段，不透出顾客联系方式。
 */
test('工作台聚合：按权限裁剪各块，无权限块返回 null', { timeout: 120_000 }, async (t) => {
    const cluster = await testPostgres();
    const db = connectDatabase(cluster.url);
    const contracts = new IdentityContracts();
    const origin = 'https://shop.example.test';
    const service = new IdentityService(db, { instanceId: randomUUID(), allowedOrigin: origin,
        encryptionKey: randomBytes(32), requireMfa: false }, contracts.ownerPermissions);
    let app;
    const jar = new Map();
    const call = async (server, path, body) => {
        const response = await fetch(server + '/api/v1/' + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Origin: origin, 'Content-Type': 'application/json',
                Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        for (const value of response.headers.getSetCookie()) {
            const pair = value.split(';', 1)[0];
            const index = pair.indexOf('=');
            jar.set(pair.slice(0, index), pair.slice(index + 1));
        }
        return { status: response.status, body: response.status === 204 ? null : await response.json() };
    };
    try {
        await service.initialize();
        const ownerRole = await db.adminRole.findFirst({ where: { kind: 'owner' } });
        assert.ok(ownerRole, '初始化后应存在 owner 角色');
        const encoder = await passwordHash('test-password-1');
        await db.adminUser.create({ data: { email: 'owner', displayName: '店主', locale: 'zh-HK',
                passwordHash: encoder, mfaRequired: false, roles: { create: { roleId: ownerRole.id } } } });
        // 只有订单权限的岗位：能看工作台，但售后与库存两块应为 null。
        const orderRole = await db.adminRole.create({ data: { name: '只看订单', kind: 'custom', description: '测试用',
                permissionCodes: ['orders.read'] } });
        await db.adminUser.create({ data: { email: 'orders-only', displayName: '订单岗', locale: 'zh-HK',
                passwordHash: encoder, mfaRequired: false, roles: { create: { roleId: orderRole.id } } } });
        // 完全没有订单权限的岗位：连工作台都不该开。
        const reportRole = await db.adminRole.create({ data: { name: '只看报表', kind: 'custom', description: '测试用',
                permissionCodes: ['reports.view'] } });
        await db.adminUser.create({ data: { email: 'reports-only', displayName: '报表岗', locale: 'zh-HK',
                passwordHash: encoder, mfaRequired: false, roles: { create: { roleId: reportRole.id } } } });
        app = await createApp(service);
        await app.listen(0, '127.0.0.1');
        const url = await app.getUrl();
        await t.test('店主拿到全部计数块', async () => {
            jar.clear();
            assert.equal((await call(url, 'admin/auth/login', { email: 'owner', password: 'test-password-1' })).status, 200);
            const result = await call(url, 'admin/workbench');
            assert.equal(result.status, 200);
            const data = result.body.data;
            assert.equal(typeof data.orders.awaitingConfirmation, 'number');
            assert.equal(typeof data.orders.awaitingDispatch, 'number');
            assert.equal(typeof data.orders.prepaidUnsettled, 'number');
            assert.equal(typeof data.aftersales.open, 'number');
            assert.equal(typeof data.inventory.lowStock, 'number');
            assert.ok(Array.isArray(data.recentOrders));
            assert.ok(!Number.isNaN(Date.parse(data.generatedAt)));
        });
        await t.test('只有订单权限时，售后与库存返回 null 而不是 0', async () => {
            jar.clear();
            assert.equal((await call(url, 'admin/auth/login', { email: 'orders-only', password: 'test-password-1' })).status, 200);
            const result = await call(url, 'admin/workbench');
            assert.equal(result.status, 200);
            assert.equal(result.body.data.aftersales, null);
            assert.equal(result.body.data.inventory, null);
            assert.equal(typeof result.body.data.orders.awaitingDispatch, 'number');
        });
        await t.test('没有订单读取权限的角色被 403 拦下', async () => {
            jar.clear();
            assert.equal((await call(url, 'admin/auth/login', { email: 'reports-only', password: 'test-password-1' })).status, 200);
            const result = await call(url, 'admin/workbench');
            assert.equal(result.status, 403);
        });
        await t.test('未登录访问是 401', async () => {
            jar.clear();
            assert.equal((await call(url, 'admin/workbench')).status, 401);
        });
    }
    finally {
        if (app)
            await app.close();
        await db.$disconnect();
        await cluster.stop();
    }
});
