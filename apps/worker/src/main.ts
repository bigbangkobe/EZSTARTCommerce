import { setTimeout } from 'node:timers/promises';
import { connectDatabase } from '../../../packages/database/src/client.js';
import { identityConfig } from '../../api/src/identity/config.js';
import { IdentityContracts } from '../../api/src/identity/contracts.js';
import { IdentityService } from '../../api/src/identity/service.js';
import { NotificationWorker } from './notifications.js';
import { mailConfig, SmtpMailSender } from './mail.js';

let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
let db: ReturnType<typeof connectDatabase> | undefined;
try {
  const config = identityConfig(process.env);
  const smtp = mailConfig(process.env);
  if (!process.env['DATABASE_URL']) throw new Error('DATABASE_REQUIRED');
  db = connectDatabase(process.env['DATABASE_URL']);
  const identity = new IdentityService(db, { ...config, bootstrapToken: '' }, new IdentityContracts().ownerPermissions);
  await identity.initialize();
  const worker = new NotificationWorker(db, config, new SmtpMailSender(smtp));
  console.log(JSON.stringify({ event: 'identity_worker.started' }));
  while (!stopping) {
    try { if (!await worker.tick()) await setTimeout(1000); }
    catch { console.error(JSON.stringify({ event: 'identity_worker.tick_failed', code: 'WORKER_OPERATION_FAILED' })); await setTimeout(5000); }
  }
} catch {
  console.error(JSON.stringify({ event: 'identity_worker.start_failed', code: 'CONFIGURATION_OR_DATABASE_UNAVAILABLE' }));
  process.exitCode = 1;
} finally { await db?.$disconnect(); }
