import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { presetPermissions, resolveRolePresets, rolePresets } from '../packages/config/src/role-presets.js';
const known = new IdentityContracts().ownerPermissions;
test('default role presets are a closed, least-privilege projection of the contract', () => {
    const resolved = resolveRolePresets(known);
    assert.equal(resolved.length, 8);
    assert.equal(new Set(resolved.map(preset => preset.key)).size, 8);
    assert.equal(new Set(resolved.map(preset => preset.name)).size, 8);
    assert.deepEqual(resolved.map(preset => preset.key), rolePresets.map(preset => preset.key));
    for (const preset of resolved) {
        assert.ok(preset.permissionCodes.length > 0);
        assert.deepEqual(preset.permissionCodes, [...new Set(preset.permissionCodes)].sort(), `${preset.key} must be deduplicated and sorted`);
        for (const code of preset.permissionCodes)
            assert.ok(known.includes(code), `${preset.key} grants unknown permission ${code}`);
    }
});
test('owner preset always equals the full catalog while every other preset stays narrow', () => {
    const byKey = new Map(resolveRolePresets(known).map(preset => [preset.key, preset]));
    assert.deepEqual(byKey.get('owner').permissionCodes, [...known].sort());
    assert.equal(byKey.get('owner').kind, 'owner');
    assert.equal(byKey.get('admin').kind, 'admin');
    assert.equal(byKey.get('product_ops').kind, 'preset');
    const forbidden = {
        admin: ['staff.read', 'staff.manage', 'roles.manage', 'payment.config', 'refunds.create', 'refund.approve', 'refund.execute',
            'privacy.read', 'privacy.manage', 'privacy.process', 'audit.read', 'data.export', 'instance.backup'],
        product_ops: ['orders.read', 'customers.read_masked', 'payments.read', 'refunds.create', 'staff.manage', 'inventory.adjust', 'content.publish'],
        order_support: ['refunds.create', 'refund.approve', 'refund.execute', 'payment.config', 'staff.manage', 'privacy.read', 'inventory.adjust'],
        finance: ['catalog.write', 'inventory.adjust', 'payment.config', 'staff.manage', 'customers.read_masked', 'data.export'],
        warehouse: ['refunds.create', 'refund.approve', 'payments.read', 'customers.read_masked', 'staff.manage', 'payment.config'],
        reports_readonly: ['orders.read', 'customers.read_masked', 'data.export', 'reports.export'],
        privacy_specialist: ['privacy.manage', 'staff.manage', 'data.export', 'customers.manage'],
    };
    for (const [key, codes] of Object.entries(forbidden)) {
        const granted = new Set(byKey.get(key).permissionCodes);
        for (const code of codes)
            assert.ok(!granted.has(code), `${key} must not grant ${code}`);
    }
    // 财务必须能确权退款，但不能因此拿到生产支付凭证配置；隐私专员处理与审批分权。
    assert.ok(byKey.get('finance').permissionCodes.includes('refund.execute'));
    assert.ok(byKey.get('privacy_specialist').permissionCodes.includes('privacy.process'));
    assert.ok(byKey.get('reports_readonly').permissionCodes.includes('reports.view'));
});
test('a preset that drifts from the contract fails loudly instead of silently narrowing', () => {
    assert.throws(() => resolveRolePresets(known.filter(code => code !== 'privacy.process')), /unknown permission codes: privacy\.process/);
    assert.throws(() => resolveRolePresets(known.filter(code => code !== 'reports.view')), /unknown permission codes: reports\.view/);
    assert.throws(() => resolveRolePresets([]), /Permission catalog is empty/);
    assert.deepEqual(presetPermissions(rolePresets[0], ['b', 'a', 'b']), ['a', 'b']);
});
