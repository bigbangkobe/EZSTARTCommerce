import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMigrationManifest, migrationsMatch, type MigrationRecord } from '../packages/database/src/migrations.js';

const manifest = new Map([['identity', 'identity-hash'], ['catalog', 'catalog-hash']]);
function row(name: string, checksum: string): MigrationRecord {
  return { migration_name: name, checksum, finished_at: new Date(), rolled_back_at: null };
}
const identity = row('identity', 'identity-hash');
const catalog = row('catalog', 'catalog-hash');

test('readiness requires every shipped migration with its exact checksum', () => {
  assert.equal(migrationsMatch(manifest, [identity, catalog]), true);
  assert.equal(migrationsMatch(manifest, [identity]), false);
  assert.equal(migrationsMatch(manifest, [identity, row('catalog', 'modified')]), false);
  assert.equal(migrationsMatch(manifest, [identity, catalog, row('future', 'hash')]), false);
  assert.equal(migrationsMatch(manifest, [identity, catalog, catalog]), false);
  assert.equal(migrationsMatch(new Map(), []), false);
});

test('failed migrations block readiness while rolled-back attempts permit a successful retry', () => {
  const failed = { ...catalog, finished_at: null };
  assert.equal(migrationsMatch(manifest, [identity, failed]), false);
  assert.equal(migrationsMatch(manifest, [identity, catalog, failed]), false);
  assert.equal(migrationsMatch(manifest, [identity, { ...failed, rolled_back_at: new Date() }, catalog]), true);
  assert.equal(migrationsMatch(manifest, [identity, { ...catalog, rolled_back_at: new Date() }]), false);
});

test('manifest loads actual shipped SQL migration checksums', async () => {
  const actual = await loadMigrationManifest();
  assert.ok(actual.has('202610190001_identity'));
  for (const checksum of actual.values()) assert.match(checksum, /^[a-f0-9]{64}$/);
  await assert.rejects(loadMigrationManifest('packages/database/migrations/not-present'));
});
