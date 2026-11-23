import { createHash } from 'node:crypto';
import { adjustmentDedupeKey, adjustmentMovement, assertAdjustmentAllowed, assertInventoryVersion, availableOf, lowStockState, MOVEMENT_TYPES, normalizeAdjustment, normalizeThreshold, InventoryRuleError, } from '../../../../packages/domain/src/inventory.js';
import { AuthError } from '../identity/service.js';
const CONFLICT_CODES = new Set(['VERSION_CONFLICT', 'STATE_CONFLICT', 'INSUFFICIENT_ON_HAND', 'IDEMPOTENCY_CONFLICT']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * 库存（M12）：存量查询、人工调整流水与低库存阈值。
 *
 * 三条不变量：
 * 1. 只有流水能改 onHand：调减不能吃掉已预留的量，也不会出现负数。
 * 2. 每次调整都要版本：读到 version=N 才能改，改完变 N+1；并发调整只有一个成功。
 * 3. 同一 Idempotency-Key 只产生一条流水；换了内容就是冲突，不是重放。
 */
export class InventoryService {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    get db() { return this.identity.db; }
    rule(fn) {
        try {
            return fn();
        }
        catch (error) {
            if (error instanceof InventoryRuleError)
                throw new AuthError(CONFLICT_CODES.has(error.code) ? 409 : 422, error.code);
            throw error;
        }
    }
    async guarded(fn) {
        try {
            return await fn();
        }
        catch (error) {
            const code = error.code;
            if (code === 'P2002')
                throw new AuthError(409, 'STATE_CONFLICT');
            if (code === 'P2003')
                throw new AuthError(422, 'VALIDATION_ERROR');
            if (code === 'P2025')
                throw new AuthError(404, 'NOT_FOUND');
            throw error;
        }
    }
    async lock(tx, key) { await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${key}))::text`; }
    key(value) {
        if (typeof value !== 'string' || value.length < 16 || value.length > 128)
            throw new AuthError(422, 'VALIDATION_ERROR');
        return value;
    }
    stockView(row) {
        const available = availableOf(row.onHand, row.reserved);
        return { variantId: row.variantId, sku: row.sku, productId: row.productId, productName: row.productName,
            productStatus: row.productStatus, variantStatus: row.variantStatus, onHand: row.onHand, reserved: row.reserved,
            available, lowStockLevel: row.lowStockLevel, lowStockVersion: row.lowStockVersion,
            lowStockState: lowStockState(row.onHand, row.reserved, row.lowStockLevel),
            version: row.version, updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date(row.updatedAt).toISOString() };
    }
    movementView(row) {
        return { id: row.id, variantId: row.variantId, type: row.type, quantity: row.quantity, stockDelta: row.stockDelta,
            onHandAfter: row.onHandAfter ?? null, reason: row.reason, reasonCode: row.reasonCode ?? null,
            reference: row.reference ?? null, orderId: row.orderId ?? null, caseId: row.caseId ?? null,
            actorId: row.actorId ?? null, createdAt: row.createdAt.toISOString() };
    }
    thresholdView(row) {
        return { variantId: row.variantId, lowStockLevel: row.lowStockLevel, version: row.version,
            updatedBy: row.updatedBy ?? null, updatedAt: row.updatedAt.toISOString() };
    }
    /** 产品名按店铺默认语言取，没有该语言翻译就回退到任一存在的翻译，再退到 SKU。 */
    async locale(tx) {
        const row = await tx.storeConfig.findUnique({ where: { id: 1 } });
        return row?.defaultLocale ?? 'zh-CN';
    }
    async list(supplied, limit, cursor, filters) {
        const q = filters.q ?? null;
        if (q !== null && (q.length > 80))
            throw new AuthError(422, 'VALIDATION_ERROR');
        const variantId = filters.variantId ?? null;
        if (variantId !== null && !UUID.test(variantId))
            throw new AuthError(422, 'VALIDATION_ERROR');
        if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 64))
            throw new AuthError(422, 'VALIDATION_ERROR');
        return this.identity.withPermission(supplied, null, 'inventory.read', async (tx) => {
            const locale = await this.locale(tx);
            const rows = await tx.$queryRaw `
        SELECT v."id" AS "variantId", v."sku" AS "sku", v."productId" AS "productId",
               v."status" AS "variantStatus", p."status" AS "productStatus",
               COALESCE(i."onHand", 0) AS "onHand", COALESCE(i."reserved", 0) AS "reserved",
               COALESCE(i."version", 0) AS "version", COALESCE(t."lowStockLevel", 0) AS "lowStockLevel",
               COALESCE(t."version", 0) AS "lowStockVersion",
               COALESCE(i."updatedAt", v."updatedAt") AS "updatedAt",
               COALESCE((SELECT tr."name" FROM "ProductTranslation" tr WHERE tr."productId" = v."productId"
                          ORDER BY (tr."locale" = ${locale}) DESC, tr."locale" ASC LIMIT 1), v."sku") AS "productName"
        FROM "ProductVariant" v
        JOIN "Product" p ON p."id" = v."productId"
        LEFT JOIN "InventoryItem" i ON i."variantId" = v."id"
        LEFT JOIN "InventoryThreshold" t ON t."variantId" = v."id"
        WHERE (${cursor}::text IS NULL OR v."sku" > ${cursor}::text)
          AND (${variantId}::uuid IS NULL OR v."id" = ${variantId}::uuid)
          AND (${q}::text IS NULL OR v."sku" ILIKE '%' || ${q}::text || '%'
               OR EXISTS (SELECT 1 FROM "ProductTranslation" tr2 WHERE tr2."productId" = v."productId"
                          AND tr2."name" ILIKE '%' || ${q}::text || '%'))
          AND (${Boolean(filters.lowStock)}::boolean IS FALSE
               OR (COALESCE(i."onHand", 0) - COALESCE(i."reserved", 0)) <= COALESCE(t."lowStockLevel", 0))
        ORDER BY v."sku" ASC
        LIMIT ${limit + 1}`;
            const visible = rows.slice(0, limit);
            const hasMore = rows.length > limit;
            return { items: visible.map(row => this.stockView(row)), hasMore, nextCursor: hasMore ? visible.at(-1).sku : null };
        });
    }
    async movements(supplied, limit, cursor, filters) {
        const type = filters.type ?? null;
        if (type !== null && !MOVEMENT_TYPES.includes(type))
            throw new AuthError(422, 'VALIDATION_ERROR');
        for (const id of [filters.variantId, filters.orderId, filters.caseId]) {
            if (id !== undefined && id !== null && !UUID.test(id))
                throw new AuthError(422, 'VALIDATION_ERROR');
        }
        const range = this.timeRange(filters.from, filters.to);
        return this.identity.withPermission(supplied, null, 'inventory.read', async (tx) => {
            if (cursor && !await tx.inventoryMovement.findUnique({ where: { id: cursor } }))
                throw new AuthError(422, 'VALIDATION_ERROR');
            const rows = await tx.inventoryMovement.findMany({ where: {
                    ...(type ? { type } : {}), ...(filters.variantId ? { variantId: filters.variantId } : {}),
                    ...(filters.orderId ? { orderId: filters.orderId } : {}), ...(filters.caseId ? { caseId: filters.caseId } : {}),
                    ...(range ? { createdAt: range } : {})
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            const visible = rows.slice(0, limit);
            const hasMore = rows.length > limit;
            return { items: visible.map(row => this.movementView(row)), hasMore, nextCursor: hasMore ? visible.at(-1).id : null };
        });
    }
    timeRange(from, to) {
        const parse = (value, label) => {
            if (value === null || value === undefined)
                return null;
            const date = new Date(value);
            if (Number.isNaN(date.getTime()))
                throw new AuthError(422, 'VALIDATION_ERROR');
            if (label === 'from' && !/^\d{4}-\d{2}-\d{2}/.test(value))
                throw new AuthError(422, 'VALIDATION_ERROR');
            return date;
        };
        const start = parse(from, 'from');
        const end = parse(to, 'to');
        if (!start && !end)
            return null;
        if (start && end && start.getTime() > end.getTime())
            throw new AuthError(422, 'VALIDATION_ERROR');
        return { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) };
    }
    /**
     * 人工调整。同一事务内：校验版本、按可售下限校验数量、写流水、推进库存版本。
     * 重放读旧流水；同键不同内容 409。调整不允许把 onHand 设成指定值——只接受增量。
     */
    async adjust(supplied, csrf, idempotencyKey, body, ctx) {
        this.key(idempotencyKey);
        const rawVariantId = typeof body.variantId === 'string' ? body.variantId : '';
        if (!UUID.test(rawVariantId))
            throw new AuthError(422, 'VALIDATION_ERROR');
        const input = this.rule(() => normalizeAdjustment(body, rawVariantId));
        const dedupeKey = this.rule(() => adjustmentDedupeKey(idempotencyKey));
        const digest = createHash('sha256').update(`inventory.adjustment\n${input.variantId}\n${JSON.stringify(body)}`).digest('hex');
        return this.guarded(() => this.identity.withPermission(supplied, csrf, 'inventory.adjust', async (tx, actor, _session, now) => {
            await this.lock(tx, `inventory:${input.variantId}`);
            const replay = await tx.inventoryMovement.findUnique({ where: { dedupeKey } });
            if (replay) {
                if (replay.requestFingerprint !== digest || replay.variantId !== input.variantId) {
                    throw new AuthError(409, 'IDEMPOTENCY_CONFLICT');
                }
                const variant = await tx.productVariant.findUnique({ where: { id: input.variantId }, include: { inventory: true } });
                const item = variant?.inventory ?? null;
                return { ...this.adjustmentResult(replay, item), replay: true, lowStockLevel: await this.levelOf(tx, input.variantId) };
            }
            const variant = await tx.productVariant.findUnique({ where: { id: input.variantId }, include: { inventory: true } });
            if (!variant)
                throw new AuthError(404, 'NOT_FOUND');
            const current = variant.inventory
                ? { onHand: variant.inventory.onHand, reserved: variant.inventory.reserved, version: variant.inventory.version }
                : { onHand: 0, reserved: 0, version: 0 };
            this.rule(() => assertInventoryVersion(input.expectedVersion, current.version));
            const onHandAfter = this.rule(() => assertAdjustmentAllowed(current, input.delta));
            const shape = this.rule(() => adjustmentMovement(input.delta, onHandAfter));
            let version;
            if (!variant.inventory) {
                const created = await tx.inventoryItem.create({ data: { variantId: input.variantId, onHand: onHandAfter,
                        reserved: 0, version: 1 } });
                version = created.version;
            }
            else {
                const updated = await tx.inventoryItem.updateMany({ where: { variantId: input.variantId,
                        version: current.version, onHand: { gte: -input.delta } },
                    data: { onHand: onHandAfter, version: { increment: 1 } } });
                if (updated.count !== 1)
                    throw new AuthError(409, 'VERSION_CONFLICT');
                version = current.version + 1;
            }
            const movement = await tx.inventoryMovement.create({ data: { variantId: input.variantId, type: shape.type,
                    quantity: shape.quantity, stockDelta: shape.stockDelta, onHandAfter: shape.onHandAfter, reason: input.reason,
                    reasonCode: input.reasonCode, reference: input.reference, requestFingerprint: digest, dedupeKey,
                    actorId: actor.id, createdAt: now } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'inventory.adjust', input.variantId, 'success', input.reason);
            const stored = { onHand: onHandAfter, reserved: current.reserved, version };
            return { ...this.adjustmentResult(movement, stored), replay: false,
                lowStockLevel: await this.levelOf(tx, input.variantId) };
        }));
    }
    async levelOf(tx, variantId) {
        const row = await tx.inventoryThreshold.findUnique({ where: { variantId } });
        return row?.lowStockLevel ?? 0;
    }
    adjustmentResult(movement, item) {
        const onHand = item?.onHand ?? movement.onHandAfter ?? 0;
        const reserved = item?.reserved ?? 0;
        return { movement: this.movementView(movement), variantId: movement.variantId, onHand, reserved,
            available: availableOf(onHand, reserved), version: item?.version ?? 0 };
    }
    async listThresholds(supplied, limit, cursor) {
        return this.identity.withPermission(supplied, null, 'inventory.read', async (tx) => {
            if (cursor && !await tx.inventoryThreshold.findUnique({ where: { variantId: cursor } })) {
                throw new AuthError(422, 'VALIDATION_ERROR');
            }
            const rows = await tx.inventoryThreshold.findMany({ orderBy: [{ variantId: 'asc' }], take: limit + 1,
                ...(cursor ? { cursor: { variantId: cursor }, skip: 1 } : {}) });
            const visible = rows.slice(0, limit);
            const hasMore = rows.length > limit;
            return { items: visible.map(row => this.thresholdView(row)), hasMore,
                nextCursor: hasMore ? visible.at(-1).variantId : null };
        });
    }
    /**
     * 阈值只影响提醒：0 表示只关心售罄。写入用 body 里的 expectedVersion
     * （0 = 期望尚不存在，>0 = 期望的当前版本），不与库存量本身共用版本号。
     */
    async setThreshold(supplied, csrf, body, ctx) {
        const input = this.rule(() => normalizeThreshold(body));
        if (!UUID.test(input.variantId))
            throw new AuthError(422, 'VALIDATION_ERROR');
        return this.guarded(() => this.identity.withPermission(supplied, csrf, 'inventory.manage', async (tx, actor, _session, now) => {
            await this.lock(tx, `inventory-threshold:${input.variantId}`);
            const variant = await tx.productVariant.findUnique({ where: { id: input.variantId } });
            if (!variant)
                throw new AuthError(404, 'NOT_FOUND');
            const existing = await tx.inventoryThreshold.findUnique({ where: { variantId: input.variantId } });
            const currentVersion = existing?.version ?? 0;
            this.rule(() => assertInventoryVersion(input.expectedVersion ?? 0, currentVersion));
            const row = existing
                ? await tx.inventoryThreshold.update({ where: { variantId: input.variantId },
                    data: { lowStockLevel: input.lowStockLevel, updatedBy: actor.id, version: { increment: 1 } } })
                : await tx.inventoryThreshold.create({ data: { variantId: input.variantId, lowStockLevel: input.lowStockLevel,
                        updatedBy: actor.id, createdAt: now } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'inventory.threshold', input.variantId, 'success', `low=${input.lowStockLevel}`);
            return this.thresholdView(row);
        }));
    }
}
