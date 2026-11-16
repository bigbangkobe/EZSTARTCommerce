import EmbeddedPostgres from 'embedded-postgres';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export async function testPostgres() {
  const workspace = resolve('.local-tools');
  await mkdir(workspace, { recursive: true });
  const directory = resolve(workspace, `pg-test-${randomUUID()}`);
  const inside = relative(workspace, directory);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Unsafe test database directory');
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local port available');
  const port = address.port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  const password = randomBytes(32).toString('base64url');
  const require = createRequire(import.meta.url);
  const names: Record<string, string> = { win32: 'windows', linux: 'linux', darwin: 'darwin' };
  const binaryPackage = dirname(dirname(require.resolve(`@embedded-postgres/${names[process.platform]}-${process.arch}`)));
  // Reviewed upstream postinstall only restores links inside its native binary distribution.
  const links = JSON.parse(await readFile(resolve(binaryPackage, 'native/pg-symlinks.json'), 'utf8')) as unknown[];
  if (links.length) {
    const result = spawnSync(process.execPath, [resolve(binaryPackage, 'scripts/hydrate-symlinks.js')], { cwd: binaryPackage, windowsHide: true });
    if (result.status !== 0) throw new Error('Failed to prepare PostgreSQL native links');
  }
  const logs: string[] = [];
  const capture = (value: unknown) => { logs.push(String(value)); if (logs.length > 8) logs.shift(); };
  const pg = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password, port, persistent: true,
    createPostgresUser: false, authMethod: 'scram-sha-256', initdbFlags: ['--encoding=UTF8', '--locale=C'],
    // Non-UTC server default deliberately catches adapter timestamp normalization bugs.
    postgresFlags: ['-h', '127.0.0.1', '-c', 'timezone=Asia/Shanghai'], onLog: capture, onError: capture });
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
  try {
    await pg.initialise();
    await pg.start();
    const client = pg.getPgClient('postgres', '127.0.0.1');
    await client.connect();
    const version = await client.query('SHOW server_version_num');
    if (Number(version.rows[0].server_version_num) < 180000 || Number(version.rows[0].server_version_num) >= 190000) throw new Error('Expected PostgreSQL 18');
    await client.end();
    const migrated = spawnSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy',
      '--config', resolve('packages/database/prisma.config.ts')], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    if (migrated.status !== 0) throw new Error(`Disposable database migration failed: ${migrated.stderr.replaceAll(password, '[redacted]')}`);
    return { url, async stop() {
      await pg.stop();
      // The absolute target was checked against the workspace before creating the cluster.
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } };
  } catch (error) {
    await pg.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const detail = error instanceof Error ? error.message : logs.join('\n');
    throw new Error(detail.replaceAll(password, '[redacted]'));
  }
}
