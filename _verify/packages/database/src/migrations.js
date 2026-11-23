import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function loadMigrationManifest(directory = resolve('packages/database/migrations')) {
    const entries = await readdir(directory, { withFileTypes: true });
    const manifest = new Map();
    for (const entry of entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const sql = await readFile(resolve(directory, entry.name, 'migration.sql'));
        manifest.set(entry.name, createHash('sha256').update(sql).digest('hex'));
    }
    if (!manifest.size)
        throw new Error('Migration manifest is empty');
    return manifest;
}
// A rollback is historical evidence, not an applied migration. Unknown applied
// migrations indicate an incompatible application version and must fail closed.
export function migrationsMatch(manifest, rows) {
    if (!manifest.size)
        return false;
    const applied = new Map();
    for (const row of rows) {
        if (row.rolled_back_at !== null)
            continue;
        if (row.finished_at === null || applied.has(row.migration_name))
            return false;
        if (manifest.get(row.migration_name) !== row.checksum)
            return false;
        applied.set(row.migration_name, row.checksum);
    }
    return applied.size === manifest.size;
}
