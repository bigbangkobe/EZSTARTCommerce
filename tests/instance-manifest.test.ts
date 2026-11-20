import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canLaunch, InstanceManifestError, launchBlockerStatus, LAUNCH_BLOCKERS,
  normalizeInstanceManifest, SUPPORTED_SCHEMA_VERSIONS, unsignedBlockers,
} from '../packages/domain/src/instance-manifest.js';

const validManifest = () => ({
  schemaVersion: 1,
  instance: {
    id: 'client-hk-001', domain: 'shop.example.com', market: 'HK', currency: 'HKD',
    timezone: 'Asia/Hong_Kong', locales: ['zh-HK', 'en'], defaultLocale: 'zh-HK',
  },
  brand: { name: 'IN先生', brandLatin: 'Mr. IN', whatsapp: '85260474794' },
  theme: {
    primaryColor: '#BC002D', inkColor: '#1A1A1A', paperColor: '#F7F5F0',
    fontPair: 'editorial-jp', radius: 16,
  },
  storefront: {
    homeSections: [
      { type: 'hero' },
      { type: 'product_grid', params: { sectionId: 'featured', limit: 6 } },
    ],
    navigation: ['home', 'products', 'contact'],
  },
  business: {
    payment: ['cod', 'approved_gateway'],
    shipping: { regions: ['HK'], freeThreshold: 500 },
    features: { guestCheckout: true, codPayment: true, analyticsEnabled: false },
  },
  compliance: {
    privacyPolicyUrl: 'https://shop.example.com/pages/privacy',
    ageGateRequired: false,
    dataRetentionDays: 365,
    signoffs: Object.fromEntries(LAUNCH_BLOCKERS.map((k) => [k, true])),
  },
  deploy: {
    cloud: { provider: 'aws', region: 'ap-east-1' },
    backup: { frequency: 'daily', retentionDays: 30 },
  },
});

const code = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    if (error instanceof InstanceManifestError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

test('manifest: valid full manifest normalizes and can launch', () => {
  const m = normalizeInstanceManifest(validManifest());
  assert.equal(m.instance.id, 'client-hk-001');
  assert.equal(m.instance.market, 'HK');
  assert.equal(m.theme.primaryColor, '#bc002d'); // 颜色归一化小写
  assert.equal(m.storefront.homeSections.length, 2);
  assert.equal(canLaunch(m), true);
  assert.deepEqual(unsignedBlockers(m), []);
});

test('manifest: schema version closed set rejects unknown', () => {
  assert.deepEqual([...SUPPORTED_SCHEMA_VERSIONS], [1]);
  const input = validManifest() as Record<string, unknown>;
  input.schemaVersion = 99;
  assert.equal(code(() => normalizeInstanceManifest(input)), 'MANIFEST_VERSION_UNSUPPORTED');
});

test('manifest: locale must be supported and unique', () => {
  const bad = validManifest() as Record<string, unknown>;
  (bad.instance as Record<string, unknown>).locales = ['zh-HK', 'fr'];
  assert.equal(code(() => normalizeInstanceManifest(bad)), 'MANIFEST_LOCALE_UNSUPPORTED');

  const dup = validManifest() as Record<string, unknown>;
  (dup.instance as Record<string, unknown>).locales = ['zh-HK', 'zh-HK'];
  assert.equal(code(() => normalizeInstanceManifest(dup)), 'MANIFEST_LOCALE_DUPLICATE');
});

test('manifest: default locale must be within locales', () => {
  const bad = validManifest() as Record<string, unknown>;
  // locales = ['zh-HK','en']，'zh-CN' 是受支持语言但未在本实例启用，不能作为默认语言。
  (bad.instance as Record<string, unknown>).defaultLocale = 'zh-CN';
  assert.equal(code(() => normalizeInstanceManifest(bad)), 'MANIFEST_VALIDATION_ERROR');
});

test('manifest: timezone must be a real IANA zone', () => {
  const bad = validManifest() as Record<string, unknown>;
  (bad.instance as Record<string, unknown>).timezone = 'Mars/Olympus';
  assert.equal(code(() => normalizeInstanceManifest(bad)), 'MANIFEST_TIMEZONE_INVALID');
});

test('manifest: theme color and font are whitelisted', () => {
  const badColor = validManifest() as Record<string, unknown>;
  (badColor.theme as Record<string, unknown>).primaryColor = 'red';
  assert.equal(code(() => normalizeInstanceManifest(badColor)), 'MANIFEST_COLOR_INVALID');

  const badFont = validManifest() as Record<string, unknown>;
  (badFont.theme as Record<string, unknown>).fontPair = 'http://evil/font.css';
  assert.equal(code(() => normalizeInstanceManifest(badFont)), 'MANIFEST_FONT_UNSUPPORTED');
});

test('manifest: home sections are closed set and unique', () => {
  const bad = validManifest() as Record<string, unknown>;
  (bad.storefront as Record<string, unknown>).homeSections = [{ type: 'magic_carousel' }];
  assert.equal(code(() => normalizeInstanceManifest(bad)), 'MANIFEST_SECTION_UNSUPPORTED');

  const dup = validManifest() as Record<string, unknown>;
  (dup.storefront as Record<string, unknown>).homeSections = [{ type: 'hero' }, { type: 'hero' }];
  assert.equal(code(() => normalizeInstanceManifest(dup)), 'MANIFEST_SECTION_DUPLICATE');
});

test('manifest: feature flags closed set', () => {
  const bad = validManifest() as Record<string, unknown>;
  (bad.business as Record<string, unknown>).features = { unknownFlag: true };
  assert.equal(code(() => normalizeInstanceManifest(bad)), 'MANIFEST_FEATURE_UNSUPPORTED');
});

test('manifest: signoff keys closed set', () => {
  const bad = validManifest() as Record<string, unknown>;
  (bad.compliance as Record<string, unknown>).signoffs = { madeUpItem: true };
  assert.equal(code(() => normalizeInstanceManifest(bad)), 'MANIFEST_BLOCKER_UNKNOWN');
});

test('manifest: unsigned blockers stop launch', () => {
  const input = validManifest() as Record<string, unknown>;
  (input.compliance as Record<string, unknown>).signoffs = { paymentAccount: true };
  const m = normalizeInstanceManifest(input);
  assert.equal(canLaunch(m), false);
  const unsigned = unsignedBlockers(m);
  assert.equal(unsigned.length, LAUNCH_BLOCKERS.length - 1);
  assert.ok(!unsigned.includes('paymentAccount'));
  const status = launchBlockerStatus(m);
  assert.equal(status.find((s) => s.key === 'paymentAccount')?.signed, true);
});

test('manifest: missing block is rejected', () => {
  const bad = validManifest() as Record<string, unknown>;
  delete bad.deploy;
  assert.equal(code(() => normalizeInstanceManifest(bad)), 'MANIFEST_VALIDATION_ERROR');
});
