import { setTimeout } from 'node:timers/promises';
import { connectDatabase } from '../../../packages/database/src/client.js';
import { identityConfig } from '../../api/src/identity/config.js';
import { IdentityContracts } from '../../api/src/identity/contracts.js';
import { IdentityService } from '../../api/src/identity/service.js';
import { NotificationWorker } from './notifications.js';
import { ContentService } from '../../api/src/content/service.js';
import { mailConfig, SmtpMailSender } from './mail.js';
let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
let db;
try {
    const config = identityConfig(process.env);
    const smtp = mailConfig(process.env);
    if (!process.env['DATABASE_URL'])
        throw new Error('DATABASE_REQUIRED');
    db = connectDatabase(process.env['DATABASE_URL']);
    const identity = new IdentityService(db, { ...config, bootstrapToken: '' }, new IdentityContracts().ownerPermissions);
    await identity.initialize();
    const worker = new NotificationWorker(db, config, new SmtpMailSender(smtp));
    const content = new ContentService(identity);
    console.log(JSON.stringify({ event: 'identity_worker.started' }));
    // 定时发布不需要秒级精度：15 秒一次的轮询足以覆盖「按店铺时区定的整点发布」，又不空转数据库。
    let nextContentCheck = 0;
    while (!stopping) {
        try {
            const delivered = await worker.tick();
            if (Date.now() >= nextContentCheck) {
                nextContentCheck = Date.now() + 15_000;
                await content.publishDue(new Date());
            }
            if (!delivered)
                await setTimeout(1000);
        }
        catch {
            console.error(JSON.stringify({ event: 'identity_worker.tick_failed', code: 'WORKER_OPERATION_FAILED' }));
            await setTimeout(5000);
        }
    }
}
catch {
    console.error(JSON.stringify({ event: 'identity_worker.start_failed', code: 'CONFIGURATION_OR_DATABASE_UNAVAILABLE' }));
    process.exitCode = 1;
}
finally {
    await db?.$disconnect();
}
