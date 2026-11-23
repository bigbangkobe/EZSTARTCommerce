import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBundleComplete, assertNoUnknownPlaceholder, BUNDLE_FILES, checkUpgradeCompatibility, CORE_COMPONENTS, compareVersion, composeProjectName, imageName, parseVersion, planFleetUpgrade, RELEASE_GROUPS, SECRET_ENV_KEYS, } from '../packages/domain/src/deployment.js';
const target = { coreVersion: '0.2.0', themeSchemaVersion: 1, manifestSchemaVersion: 1 };
const record = (over = {}) => ({
    id: 'client-hk-001',
    group: 'pilot',
    coreVersion: '0.1.0',
    themeSchemaVersion: 1,
    manifestSchemaVersion: 1,
    ...over,
});
const code = (fn) => {
    try {
        fn();
    }
    catch (error) {
        return error.code;
    }
    return 'NO_ERROR';
};
test('deployment: project/image names follow existing ezstart-<id> convention', () => {
    assert.equal(composeProjectName('mrinhk'), 'ezstart-mrinhk');
    assert.equal(imageName('mrinhk', 'api'), 'ezstart-mrinhk-api');
    assert.equal(imageName('mrinhk', 'storefront'), 'ezstart-mrinhk-storefront');
    assert.equal(code(() => composeProjectName('Bad_ID')), 'DEPLOYMENT_INSTANCE_ID_INVALID');
    assert.equal(code(() => imageName('mrinhk', 'unknown')), 'DEPLOYMENT_COMPONENT_UNKNOWN');
    assert.deepEqual([...CORE_COMPONENTS], ['api', 'admin', 'worker', 'storefront']);
});
test('deployment: semver parsing and comparison', () => {
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
    assert.ok(compareVersion('0.2.0', '0.1.9') > 0);
    assert.ok(compareVersion('0.1.0', '0.1.0') === 0);
    assert.ok(compareVersion('0.1.0', '0.2.0') < 0);
    assert.equal(code(() => parseVersion('v1')), 'DEPLOYMENT_VERSION_INVALID');
});
test('deployment: compatible forward minor upgrade is allowed', () => {
    const result = checkUpgradeCompatibility(record(), target);
    assert.equal(result.ok, true);
    assert.deepEqual(result.reasons, []);
});
test('deployment: major jump, downgrade and unknown schema are blocked', () => {
    assert.match(checkUpgradeCompatibility(record(), { ...target, coreVersion: '1.0.0' }).reasons.join(' '), /major/);
    assert.match(checkUpgradeCompatibility(record({ coreVersion: '0.3.0' }), target).reasons.join(' '), /回退/);
    assert.match(checkUpgradeCompatibility(record({ manifestSchemaVersion: 99 }), target).reasons.join(' '), /manifest schema/);
    assert.match(checkUpgradeCompatibility(record(), { ...target, manifestSchemaVersion: 99 }).reasons.join(' '), /不受支持/);
});
test('deployment: theme schema bump requires explicit migration review', () => {
    assert.equal(checkUpgradeCompatibility(record(), { ...target, themeSchemaVersion: 2 }).ok, false);
    assert.equal(checkUpgradeCompatibility(record({ themeMigrationReviewed: true }), { ...target, themeSchemaVersion: 2 }).ok, true);
});
test('deployment: fleet plan orders by release group and excludes blocked instances', () => {
    const plan = planFleetUpgrade([
        record({ id: 'shop-standard', group: 'standard' }),
        record({ id: 'shop-pilot', group: 'pilot' }),
        record({ id: 'shop-canary', group: 'canary' }),
        record({ id: 'shop-old', group: 'pilot', coreVersion: '1.0.0' }),
    ], target);
    assert.deepEqual(plan.order, ['shop-pilot', 'shop-canary', 'shop-standard']);
    assert.equal(plan.blockedCount, 1);
    assert.deepEqual(plan.plans[0]?.actions, plan.plans[1]?.actions);
    assert.equal(plan.plans.find((p) => p.id === plan.order[0])?.ok, true);
    assert.equal(plan.plans.find((p) => p.id === 'shop-old')?.ok, false);
    assert.deepEqual([...RELEASE_GROUPS], ['pilot', 'canary', 'standard']);
});
test('deployment: unknown release group is rejected', () => {
    assert.equal(code(() => planFleetUpgrade([record({ group: 'chaos' })], target)), 'DEPLOYMENT_GROUP_UNKNOWN');
});
test('deployment: bundle completeness is exact, no missing or stray files', () => {
    assert.doesNotThrow(() => assertBundleComplete([...BUNDLE_FILES]));
    assert.equal(code(() => assertBundleComplete(BUNDLE_FILES.slice(1))), 'DEPLOYMENT_BUNDLE_INCOMPLETE');
    assert.equal(code(() => assertBundleComplete([...BUNDLE_FILES, 'surprise.txt'])), 'DEPLOYMENT_BUNDLE_UNKNOWN_FILE');
    assert.ok(BUNDLE_FILES.includes('.env.example'));
});
test('deployment: secrets are never part of manifest-driven config', () => {
    assert.ok(SECRET_ENV_KEYS.includes('IDENTITY_ENCRYPTION_KEY'));
    assert.ok(!SECRET_ENV_KEYS.includes('SITE_DOMAIN'));
});
test('deployment: unknown template placeholder fails fast', () => {
    assert.doesNotThrow(() => assertNoUnknownPlaceholder('url: {{SITE_DOMAIN}}'));
    assert.equal(code(() => assertNoUnknownPlaceholder('x: {{EVIL_TOKEN}}')), 'DEPLOYMENT_PLACEHOLDER_UNKNOWN');
});
