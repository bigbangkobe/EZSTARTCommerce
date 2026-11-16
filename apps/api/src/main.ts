import { createApp } from './app.js';
import { connectDatabase } from '../../../packages/database/src/client.js';
import { identityConfig } from './identity/config.js';
import { IdentityContracts } from './identity/contracts.js';
import { IdentityService } from './identity/service.js';
import type { INestApplication } from '@nestjs/common';

const port = Number(process.env['PORT'] ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid PORT');
const host = process.env['HOST'] ?? '127.0.0.1';
let identity: IdentityService | null = null;
let app: INestApplication | undefined;
try {
  const connection = process.env['DATABASE_URL'];
  if (connection) {
    const config = identityConfig(process.env);
    identity = new IdentityService(connectDatabase(connection), config, new IdentityContracts().ownerPermissions);
  }
  if (identity) await identity.initialize();
  app = await createApp(identity);
  await app.listen(port, host);
  console.log(JSON.stringify({ event: 'api.started', host, port, identityConfigured: identity !== null }));
} catch {
  // Driver/config errors can contain connection details; never send them to ordinary logs.
  console.error(JSON.stringify({ event: 'api.start_failed', code: 'CONFIGURATION_OR_DATABASE_UNAVAILABLE' }));
  if (app) await app.close(); else if (identity) await identity.onModuleDestroy();
  process.exitCode = 1;
}
