import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { csrf, totp } from '../apps/api/src/identity/crypto.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { memberNumber } from '../packages/domain/src/members.js';
import { testPostgres } from './helpers/postgres.js';
test('privacy: acceptance, identity verification and the approval trail', { timeout: 300_000 }, async (t) => {
    const cluster = await testPostgres();
    const db = connectDatabase(cluster.url);
    const contracts = new IdentityContracts();
    const origin = 'https://shop.example.test';
    const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
        bootstrapToken: randomBytes(32).toString('base64url') };
    const identity = new IdentityService(db, config, contracts.ownerPermissions);
    const owner = { email: 'owner@privacy.test', displayName: 'Owner', password: 'A-long-test-password-1', locale: 'en' };
    let app;
    let base = '';
    const jar = new Map();
    let adminCsrf = '';
    const request = async (method, path, body, headers, schema) => {
        const response = await fetch(base + '/api/v1/' + path, { method,
            headers: { 'Content-Type': 'application/json', Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        for (const value of response.headers.getSetCookie()) {
            const pair = value.split(';', 1)[0];
            const index = pair.indexOf('=');
            const key = pair.slice(0, index);
            const token = pair.slice(index + 1);
            if (token)
                jar.set(key, token);
            else
                jar.delete(key);
        }
        const data = response.status === 204 ? null : await response.json();
        if (response.status >= 400)
            contracts.assert('ErrorEnvelope', data);
        else if (schema && response.status !== 204)
            contracts.assert(schema, data);
        return { status: response.status, body: data, response };
    };
    const admin = (method, path, body, schema = 'SuccessEnvelope') => request(method, path, body, { Origin: origin, 'X-CSRF-Token': adminCsrf }, schema);
    const adminIf = (method, path, body, ifMatch, schema = 'SuccessEnvelope') => request(method, path, body, { Origin: origin, 'X-CSRF-Token': adminCsrf, 'If-Match': ifMatch }, schema);
    const decide = (id, key, body) => request('POST', `admin/privacy-requests/${id}/complete`, body, { Origin: origin, 'X-CSRF-Token': adminCsrf, 'Idempotency-Key': key }, 'SuccessEnvelope');
    const verify = (id, key, body) => request('POST', `admin/privacy-requests/${id}/verify`, body, { Origin: origin, 'X-CSRF-Token': adminCsrf, 'Idempotency-Key': key }, 'PrivacyRequestEnvelope');
    /** 只有指定权限的员工会话：用来证明「能读队列」不等于「能核验」或「能批准」。 */
    const sessionFor = async (permissions) => {
        const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
        const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@privacy.test`, displayName: 'Staff',
                passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
        await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
        const token = randomBytes(32).toString('base64url');
        const csrfToken = csrf(token, config);
        await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
                lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
                absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
        return (method, path, body, headers = {}) => request(method, path, body, { Origin: origin, 'X-CSRF-Token': csrfToken, Cookie: `ez_admin_session=${token}`,
            ...headers }, 'SuccessEnvelope');
    };
    const accept = async (overrides = {}) => {
        const created = await admin('POST', 'admin/privacy-requests', { requestType: 'access', sourceChannel: 'email',
            customerRef: 'chan@example.com', scope: ['profile', 'orders'], ...overrides }, 'PrivacyRequestEnvelope');
        assert.equal(created.status, 201, JSON.stringify(created.body));
        return created.body.data;
    };
    let keyCounter = 0;
    const nextKey = () => `privacy-test-key-${randomUUID()}-${(keyCounter += 1)}`;
    try {
        await identity.initialize();
        app = await createApp(identity);
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();
        const bootstrap = await request('POST', 'admin/auth/bootstrap', owner, { Origin: origin, 'X-Bootstrap-Token': config.bootstrapToken });
        assert.equal(bootstrap.status, 202);
        const challengeId = bootstrap.body.data.challengeId;
        const enrollment = await request('POST', 'admin/auth/mfa/enrollments', { challengeId }, { Origin: origin });
        const confirmed = await request('POST', 'admin/auth/mfa/enrollments/confirm', { challengeId,
            enrollmentId: enrollment.body.data.enrollmentId, code: totp(enrollment.body.data.totpSecret, owner.email).generate() }, { Origin: origin });
        assert.equal(confirmed.status, 200);
        adminCsrf = confirmed.body.data.session.csrfToken;
        // 队列要读店铺口径；没有 StoreConfig 时服务端用默认值，与会员模块一致。
        await db.storeConfig.create({ data: { id: 1, displayName: 'Privacy Store', locales: ['zh-CN', 'zh-HK', 'en'],
                defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
    }
    catch (error) {
        if (app)
            await app.close();
        await identity.onModuleDestroy().catch(() => { });
        await cluster.stop();
        throw error;
    }
    try {
        let firstId = '';
        let customerId = '';
        await t.test('the queue starts empty with a 30-day default and needs its own permission', async () => {
            const queue = await admin('GET', 'admin/privacy-requests');
            assert.equal(queue.status, 200);
            assert.deepEqual(queue.body.data.items, []);
            assert.deepEqual(queue.body.data.summary, { open: 0, overdue: 0 });
            assert.equal(queue.body.data.settings.dueDays, 30);
            assert.equal(queue.body.data.settings.version, 1);
            // 会员管理的权限不能顺带看别人的资料请求。
            assert.equal((await (await sessionFor(['members.manage']))('GET', 'admin/privacy-requests')).status, 403);
            const created = await accept();
            firstId = created.id;
            assert.match(created.requestNumber, /^PR-[0-9]{8}-[0-9]{4}$/);
            assert.equal(created.status, 'received');
            assert.equal(created.verificationState, 'pending');
            assert.equal(created.customerRef, 'chan@example.com');
            assert.deepEqual(created.scope, ['profile', 'orders']);
            assert.equal(created.owner.displayName, 'Owner');
            // 到期是受理时的快照：默认 30 天。
            assert.equal(new Date(created.dueAt).getTime() - new Date(created.receivedAt).getTime(), 30 * 86_400_000);
            assert.equal(created.overdueDays, 0);
            // 只读角色不能受理新请求。
            assert.equal((await (await sessionFor(['privacy.read']))('POST', 'admin/privacy-requests', { requestType: 'access', sourceChannel: 'email', scope: [] })).status, 403);
        });
        await t.test('nothing can be approved or completed before identity is verified', async () => {
            const opened = await accept({ requestType: 'export' });
            const blocked = await decide(opened.id, nextKey(), { decision: 'approved', reason: 'Looks fine' });
            assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
            assert.equal(blocked.body.error.code, 'PRIVACY_VERIFICATION_REQUIRED');
            assert.equal((await decide(opened.id, nextKey(), { decision: 'completed', reason: 'Delivered' })).status, 409);
            // 拒绝不是处置：未核验也能结案，而且不会留下「已核验」的假记录。
            const rejected = await decide(opened.id, nextKey(), { decision: 'rejected', reason: 'Not about this store' });
            assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
            assert.equal(rejected.body.data.status, 'rejected');
            assert.equal(rejected.body.data.verificationState, 'pending');
            assert.equal(rejected.body.data.verifiedAt, null);
            assert.equal(rejected.body.data.reviewer.displayName, 'Owner');
            // 终态不接受第二次决定。
            const again = await decide(opened.id, nextKey(), { decision: 'approved', reason: 'Second thoughts' });
            assert.equal(again.status, 409);
            assert.equal(again.body.error.code, 'PRIVACY_STATUS_CONFLICT');
        });
        await t.test('verification records the identity once and cannot be replayed into two records', async () => {
            const opened = await accept({ requestType: 'correct' });
            const customer = await admin('POST', 'admin/customers', { displayName: 'Chan Tai Man', email: 'chan@example.com' });
            assert.equal(customer.status, 201, JSON.stringify(customer.body));
            customerId = customer.body.data.id;
            // 只有 privacy.read 的账号不能核验身份。
            assert.equal((await (await sessionFor(['privacy.read', 'privacy.manage']))('POST', `admin/privacy-requests/${opened.id}/verify`, { verificationMethod: 'email_reply', evidenceRef: 'ticket-1', reason: 'x' }, { 'Idempotency-Key': nextKey() })).status, 403);
            const key = nextKey();
            const verified = await verify(opened.id, key, { verificationMethod: 'email_reply', evidenceRef: 'ticket-1',
                reason: 'Replied from the mailbox on file', customerId });
            assert.equal(verified.status, 200, JSON.stringify(verified.body));
            assert.equal(verified.body.data.status, 'verified');
            assert.equal(verified.body.data.verificationState, 'verified');
            assert.equal(verified.body.data.verificationMethod, 'email_reply');
            assert.equal(verified.body.data.customerId, customerId);
            assert.equal(verified.body.data.customerName, 'Chan Tai Man');
            assert.equal(verified.body.data.verifier.displayName, 'Owner');
            assert.ok(verified.body.data.verifiedAt);
            // 同一把键重放：原样返回，不会把版本推高或换掉核验人。
            const replay = await verify(opened.id, key, { verificationMethod: 'email_reply', evidenceRef: 'ticket-1',
                reason: 'Replied from the mailbox on file', customerId });
            assert.equal(replay.status, 200);
            assert.equal(replay.body.data.version, verified.body.data.version);
            // 换一把键再核验一次：身份只能核验一次，重复核验要么是重试要么是流程错。
            const twice = await verify(opened.id, nextKey(), { verificationMethod: 'phone_call', evidenceRef: 'ticket-2', reason: 'Again' });
            assert.equal(twice.status, 409);
            assert.equal(twice.body.error.code, 'PRIVACY_ALREADY_VERIFIED');
            // 不存在的顾客不能凭空关联。
            const other = await accept({ requestType: 'access' });
            const unknown = await verify(other.id, nextKey(), { verificationMethod: 'email_reply', evidenceRef: 'ticket-3',
                reason: 'x', customerId: randomUUID() });
            assert.equal(unknown.status, 422);
            assert.equal(unknown.body.error.code, 'PRIVACY_CUSTOMER_NOT_FOUND');
            // 同一把幂等键用在另一条请求上：409，而不是「两次都成功」。
            const reused = await verify(other.id, key, { verificationMethod: 'email_reply', evidenceRef: 'ticket-4', reason: 'x' });
            assert.equal(reused.status, 409, JSON.stringify(reused.body));
            assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
        });
        await t.test('a completed deletion must point at the retention rule it kept data under', async () => {
            const opened = await accept({ requestType: 'delete' });
            await verify(opened.id, nextKey(), { verificationMethod: 'email_reply', evidenceRef: 'ticket-5', reason: 'Verified' });
            const missing = await decide(opened.id, nextKey(), { decision: 'completed', reason: 'Profile removed' });
            assert.equal(missing.status, 422, JSON.stringify(missing.body));
            assert.equal(missing.body.error.code, 'PRIVACY_RETENTION_EXCEPTION_REQUIRED');
            const stored = await decide(opened.id, nextKey(), { decision: 'completed', reason: 'Profile removed, orders kept',
                retentionExceptionRef: 'retention-v1#order-history' });
            assert.equal(stored.status, 200, JSON.stringify(stored.body));
            assert.equal(stored.body.data.status, 'completed');
            assert.equal(stored.body.data.retentionExceptionRef, 'retention-v1#order-history');
            assert.ok(stored.body.data.completedAt);
        });
        await t.test('approval and completion are two steps, each recorded with its reviewer', async () => {
            const opened = await accept({ requestType: 'access' });
            await verify(opened.id, nextKey(), { verificationMethod: 'email_reply', evidenceRef: 'ticket-6', reason: 'Verified' });
            const approved = await decide(opened.id, nextKey(), { decision: 'approved', reason: 'Data prepared for delivery' });
            assert.equal(approved.status, 200, JSON.stringify(approved.body));
            assert.equal(approved.body.data.status, 'approved');
            assert.equal(approved.body.data.completedAt, null);
            // 已批准不能再改判为拒绝：要么完成，要么停在待执行。
            assert.equal((await decide(opened.id, nextKey(), { decision: 'rejected', reason: 'Changed mind' })).status, 409);
            // 另一个只有 privacy.process 的员工完成它：批准人与执行人分开记录。
            const worker = await sessionFor(['privacy.read', 'privacy.process']);
            const done = await worker('POST', `admin/privacy-requests/${opened.id}/complete`, { decision: 'completed',
                reason: 'Delivered as a password-protected PDF' }, { 'Idempotency-Key': nextKey() });
            assert.equal(done.status, 200, JSON.stringify(done.body));
            assert.equal(done.body.data.status, 'completed');
            assert.equal(done.body.data.reviewer.displayName, 'Staff');
        });
        await t.test('the due date is a snapshot while the setting moves forward', async () => {
            const before = await admin('GET', 'admin/privacy-requests?limit=100');
            const existing = before.body.data.items.find((item) => item.id === firstId);
            assert.ok(existing);
            const originalDue = existing.dueAt;
            assert.equal((await admin('PATCH', 'admin/privacy-settings', { dueDays: 14 })).status, 422);
            const shortened = await adminIf('PATCH', 'admin/privacy-settings', { dueDays: 14 }, '"1"');
            assert.equal(shortened.status, 200, JSON.stringify(shortened.body));
            assert.equal(shortened.body.data.dueDays, 14);
            assert.equal(shortened.body.data.version, 2);
            assert.equal(shortened.response.headers.get('etag'), '"2"');
            assert.equal((await adminIf('PATCH', 'admin/privacy-settings', { dueDays: 7 }, '"1"')).status, 409);
            const fresh = await accept({ requestType: 'access' });
            assert.equal(new Date(fresh.dueAt).getTime() - new Date(fresh.receivedAt).getTime(), 14 * 86_400_000);
            // 已经受理的请求保留它自己的到期日：改口径只影响新请求。
            const still = await admin('GET', `admin/privacy-requests/${firstId}`);
            assert.equal(still.body.data.dueAt, originalDue);
            assert.equal((await admin('GET', 'admin/privacy-requests')).body.data.settings.dueDays, 14);
        });
        await t.test('extensions and reassignment need a reason and the version just read', async () => {
            const opened = await accept({ requestType: 'access' });
            const detail = await admin('GET', `admin/privacy-requests/${opened.id}`);
            const version = detail.body.data.version;
            const receivedAt = new Date(detail.body.data.receivedAt).getTime();
            const ownerRow = await db.adminUser.findFirstOrThrow({ where: { email: owner.email } });
            assert.equal((await adminIf('PATCH', `admin/privacy-requests/${opened.id}`, { dueAt: new Date(receivedAt + 20 * 86_400_000).toISOString(), reason: 'Customer asked for more time' }, `"${version + 5}"`)).status, 409);
            // 没有理由的改动不收：队列上的每个日期变化都要能回答「为什么」。
            assert.equal((await adminIf('PATCH', `admin/privacy-requests/${opened.id}`, { dueAt: new Date(receivedAt + 20 * 86_400_000).toISOString() }, `"${version}"`)).status, 422);
            // 改到受理之前等于伪造「一直没处理」。
            assert.equal((await adminIf('PATCH', `admin/privacy-requests/${opened.id}`, { dueAt: new Date(receivedAt - 86_400_000).toISOString(), reason: 'Backdating' }, `"${version}"`)).status, 422);
            const extended = await adminIf('PATCH', `admin/privacy-requests/${opened.id}`, { ownerId: ownerRow.id, dueAt: new Date(receivedAt + 20 * 86_400_000).toISOString(), reason: 'Customer asked for more time' }, `"${version}"`);
            assert.equal(extended.status, 200, JSON.stringify(extended.body));
            assert.equal(extended.body.data.version, version + 1);
            assert.equal(new Date(extended.body.data.dueAt).getTime(), receivedAt + 20 * 86_400_000);
            assert.equal(extended.response.headers.get('etag'), `"${version + 1}"`);
        });
        await t.test('the queue is ordered by deadline and counts what is overdue', async () => {
            // 直接改库模拟时间流逝：受理在 40 天前、到期在 10 天前，仍然满足 dueAt > receivedAt。
            await db.customerPrivacyRequest.update({ where: { id: firstId },
                data: { receivedAt: new Date(Date.now() - 40 * 86_400_000), dueAt: new Date(Date.now() - 10 * 86_400_000) } });
            const queue = await admin('GET', 'admin/privacy-requests?limit=100');
            assert.equal(queue.status, 200);
            const ids = queue.body.data.items.map((item) => item.id);
            assert.equal(ids[0], firstId, 'the request past its deadline comes first');
            const late = queue.body.data.items[0];
            assert.ok(late.overdueDays >= 10, `overdueDays ${late.overdueDays}`);
            assert.ok(queue.body.data.summary.overdue >= 1);
            assert.ok(queue.body.data.summary.open >= 1);
            const onlyLate = await admin('GET', 'admin/privacy-requests?overdue=true&limit=100');
            assert.deepEqual(onlyLate.body.data.items.map((item) => item.id), [firstId]);
            const completed = await admin('GET', 'admin/privacy-requests?status=completed&limit=100');
            assert.ok(completed.body.data.items.every((item) => item.status === 'completed'));
            assert.equal((await admin('GET', 'admin/privacy-requests?status=nowhere')).status, 422);
            assert.equal((await admin('GET', 'admin/privacy-requests?overdue=maybe')).status, 422);
        });
        await t.test('the detail response is the audit trail, without leaking what the caller cannot see', async () => {
            const opened = await accept({ requestType: 'access' });
            await verify(opened.id, nextKey(), { verificationMethod: 'email_reply', evidenceRef: 'ticket-7', reason: 'Verified',
                customerId });
            const detail = await admin('GET', `admin/privacy-requests/${opened.id}`);
            assert.equal(detail.status, 200);
            const actions = detail.body.data.history.map((entry) => entry.action).sort();
            assert.deepEqual(actions, ['privacy.request.created', 'privacy.request.verified']);
            assert.deepEqual([...new Set(detail.body.data.history.map((entry) => entry.actorName))], ['Owner']);
            const verifiedEntry = detail.body.data.history.find((entry) => entry.action === 'privacy.request.verified');
            assert.equal(verifiedEntry.reason, 'Verified');
            assert.equal(detail.body.data.customerName, 'Chan Tai Man');
            // 有 privacy.read 但没有 customers.read_masked：队列可读，顾客姓名不返回。
            const reader = await sessionFor(['privacy.read']);
            const masked = await reader('GET', `admin/privacy-requests/${opened.id}`);
            assert.equal(masked.status, 200);
            assert.equal(masked.body.data.customerName, null);
            // 自述身份仍然返回：没有它就没人能核验这份请求。
            assert.equal(masked.body.data.customerRef, 'chan@example.com');
            assert.equal((await admin('GET', `admin/privacy-requests/${randomUUID()}`)).status, 404);
            assert.equal((await admin('GET', 'admin/privacy-requests/not-a-uuid')).status, 422);
            // 匿名访问一律 401，不区分「存在」与「不存在」。
            assert.equal((await request('GET', 'admin/privacy-requests', undefined, { Cookie: '' })).status, 401);
        });
        await t.test('an export is encrypted at rest and only the processing role can download it', async () => {
            const memberNo = memberNumber('20261117', randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase());
            await db.memberProfile.create({ data: { customerId, memberNo, consentRef: 'consent-v1',
                    joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date() } });
            const account = await db.pointAccount.create({ data: { memberId: (await db.memberProfile.findUniqueOrThrow({
                        where: { customerId }
                    })).id, balance: 250, createdAt: new Date(), updatedAt: new Date() } });
            const opened = await accept({ requestType: 'export' });
            await verify(opened.id, nextKey(), { verificationMethod: 'email_reply', evidenceRef: 'ticket-export', reason: 'Verified', customerId });
            const reader = await sessionFor(['privacy.read']);
            assert.equal((await reader('POST', `admin/privacy-requests/${opened.id}/export`, {}, { 'Idempotency-Key': nextKey() })).status, 403);
            const created = await request('POST', `admin/privacy-requests/${opened.id}/export`, {}, { Origin: origin, 'X-CSRF-Token': adminCsrf, 'Idempotency-Key': nextKey() }, 'PrivacyExportEnvelope');
            assert.equal(created.status, 201, JSON.stringify(created.body));
            const job = created.body.data;
            assert.equal(job.status, 'ready');
            const stored = await db.customerDataExportJob.findUniqueOrThrow({ where: { id: job.id } });
            assert.ok(stored.encryptedPayload && !stored.encryptedPayload.includes('chan@example.com'), '收件人明文不得落库');
            assert.equal(stored.sha256, job.sha256);
            assert.equal((await request('GET', `admin/privacy-requests/${opened.id}/export/${randomUUID()}`, undefined, { Origin: origin }, 'ErrorEnvelope')).status, 404);
            const downloaded = await request('GET', `admin/privacy-requests/${opened.id}/export/${job.id}`, undefined, { Origin: origin }, 'PrivacyExportArtifact');
            assert.equal(downloaded.status, 200, JSON.stringify(downloaded.body));
            assert.equal(downloaded.response.headers.get('content-disposition'), `attachment; filename="${opened.requestNumber}.json"`);
            assert.equal(downloaded.body.customer.email, 'chan@example.com');
            assert.equal(downloaded.body.member.memberNo, memberNo);
            assert.equal(downloaded.body.loyalty.account.balance, 250);
            assert.deepEqual(downloaded.body.orders, []);
            assert.ok(await db.auditLog.findFirst({ where: { action: 'privacy.export.downloaded', objectId: opened.id } }));
            // 删除请求不该产出第二份副本。
            const removal = await accept({ requestType: 'delete' });
            await verify(removal.id, nextKey(), { verificationMethod: 'email_reply', evidenceRef: 'ticket-export-deny', reason: 'Verified', customerId });
            const denied = await request('POST', `admin/privacy-requests/${removal.id}/export`, {}, { Origin: origin, 'X-CSRF-Token': adminCsrf, 'Idempotency-Key': nextKey() }, 'ErrorEnvelope');
            assert.equal(denied.status, 422);
            assert.equal(denied.body.error.code, 'PRIVACY_EXPORT_NOT_ALLOWED');
            assert.ok(account);
        });
        await t.test('completing an anonymization rewrites the customer and keeps the audit trail', async () => {
            const customer = await admin('POST', 'admin/customers', { displayName: 'To Be Anonymous',
                email: 'anon@example.com', phone: '+85291234567', internalNote: 'VIP', tags: ['vip'] });
            // 顾客接口用的是通用成功信封，这里只需要拿回新顾客 id。
            assert.equal(customer.status, 201, JSON.stringify(customer.body));
            const targetId = customer.body.data.id;
            const member = await db.memberProfile.create({ data: { customerId: targetId,
                    memberNo: memberNumber('20261117', randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()),
                    consentRef: 'consent-v1', joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date() } });
            await db.memberSession.create({ data: { memberId: member.id, tokenDigest: randomBytes(32).toString('hex'),
                    expiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), updatedAt: new Date() } });
            const opened = await accept({ requestType: 'anonymize' });
            await verify(opened.id, nextKey(), { verificationMethod: 'email_reply', evidenceRef: 'ticket-anon', reason: 'Verified', customerId: targetId });
            assert.equal((await decide(opened.id, nextKey(), { decision: 'approved', reason: 'Approved' })).status, 200);
            const done = await decide(opened.id, nextKey(), { decision: 'completed', reason: 'Profile anonymized, orders kept',
                retentionExceptionRef: 'retention-v1#order-history' });
            assert.equal(done.status, 200, JSON.stringify(done.body));
            const after = await db.customer.findUniqueOrThrow({ where: { id: targetId } });
            assert.match(after.displayName, /^Anonymized [0-9a-f]{8}$/);
            assert.equal(after.emailNormalized, null);
            assert.equal(after.phone, null);
            assert.equal(after.internalNote, null);
            assert.deepEqual(after.tags, []);
            assert.equal(after.status, 'anonymized');
            const memberAfter = await db.memberProfile.findUniqueOrThrow({ where: { id: member.id } });
            assert.equal(memberAfter.status, 'closed');
            assert.match(memberAfter.consentRef, /^withdrawn:/);
            assert.equal(await db.memberSession.count({ where: { memberId: member.id, status: 'active' } }), 0);
            const consents = await db.customerConsent.findMany({ where: { customerId: targetId } });
            assert.equal(consents.length, 4);
            assert.ok(consents.every(row => row.status === 'withdrawn'));
            const detail = await admin('GET', `admin/privacy-requests/${opened.id}`, undefined, 'PrivacyRequestEnvelope');
            assert.ok(detail.body.data.history.some((entry) => entry.action === 'privacy.data.anonymized'));
        });
        await t.test('a marketing withdrawal writes structured consent state, not just a note', async () => {
            const customer = await admin('POST', 'admin/customers', { displayName: 'Marketing Fan', email: 'marketing@example.com' });
            assert.equal(customer.status, 201, JSON.stringify(customer.body));
            const targetId = customer.body.data.id;
            const opened = await accept({ requestType: 'withdraw_marketing' });
            await verify(opened.id, nextKey(), { verificationMethod: 'email_reply', evidenceRef: 'ticket-optout', reason: 'Verified', customerId: targetId });
            assert.equal((await decide(opened.id, nextKey(), { decision: 'approved', reason: 'Approved' })).status, 200);
            const done = await decide(opened.id, nextKey(), { decision: 'completed', reason: 'Customer opted out of all marketing' });
            assert.equal(done.status, 200, JSON.stringify(done.body));
            const consents = await db.customerConsent.findMany({ where: { customerId: targetId }, orderBy: { channel: 'asc' } });
            assert.deepEqual(consents.map(row => row.channel), ['email', 'phone', 'push', 'sms']);
            assert.ok(consents.every(row => row.status === 'withdrawn' && row.purpose === 'marketing'));
            assert.ok(await db.auditLog.findFirst({ where: { action: 'privacy.marketing.withdrawn', objectId: opened.id } }));
        });
    }
    finally {
        if (app)
            await app.close();
        await identity.onModuleDestroy().catch(() => { });
        await cluster.stop();
    }
});
