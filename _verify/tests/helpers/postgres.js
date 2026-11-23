import EmbeddedPostgres from 'embedded-postgres';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { connectDatabase } from '../../packages/database/src/client.js';
const START_DEADLINE_MS = 60_000;
const redact = (text, secrets) => {
    let out = text;
    for (const secret of secrets)
        if (secret)
            out = out.replaceAll(secret, '[redacted]');
    return out;
};
// When the server dies during boot the driver's start promise can stay pending with no live
// handles left (Node would then exit silently with code 0), so keep the timer ref'ed and clear
// it as soon as the real work settles: a hung boot always surfaces as a failure.
const withDeadline = async (work, label) => new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(label)), START_DEADLINE_MS);
    work.then(value => { clearTimeout(timer); resolvePromise(value); }, error => { clearTimeout(timer); rejectPromise(error instanceof Error ? error : new Error(String(error))); });
});
const migrate = (url, secret) => {
    const migrated = spawnSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy',
        '--config', resolve('packages/database/prisma.config.ts')], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', windowsHide: true, timeout: 240_000 });
    if (migrated.status !== 0)
        throw new Error(`Disposable database migration failed: ${redact(migrated.stderr, [secret])}`);
};
const adminBlocked = (detail) => detail.includes('administrative permissions')
    ? `${detail}\n\nPostgreSQL refuses to run under an elevated (administrator) token on Windows. `
        + `Run "pnpm test" from a normal, non-elevated terminal, or point the suite at an existing server `
        + `by setting TEST_DATABASE_URL to a PostgreSQL 18 connection string.`
    : detail;
// When TEST_DATABASE_URL is provided the suite runs against that server instead of the embedded
// one: every call provisions a disposable database on it so files stay isolated.
async function externalCluster() {
    const given = new URL(process.env.TEST_DATABASE_URL);
    const secret = decodeURIComponent(given.password);
    const maintenance = new URL(given.toString());
    maintenance.pathname = '/postgres';
    const name = `ezstart_test_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const admin = connectDatabase(maintenance.toString());
    try {
        await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    }
    finally {
        await admin.$disconnect();
    }
    const url = new URL(given.toString());
    url.pathname = `/${name}`;
    migrate(url.toString(), secret);
    return { url: url.toString(), async stop() {
            const dropper = connectDatabase(maintenance.toString());
            try {
                await dropper.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
            }
            finally {
                await dropper.$disconnect();
            }
        } };
}
export async function testPostgres() {
    if (process.env.TEST_DATABASE_URL)
        return externalCluster();
    // 数据目录放在系统临时目录：仓库目录（尤其 Windows + 实时防护/同步盘）会让 initdb 的
    // bootstrap 阶段卡上数分钟，而临时目录通常已经被排除在扫描之外。
    // 需要固定在别处时用 EZ_TEST_PG_DIR 覆盖；无论哪种，名字必须是 pg-test-<uuid>。
    const workspace = process.env['EZ_TEST_PG_DIR'] ? resolve(process.env['EZ_TEST_PG_DIR']) : resolve(tmpdir(), 'ezstart-pg');
    await mkdir(workspace, { recursive: true });
    const directory = resolve(workspace, `pg-test-${randomUUID()}`);
    const inside = relative(workspace, directory);
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || !/^pg-test-[0-9a-f-]{36}$/.test(inside)) {
        throw new Error('Unsafe test database directory');
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const server = createServer();
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('No local port available');
    const port = address.port;
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    const password = randomBytes(32).toString('base64url');
    const require = createRequire(import.meta.url);
    const names = { win32: 'windows', linux: 'linux', darwin: 'darwin' };
    const binaryPackage = dirname(dirname(require.resolve(`@embedded-postgres/${names[process.platform]}-${process.arch}`)));
    // Reviewed upstream postinstall only restores links inside its native binary distribution.
    const links = JSON.parse(await readFile(resolve(binaryPackage, 'native/pg-symlinks.json'), 'utf8'));
    if (links.length) {
        const result = spawnSync(process.execPath, [resolve(binaryPackage, 'scripts/hydrate-symlinks.js')], { cwd: binaryPackage, windowsHide: true });
        if (result.status !== 0)
            throw new Error('Failed to prepare PostgreSQL native links');
    }
    const logs = [];
    const capture = (value) => { logs.push(String(value)); if (logs.length > 80)
        logs.shift(); };
    const pg = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password, port, persistent: true,
        createPostgresUser: false, authMethod: 'scram-sha-256', initdbFlags: ['--encoding=UTF8', '--locale=C'],
        // Non-UTC server default deliberately catches adapter timestamp normalization bugs.
        postgresFlags: ['-h', '127.0.0.1', '-c', 'timezone=Asia/Shanghai'], onLog: capture, onError: capture });
    const url = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
    try {
        await pg.initialise();
        // pg.start() can hang forever when the server process dies during boot (for example when
        // PostgreSQL refuses to run under an elevated Windows token), so race it against a deadline.
        await withDeadline(pg.start(), `Embedded PostgreSQL did not accept connections within ${START_DEADLINE_MS / 1000}s`);
        const client = pg.getPgClient('postgres', '127.0.0.1');
        await client.connect();
        const version = await client.query('SHOW server_version_num');
        if (Number(version.rows[0].server_version_num) < 180000 || Number(version.rows[0].server_version_num) >= 190000)
            throw new Error('Expected PostgreSQL 18');
        await client.end();
        migrate(url, password);
        return { url, async stop() {
                await pg.stop();
                // The absolute target was checked against the workspace before creating the cluster.
                await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            } };
    }
    catch (error) {
        // The server's final stderr (for example the "administrative permissions" refusal) is
        // delivered after the start promise rejects, so let the log callbacks drain first.
        await new Promise(done => setTimeout(done, 250));
        // EmbeddedPostgres.stop() never settles after a failed start, so bound the cleanup wait;
        // without this the process exits silently with code 0 and the suite reports a false pass.
        await Promise.race([pg.stop().catch(() => { }),
            new Promise(done => setTimeout(done, 5_000))]);
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        const message = error instanceof Error && error.message && error.message !== 'undefined' ? error.message : '';
        const detail = logs.length
            ? `${message ? message + '\n' : ''}Server log tail:\n${logs.join('\n')}`
            : message || String(error);
        throw new Error(adminBlocked(redact(detail, [password])));
    }
}
