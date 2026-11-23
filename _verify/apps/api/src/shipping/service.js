import { shippingFeeMinor } from '../../../../packages/domain/src/checkout.js';
import { assertNoOverlap, normalizeCode, normalizeCountries, normalizeDays, normalizeMoney, normalizeNames, normalizePriority, normalizeRegions, normalizeZoneIds, ShippingRuleError } from '../../../../packages/domain/src/shipping.js';
import { AuthError } from '../identity/service.js';
const includeRate = { zones: { include: { zone: true } } };
/** 领域规则里表达「与已有配置冲突」的码：语义是 409，不是 422。 */
const CONFLICT_CODES = new Set(['ZONE_OVERLAP']);
/**
 * 配送配置（M09 最小切片）。
 *
 * 结账只能引用启用且覆盖收货地址的费率，因此配置侧必须保证：
 * 费率币种等于店铺基础币种、绑定的区真实存在、启用区之间不出现重叠口径。
 */
export class ShippingService {
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
            if (error instanceof ShippingRuleError) {
                // 覆盖面重叠是业务冲突（客户端应换一个区），不是格式错误：422 会让调用方以为改字段就能过。
                throw new AuthError(CONFLICT_CODES.has(error.code) ? 409 : 422, error.code);
            }
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
            if (code === 'P2011' || code === 'P2000')
                throw new AuthError(422, 'VALIDATION_ERROR');
            throw error;
        }
    }
    async lock(tx, key) { await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${key}))::text`; }
    async store(tx) {
        const row = await tx.storeConfig.findUnique({ where: { id: 1 } });
        return { locales: (row?.locales ?? ['zh-CN', 'zh-HK', 'en']),
            defaultLocale: row?.defaultLocale ?? 'zh-CN', currency: row?.baseCurrency ?? 'HKD' };
    }
    assertLocales(names, locales) {
        if (Object.keys(names).some(locale => !locales.includes(locale)))
            this.rule(() => { throw new ShippingRuleError('nameByLocale'); });
    }
    zoneView(row) {
        return { id: row.id, code: row.code, nameByLocale: row.nameByLocale,
            countryCodes: [...row.countryCodes].sort(), regionCodes: [...row.regionCodes].sort(), priority: row.priority,
            enabled: row.enabled, version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
    }
    rateView(row) {
        return { id: row.id, code: row.code, nameByLocale: row.nameByLocale,
            zoneIds: [...row.zones].map(link => link.zoneId).sort(), fixedFeeMinor: row.fixedFeeMinor, freeAboveMinor: row.freeAboveMinor ?? null,
            currency: row.currency, estimatedMinDays: row.estimatedMinDays ?? null, estimatedMaxDays: row.estimatedMaxDays ?? null,
            codEnabled: row.codEnabled, enabled: row.enabled, version: row.version,
            createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
    }
    // ---- 配送区 -----------------------------------------------------------------
    async listZones(supplied) {
        return this.identity.withPermission(supplied, null, 'shipping.manage', async (tx) => ({ items: (await tx.shippingZone.findMany({ orderBy: [{ priority: 'asc' }, { code: 'asc' }] })).map(row => this.zoneView(row)) }));
    }
    async getZone(supplied, id) {
        return this.identity.withPermission(supplied, null, 'shipping.manage', async (tx) => {
            const row = await tx.shippingZone.findUnique({ where: { id } });
            if (!row)
                throw new AuthError(404, 'NOT_FOUND');
            return this.zoneView(row);
        });
    }
    zoneInput(body, existing) {
        return this.rule(() => ({
            code: body.code === undefined && existing ? existing.code : normalizeCode(body.code ?? '', 'code'),
            nameByLocale: body.nameByLocale === undefined && existing ? existing.nameByLocale : normalizeNames(body.nameByLocale ?? {}, 20),
            countryCodes: body.countryCodes === undefined && existing ? existing.countryCodes : normalizeCountries(body.countryCodes ?? []),
            regionCodes: body.regionCodes === undefined && existing ? existing.regionCodes : normalizeRegions(body.regionCodes ?? []),
            priority: body.priority === undefined && existing ? existing.priority : normalizePriority(body.priority ?? 0),
            enabled: body.enabled ?? existing?.enabled ?? true,
        }));
    }
    async createZone(supplied, csrfValue, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'shipping.manage', async (tx, actor) => {
            const { locales } = await this.store(tx);
            const input = this.zoneInput(body, null);
            this.assertLocales(input.nameByLocale, locales);
            const existing = await tx.shippingZone.findMany();
            this.rule(() => assertNoOverlap(input, existing));
            const row = await this.guarded(() => tx.shippingZone.create({ data: { ...input } }));
            await this.identity.recordAudit(tx, ctx, actor.id, 'shipping.zone.created', row.id);
            return this.zoneView(row);
        }, true);
    }
    async updateZone(supplied, csrfValue, id, version, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'shipping.manage', async (tx, actor) => {
            await this.lock(tx, `shipping-zone:${id}`);
            const current = await tx.shippingZone.findUnique({ where: { id } });
            if (!current)
                throw new AuthError(404, 'NOT_FOUND');
            if (current.version !== version)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const { locales } = await this.store(tx);
            const input = this.zoneInput(body, { code: current.code, nameByLocale: current.nameByLocale,
                countryCodes: [...current.countryCodes], regionCodes: [...current.regionCodes], priority: current.priority, enabled: current.enabled });
            this.assertLocales(input.nameByLocale, locales);
            const others = await tx.shippingZone.findMany({ where: { id: { not: id } } });
            this.rule(() => assertNoOverlap(input, others));
            const row = await this.guarded(() => tx.shippingZone.update({ where: { id }, data: { ...input, version: { increment: 1 } } }));
            await this.identity.recordAudit(tx, ctx, actor.id, 'shipping.zone.updated', id);
            return this.zoneView(row);
        }, true);
    }
    // ---- 费率 -------------------------------------------------------------------
    async listRates(supplied) {
        return this.identity.withPermission(supplied, null, 'shipping.manage', async (tx) => ({
            items: (await tx.shippingRate.findMany({ include: includeRate, orderBy: [{ code: 'asc' }] })).map(row => this.rateView(row)),
        }));
    }
    async getRate(supplied, id) {
        return this.identity.withPermission(supplied, null, 'shipping.manage', async (tx) => {
            const row = await tx.shippingRate.findUnique({ where: { id }, include: includeRate });
            if (!row)
                throw new AuthError(404, 'NOT_FOUND');
            return this.rateView(row);
        });
    }
    async rateInput(tx, body, existing, currency) {
        const zoneIds = body.zoneIds === undefined && existing ? existing.zoneIds : this.rule(() => normalizeZoneIds(body.zoneIds ?? []));
        const found = await tx.shippingZone.count({ where: { id: { in: zoneIds } } });
        if (found !== zoneIds.length)
            throw new AuthError(422, 'VALIDATION_ERROR');
        const freeAbove = body.freeAboveMinor === undefined && existing ? existing.freeAboveMinor
            : this.rule(() => normalizeMoney(body.freeAboveMinor, 'freeAboveMinor', true));
        const minDays = body.estimatedMinDays === undefined && existing ? existing.estimatedMinDays
            : this.rule(() => normalizeDays(body.estimatedMinDays ?? null, 'estimatedMinDays'));
        const maxDays = body.estimatedMaxDays === undefined && existing ? existing.estimatedMaxDays
            : this.rule(() => normalizeDays(body.estimatedMaxDays ?? null, 'estimatedMaxDays'));
        if (minDays !== null && maxDays !== null && maxDays < minDays)
            throw new AuthError(422, 'VALIDATION_ERROR');
        const rateCurrency = body.currency === undefined && existing ? existing.currency : (body.currency ?? '');
        // 只支持店铺基础币种：多币种报价属于 M10，现在放开会产生换算口径不清的运费。
        if (rateCurrency !== currency)
            throw new AuthError(422, 'VALIDATION_ERROR');
        return {
            code: body.code === undefined && existing ? existing.code : this.rule(() => normalizeCode(body.code ?? '', 'code')),
            nameByLocale: body.nameByLocale === undefined && existing ? existing.nameByLocale
                : this.rule(() => normalizeNames(body.nameByLocale ?? {}, 20)),
            zoneIds,
            fixedFeeMinor: body.fixedFeeMinor === undefined && existing ? existing.fixedFeeMinor
                : this.rule(() => normalizeMoney(body.fixedFeeMinor, 'fixedFeeMinor')),
            freeAboveMinor: freeAbove,
            currency: rateCurrency,
            estimatedMinDays: minDays,
            estimatedMaxDays: maxDays,
            codEnabled: body.codEnabled ?? existing?.codEnabled ?? false,
            enabled: body.enabled ?? existing?.enabled ?? true,
        };
    }
    async createRate(supplied, csrfValue, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'shipping.manage', async (tx, actor) => {
            const { locales, currency } = await this.store(tx);
            const input = await this.rateInput(tx, body, null, currency);
            this.assertLocales(input.nameByLocale, locales);
            const { zoneIds, ...data } = input;
            const row = await this.guarded(() => tx.shippingRate.create({ data: { ...data,
                    zones: { create: zoneIds.map(zoneId => ({ zoneId })) } }, include: includeRate }));
            await this.identity.recordAudit(tx, ctx, actor.id, 'shipping.rate.created', row.id);
            return this.rateView(row);
        }, true);
    }
    async updateRate(supplied, csrfValue, id, version, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'shipping.manage', async (tx, actor) => {
            await this.lock(tx, `shipping-rate:${id}`);
            const current = await tx.shippingRate.findUnique({ where: { id }, include: includeRate });
            if (!current)
                throw new AuthError(404, 'NOT_FOUND');
            if (current.version !== version)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const { locales, currency } = await this.store(tx);
            const existing = { code: current.code, nameByLocale: current.nameByLocale,
                zoneIds: current.zones.map(link => link.zoneId), fixedFeeMinor: current.fixedFeeMinor, freeAboveMinor: current.freeAboveMinor ?? null,
                currency: current.currency, estimatedMinDays: current.estimatedMinDays ?? null,
                estimatedMaxDays: current.estimatedMaxDays ?? null, codEnabled: current.codEnabled, enabled: current.enabled };
            const input = await this.rateInput(tx, body, existing, currency);
            this.assertLocales(input.nameByLocale, locales);
            const { zoneIds, ...data } = input;
            const row = await this.guarded(() => tx.shippingRate.update({ where: { id }, include: includeRate,
                data: { ...data, version: { increment: 1 },
                    ...(body.zoneIds === undefined ? {} : { zones: { deleteMany: {}, create: zoneIds.map(zoneId => ({ zoneId })) } }) } }));
            await this.identity.recordAudit(tx, ctx, actor.id, 'shipping.rate.updated', id);
            return this.rateView(row);
        }, true);
    }
    // ---- 结账可用方法 -----------------------------------------------------------
    /**
     * 地址可用的配送方法：启用 + 币种一致 + 至少一个绑定区覆盖该地址。
     * 运费在这里算一次，报价快照直接取用，不在别处重算。
     */
    async methodsFor(tx, address, subtotalMinor, currency, locale, fallbackLocale) {
        const rows = await tx.shippingRate.findMany({ where: { enabled: true, currency }, include: includeRate,
            orderBy: [{ fixedFeeMinor: 'asc' }, { code: 'asc' }] });
        return rows.filter(row => row.zones.some(link => {
            const zone = link.zone;
            if (!zone.enabled || !zone.countryCodes.includes(address.countryCode))
                return false;
            if (!zone.regionCodes.length)
                return true;
            return address.regionCode !== null && zone.regionCodes.includes(address.regionCode);
        })).map(row => {
            const names = row.nameByLocale;
            return { id: row.id, code: row.code, name: names[locale] ?? names[fallbackLocale] ?? Object.values(names)[0] ?? row.code,
                feeMinor: shippingFeeMinor({ fixedFeeMinor: row.fixedFeeMinor, freeAboveMinor: row.freeAboveMinor ?? null }, subtotalMinor),
                estimatedMinDays: row.estimatedMinDays ?? null, estimatedMaxDays: row.estimatedMaxDays ?? null, codEnabled: row.codEnabled };
        });
    }
    async preview(supplied, body) {
        return this.identity.withPermission(supplied, null, 'shipping.manage', async (tx) => {
            const { defaultLocale, currency } = await this.store(tx);
            if (body.currency !== currency)
                throw new AuthError(422, 'VALIDATION_ERROR');
            if (!Number.isInteger(body.merchandiseSubtotalMinor) || body.merchandiseSubtotalMinor < 0)
                throw new AuthError(422, 'VALIDATION_ERROR');
            const address = { countryCode: body.address.countryCode.trim().toUpperCase(), regionCode: body.address.regionCode?.trim() || null };
            if (!/^[A-Z]{2}$/.test(address.countryCode))
                throw new AuthError(422, 'VALIDATION_ERROR');
            const methods = await this.methodsFor(tx, address, body.merchandiseSubtotalMinor, currency, defaultLocale, defaultLocale);
            return { currency, methods };
        });
    }
}
