import { createHash, randomUUID } from 'node:crypto';
import { anonymizedDisplayName, MARKETING_CONSENT_CHANNELS, PRIVACY_DISPOSITION_RULE_VERSION, } from '../../../../packages/domain/src/privacy.js';
/**
 * 隐私请求的数据处置（M10 批次八A）。
 *
 * 这里只做事务内的改写与快照，不碰权限和审计——那两件事留在 service 层，
 * 保证「谁做的、为什么」与现有的隐私处理历史来自同一份审计日志。
 * 交易事实（订单、支付、积分流水）一律不删：匿名化抹掉的是可识别资料，不是账。
 */
export async function withdrawMarketingInTx(tx, customerId, source, evidenceRef, now) {
    for (const channel of MARKETING_CONSENT_CHANNELS) {
        await tx.customerConsent.upsert({
            where: { customerId_channel_purpose: { customerId, channel, purpose: 'marketing' } },
            create: { id: randomId(), customerId, channel, purpose: 'marketing', status: 'withdrawn',
                source, evidenceRef, createdAt: now, updatedAt: now },
            update: { status: 'withdrawn', source, evidenceRef, updatedAt: now },
        });
    }
}
/** 匿名化：抹掉联系方式与自填资料、撤销会话、销毁导出工件，交易流水不动。 */
export async function anonymizeCustomerInTx(tx, customerId, retentionRef, now) {
    await tx.customer.update({ where: { id: customerId }, data: {
            displayName: anonymizedDisplayName(customerId), emailNormalized: null, phone: null,
            tags: [], internalNote: null, status: 'anonymized', version: { increment: 1 }, updatedAt: now,
        } });
    const member = await tx.memberProfile.findUnique({ where: { customerId } });
    if (member) {
        await tx.memberProfile.update({ where: { id: member.id }, data: {
                status: 'closed', consentRef: `withdrawn:${now.toISOString()}`,
                version: { increment: 1 }, updatedAt: now,
            } });
        await tx.memberSession.updateMany({ where: { memberId: member.id, status: 'active' },
            data: { status: 'revoked', revokedAt: now, updatedAt: now } });
    }
    await tx.customerDataExportJob.updateMany({ where: { customerId, status: 'ready' }, data: {
            status: 'revoked', encryptedPayload: null, revokedAt: now,
        } });
    await withdrawMarketingInTx(tx, customerId, 'privacy-anonymization', retentionRef, now);
}
/**
 * 导出快照：只取与请求相关的可识别资料与交易摘要，不把通知密文、会话摘要或支付凭据带出去。
 * 金额里的 BigInt 转字符串，避免 JSON.stringify 直接抛错，也避免精度在前端丢掉。
 */
export async function buildExportSnapshot(tx, customerId, requestNumber, now) {
    const [customer, member, consents] = await Promise.all([
        tx.customer.findUniqueOrThrow({ where: { id: customerId } }),
        tx.memberProfile.findUnique({ where: { customerId }, include: { tier: true } }),
        tx.customerConsent.findMany({ where: { customerId }, orderBy: [{ channel: 'asc' }, { purpose: 'asc' }] }),
    ]);
    const [account, ledger, links] = member ? await Promise.all([
        tx.pointAccount.findUnique({ where: { memberId: member.id } }),
        tx.pointLedger.findMany({ where: { memberId: member.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1_000 }),
        tx.orderMemberLink.findMany({ where: { memberId: member.id }, orderBy: { linkedAt: 'desc' },
            take: 500, include: { order: true } }),
    ]) : [null, [], []];
    const snapshot = {
        schemaVersion: PRIVACY_DISPOSITION_RULE_VERSION,
        requestNumber, generatedAt: now.toISOString(),
        customer: { id: customer.id, displayName: customer.displayName, email: customer.emailNormalized,
            phone: customer.phone, tags: customer.tags, status: customer.status, internalNote: customer.internalNote,
            createdAt: customer.createdAt.toISOString(), updatedAt: customer.updatedAt.toISOString() },
        member: member ? { id: member.id, memberNo: member.memberNo, status: member.status,
            consentRef: member.consentRef, joinedAt: member.joinedAt.toISOString(),
            tier: member.tier ? { code: member.tier.code, rank: member.tier.rank } : null } : null,
        loyalty: { account: account ? { balance: account.balance, status: account.status,
                version: account.version } : null,
            ledger: ledger.map(entry => ({ id: entry.id, deltaPoints: entry.deltaPoints, balanceAfter: entry.balanceAfter,
                entryType: entry.entryType, sourceType: entry.sourceType, reasonCode: entry.reasonCode,
                createdAt: entry.createdAt.toISOString(), expiresAt: entry.expiresAt?.toISOString() ?? null })) },
        orders: links.map(link => ({ orderNumber: link.order.publicOrderNumber, orderStatus: link.order.orderStatus,
            paymentStatus: link.order.paymentStatus, fulfillmentStatus: link.order.fulfillmentStatus,
            currency: link.order.currency, totalMinor: link.order.totalMinor, placedAt: link.order.placedAt.toISOString(),
            linkedAt: link.linkedAt.toISOString(), linkSource: link.source })),
        consents: consents.map(consent => ({ channel: consent.channel, purpose: consent.purpose,
            status: consent.status, source: consent.source, evidenceRef: consent.evidenceRef,
            updatedAt: consent.updatedAt.toISOString() })),
    };
    const text = JSON.stringify(snapshot, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2);
    return { text, sha256: createHash('sha256').update(text).digest('hex'), byteSize: Buffer.byteLength(text) };
}
/** 工件行 id 同时是 AES-GCM 的 AAD 一部分：快照被挪到另一行就解不开。 */
function randomId() {
    return randomUUID();
}
