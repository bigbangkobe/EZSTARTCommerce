import { contentReleaseToken, normalizeBlocks, normalizePageTranslations, normalizePublishPlan, assertPageKey, assertPageType, } from '../../../../packages/domain/src/content.js';
import { normalizePreviewPlan, previewPath, PreviewRuleError } from '../../../../packages/domain/src/preview.js';
import { categoryMerchandisingKey, collectionMerchandisingKey } from '../../../../packages/domain/src/merchandising.js';
import { assertRedirectWritable, normalizeRedirectPath, REDIRECT_STATUS_CODES, RedirectRuleError, } from '../../../../packages/domain/src/redirect.js';
import { AuthError } from '../identity/service.js';
import { contentLocales, contentRule, publishPageVersion, rollbackPageVersion, schedulePage, withdrawPageVersion, } from './publish.js';
import { issuePreviewToken } from './preview.js';
const PREVIEW_CODES = { VALIDATION_ERROR: 'VALIDATION_ERROR' };
const REDIRECT_CODES = { REDIRECT_SELF: 'REDIRECT_SELF', REDIRECT_LOOP: 'REDIRECT_LOOP' };
function previewRule(fn) {
    try {
        return fn();
    }
    catch (error) {
        if (error instanceof PreviewRuleError)
            throw new AuthError(422, PREVIEW_CODES[error.code] ?? 'VALIDATION_ERROR');
        throw error;
    }
}
function redirectRule(fn) {
    try {
        return fn();
    }
    catch (error) {
        if (error instanceof RedirectRuleError)
            throw new AuthError(422, REDIRECT_CODES[error.code] ?? 'VALIDATION_ERROR');
        throw error;
    }
}
const includePage = { translations: true, versions: { orderBy: { version: 'desc' }, take: 20 } };
/**
 * 内容页服务（M04 第一批）。
 *
 * 会话/权限/审计统一走 IdentityService；这里只负责内容规则与持久化。
 * 草稿与线上是两套数据：草稿在 ContentPage/Translation，线上是 ContentPageVersion.snapshot，
 * 前台只读后者——因此「保存草稿」永远不会让未审核的内容出现在公开地址上。
 */
export class ContentService {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    async guarded(fn) {
        try {
            return await fn();
        }
        catch (error) {
            const code = error.code;
            if (code === 'P2002')
                throw new AuthError(409, 'SLUG_TAKEN');
            if (code === 'P2025')
                throw new AuthError(404, 'NOT_FOUND');
            throw error;
        }
    }
    view(row, releaseSeq) {
        return {
            id: row.id, pageKey: row.pageKey, pageType: row.pageType, status: row.status, position: row.position,
            scheduledAt: row.scheduledAt?.toISOString() ?? null, publishedAt: row.publishedAt?.toISOString() ?? null,
            version: row.version,
            translations: [...row.translations].sort((left, right) => left.locale.localeCompare(right.locale))
                .map(translation => ({ locale: translation.locale, title: translation.title, slug: translation.slug,
                seoTitle: translation.seoTitle, seoDescription: translation.seoDescription, indexable: translation.indexable,
                publishedSlug: translation.publishedSlug })),
            blocks: contentRule(() => normalizeBlocks(row.blocks)),
            // 只回版本摘要：snapshot 是整页内容，后台列表不需要它，回整个 JSON 只会让响应翻倍。
            publishedVersion: row.publishedVersionId
                ? (() => {
                    const current = row.versions.find(version => version.id === row.publishedVersionId);
                    return current ? { version: current.version, status: current.status,
                        publishedAt: current.publishedAt.toISOString(), note: current.note, releaseSeq: current.releaseSeq } : null;
                })()
                : null,
            versions: row.versions.map(version => ({ version: version.version, status: version.status,
                publishedAt: version.publishedAt.toISOString(), note: version.note, releaseSeq: version.releaseSeq })),
            contentRelease: releaseSeq === null ? null : contentReleaseToken(releaseSeq),
            createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
        };
    }
    async releaseSeq(tx) {
        const row = await tx.contentRelease.findUnique({ where: { id: 1 } });
        return row?.seq ?? 0;
    }
    async load(tx, id) {
        const row = await tx.contentPage.findUnique({ where: { id }, include: includePage });
        if (!row)
            throw new AuthError(404, 'NOT_FOUND');
        return row;
    }
    async listPages(supplied, limit, cursor) {
        return this.identity.withPermission(supplied, null, 'content.read', async (tx) => {
            if (cursor && !await tx.contentPage.findUnique({ where: { id: cursor } }))
                throw new AuthError(422, 'VALIDATION_ERROR');
            const rows = await tx.contentPage.findMany({ include: includePage, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
                take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            const release = await this.releaseSeq(tx);
            const items = rows.slice(0, limit).map(row => this.view(row, release));
            const hasMore = rows.length > limit;
            return { items, hasMore, nextCursor: hasMore ? items.at(-1).id : null };
        });
    }
    async getPage(supplied, id) {
        return this.identity.withPermission(supplied, null, 'content.read', async (tx) => this.view(await this.load(tx, id), await this.releaseSeq(tx)));
    }
    async createPage(supplied, csrfValue, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'content.write', async (tx, actor) => {
            const locales = await contentLocales(tx);
            const pageKey = contentRule(() => assertPageKey(body.pageKey));
            const pageType = contentRule(() => assertPageType(body.pageType));
            const translations = contentRule(() => normalizePageTranslations(body.translations ?? [], locales));
            const blocks = contentRule(() => normalizeBlocks(body.blocks ?? []));
            const row = await this.guarded(() => tx.contentPage.create({ data: { pageKey, pageType,
                    blocks: blocks, status: 'draft', version: 1, createdBy: actor.id, updatedBy: actor.id,
                    translations: { create: translations.map(translation => ({ ...translation })) } }, include: includePage }));
            await this.identity.recordAudit(tx, ctx, actor.id, 'content.page.created', row.id);
            return this.view(row, await this.releaseSeq(tx));
        });
    }
    async updatePage(supplied, csrfValue, id, version, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'content.write', async (tx, actor, _session, now) => {
            const locales = await contentLocales(tx);
            // 编辑与发布串行：否则「编辑后马上发布」会读到一半新一半旧的草稿。
            await tx.$queryRaw `SELECT "id" FROM "ContentPage" WHERE "id" = ${id}::uuid FOR UPDATE`;
            const row = await this.load(tx, id);
            if (row.version !== version)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const data = { version: row.version + 1, updatedBy: actor.id, updatedAt: now };
            if (body.pageKey !== undefined)
                data.pageKey = contentRule(() => assertPageKey(body.pageKey));
            if (body.pageType !== undefined)
                data.pageType = contentRule(() => assertPageType(body.pageType));
            if (body.blocks !== undefined) {
                const blocks = contentRule(() => normalizeBlocks(body.blocks));
                data.blocks = blocks;
            }
            // 定时页面被编辑后必须重新定时：否则会用「编辑后的内容」在旧时刻静默上线。
            if (row.status === 'scheduled') {
                data.scheduledAt = null;
                data.status = 'draft';
            }
            if (body.translations !== undefined) {
                const translations = contentRule(() => normalizePageTranslations(body.translations, locales));
                const keep = new Set(translations.map(translation => translation.locale));
                for (const existing of row.translations) {
                    if (!keep.has(existing.locale))
                        await tx.contentPageTranslation.delete({ where: { id: existing.id } });
                }
                for (const translation of translations) {
                    await this.guarded(() => tx.contentPageTranslation.upsert({
                        where: { pageId_locale: { pageId: id, locale: translation.locale } },
                        create: { pageId: id, ...translation },
                        // publishedSlug 只在发布时改：改草稿 slug 不应该让线上地址立刻消失。
                        update: { title: translation.title, slug: translation.slug, seoTitle: translation.seoTitle,
                            seoDescription: translation.seoDescription, indexable: translation.indexable },
                    }));
                }
            }
            const updated = await this.guarded(() => tx.contentPage.update({ where: { id }, data, include: includePage }));
            await this.identity.recordAudit(tx, ctx, actor.id, 'content.page.updated', id);
            return this.view(updated, await this.releaseSeq(tx));
        });
    }
    /**
     * 发布：立即或定时。定时只登记计划（202），到点由 worker 执行；
     * 立即发布在事务内切线上指针，失败则整体回滚，线上版本不受影响。
     */
    async publishPage(supplied, csrfValue, id, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'content.publish', async (tx, actor, _session, now) => {
            const plan = contentRule(() => normalizePublishPlan({ mode: body.mode, scheduledAt: body.scheduledAt }, now));
            if (plan.mode === 'scheduled' && plan.scheduledAt) {
                await schedulePage(tx, { pageId: id, expectedVersion: body.expectedVersion, scheduledAt: plan.scheduledAt, actorId: actor.id });
                await this.identity.recordAudit(tx, ctx, actor.id, 'content.page.scheduled', id, 'success', plan.scheduledAt.toISOString());
                return { scheduled: true, releaseToken: null, page: this.view(await this.load(tx, id), await this.releaseSeq(tx)) };
            }
            const result = await publishPageVersion(tx, { pageId: id, expectedVersion: body.expectedVersion,
                actorId: actor.id, note: null, now });
            await this.identity.recordAudit(tx, ctx, actor.id, 'content.page.published', id, 'success', `v${result.version}`);
            return { scheduled: false, releaseToken: result.releaseToken,
                page: this.view(await this.load(tx, id), await this.releaseSeq(tx)) };
        });
    }
    async unpublishPage(supplied, csrfValue, id, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'content.publish', async (tx, actor, _session, now) => {
            const result = await withdrawPageVersion(tx, { pageId: id, actorId: actor.id, now });
            await this.identity.recordAudit(tx, ctx, actor.id, 'content.page.withdrawn', id, 'success', body.reason);
            return { releaseToken: result.releaseToken, page: this.view(await this.load(tx, id), result.releaseSeq) };
        });
    }
    async rollbackPage(supplied, csrfValue, id, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'content.publish', async (tx, actor, _session, now) => {
            const result = await rollbackPageVersion(tx, { pageId: id, sourceVersion: body.sourceVersion,
                expectedVersion: body.expectedVersion, actorId: actor.id, reason: body.reason, now });
            await this.identity.recordAudit(tx, ctx, actor.id, 'content.page.rolled_back', id, 'success', `from v${body.sourceVersion}: ${body.reason}`);
            return { releaseToken: result.releaseToken, page: this.view(await this.load(tx, id), result.releaseSeq) };
        });
    }
    /**
     * 预览外链：绑定「页面 + 语言 + 视口 + 当前草稿版本」的短期 token。
     * 只有后台正在看的那个版本能签发——两个编辑同时改稿时，A 的链接不会显示 B 还没审阅的内容。
     */
    async createPreviewToken(supplied, csrfValue, id, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'content.preview', async (tx, actor, _session, now) => {
            const page = await this.load(tx, id);
            if (page.version !== body.expectedVersion)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const locales = await contentLocales(tx);
            const plan = previewRule(() => normalizePreviewPlan(body, locales, now));
            const { token, tokenHash } = issuePreviewToken();
            // 同一页面只保留最近 10 条有效链接：旧链接不需要撤销按钮，过期自然失效。
            const stale = await tx.contentPreviewToken.findMany({ where: { pageId: id, expiresAt: { gt: now } },
                orderBy: { createdAt: 'desc' }, skip: 9, select: { id: true } });
            if (stale.length)
                await tx.contentPreviewToken.deleteMany({ where: { id: { in: stale.map(row => row.id) } } });
            await tx.contentPreviewToken.create({ data: { pageId: id, tokenHash, locale: plan.locale,
                    viewport: plan.viewport, expiresAt: plan.expiresAt, createdBy: actor.id } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'content.page.preview_issued', id, 'success', `${plan.locale}/${plan.viewport}`);
            return { token, path: previewPath(token, plan), locale: plan.locale, viewport: plan.viewport,
                expiresAt: plan.expiresAt.toISOString(), pageVersion: page.version };
        });
    }
    /**
     * 重定向清单：改 slug 后旧地址的去向要能被运营复核。
     * 自动登记（改 slug 产生）与手工登记必须一眼分得出，否则运营会以为某条跳转是自己写的；
     * pageKey 复用陈列作用域的写法，点过去就是能改地址的那个对象的版面。
     */
    async listRedirects(supplied, limit, cursor) {
        return this.identity.withPermission(supplied, null, 'content.read', async (tx) => {
            if (cursor && !await tx.seoRedirect.findUnique({ where: { id: cursor } }))
                throw new AuthError(422, 'VALIDATION_ERROR');
            const rows = await tx.seoRedirect.findMany({ include: { page: { select: { pageKey: true } } },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            const items = rows.slice(0, limit).map(row => {
                // 归属：内容页用自身 pageKey；专题/分类没有内容页 key，用陈列作用域 key（collection:/category:<id>）。
                const ownerKey = row.page?.pageKey
                    ?? (row.collectionId ? collectionMerchandisingKey(row.collectionId) : null)
                    ?? (row.categoryId ? categoryMerchandisingKey(row.categoryId) : null);
                return { id: row.id, locale: row.locale, fromPath: row.fromPath,
                    toPath: row.toPath, statusCode: row.statusCode, pageKey: ownerKey,
                    auto: ownerKey !== null, createdAt: row.createdAt.toISOString() };
            });
            const hasMore = rows.length > limit;
            return { items, hasMore, nextCursor: hasMore ? items.at(-1).id : null };
        });
    }
    /**
     * 手工登记重定向。只做站内路径；已在线页面不能被重定向挡掉（那是配置错误，不是重定向）。
     * 自跳与成环在写入前拒绝，不留「保存成功但前台无限跳转」的状态。
     */
    async createRedirect(supplied, csrfValue, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'content.publish', async (tx, actor) => {
            const locales = await contentLocales(tx);
            if (!locales.includes(body.locale))
                throw new AuthError(422, 'VALIDATION_ERROR');
            const fromPath = redirectRule(() => normalizeRedirectPath(body.fromPath, 'fromPath'));
            const toPath = redirectRule(() => normalizeRedirectPath(body.toPath, 'toPath'));
            const statusCode = body.statusCode ?? 301;
            if (!REDIRECT_STATUS_CODES.includes(statusCode))
                throw new AuthError(422, 'VALIDATION_ERROR');
            // 路径里的语言前缀必须与提交的语言一致：不一致的重定向在解析时永远不命中，
            // 属于「保存成功但前台静默失效」，这里直接拒绝。
            const prefixed = /^\/([a-z]{2}(?:-[A-Z]{2})?)\//.exec(fromPath)?.[1] ?? null;
            if (prefixed && locales.includes(prefixed) && prefixed !== body.locale)
                throw new AuthError(422, 'VALIDATION_ERROR');
            // 挡掉在线页面等于让正常地址 301 到别处，必须拒绝并提示改内容页而不是加重定向。
            const segments = fromPath.split('/');
            const shadowedSlug = segments.length === 4 && segments[1] === body.locale && segments[2] === 'pages' ? segments[3] : null;
            if (shadowedSlug) {
                const live = await tx.contentPageTranslation.findFirst({ where: { locale: body.locale, publishedSlug: shadowedSlug } });
                if (live)
                    throw new AuthError(409, 'REDIRECT_SHADOWS_PAGE');
            }
            // 与解析端一致：读全量再在内存里判环，避免漏看别的语言标签下的记录。
            const entries = await tx.seoRedirect.findMany({
                select: { fromPath: true, toPath: true, statusCode: true }, take: 500
            });
            redirectRule(() => assertRedirectWritable(entries, fromPath, toPath));
            const row = await (async () => {
                try {
                    return await tx.seoRedirect.create({ data: { locale: body.locale, fromPath, toPath,
                            statusCode, createdBy: actor.id }, include: { page: { select: { pageKey: true } } } });
                }
                catch (error) {
                    if (error.code === 'P2002')
                        throw new AuthError(409, 'REDIRECT_EXISTS');
                    throw error;
                }
            })();
            await this.identity.recordAudit(tx, ctx, actor.id, 'content.redirect.created', row.id, 'success', `${fromPath} -> ${toPath}`);
            return { id: row.id, locale: row.locale, fromPath: row.fromPath, toPath: row.toPath, statusCode: row.statusCode,
                pageKey: row.page?.pageKey ?? null, auto: row.page !== null, createdAt: row.createdAt.toISOString() };
        });
    }
    async deleteRedirect(supplied, csrfValue, id, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'content.publish', async (tx, actor) => {
            const row = await tx.seoRedirect.findUnique({ where: { id } });
            if (!row)
                throw new AuthError(404, 'NOT_FOUND');
            await tx.seoRedirect.delete({ where: { id } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'content.redirect.deleted', id, 'success', row.fromPath);
            return null;
        });
    }
    /** worker 用：到点发布。返回 true 表示本轮确实发布了内容。 */
    async publishDue(now, limit = 5) {
        const due = await this.identity.db.contentPage.findMany({ where: { status: 'scheduled', scheduledAt: { lte: now } },
            orderBy: { scheduledAt: 'asc' }, take: limit });
        let published = 0;
        for (const page of due) {
            const ctx = { requestId: `content-scheduler:${page.id}`, ip: 'worker' };
            try {
                await this.identity.db.$transaction(async (tx) => {
                    const result = await publishPageVersion(tx, { pageId: page.id, expectedVersion: page.version, actorId: null,
                        note: 'scheduled', now });
                    // 定时发布没有登录会话，但审计必须留下证据：谁都没按按钮，也要能解释内容何时上线。
                    await this.identity.recordAudit(tx, ctx, null, 'content.page.published', page.id, 'success', `scheduled v${result.version}`);
                }, { timeout: 15_000 });
                published += 1;
            }
            catch (error) {
                // 计划失败时线上版本保持不变：把计划标记为失败并留审计，等人工处理。
                const reason = error instanceof AuthError ? error.code : 'PUBLISH_FAILED';
                await this.identity.db.$transaction(async (tx) => {
                    await tx.contentPage.update({ where: { id: page.id }, data: { status: 'draft', scheduledAt: null } });
                    await this.identity.recordAudit(tx, ctx, null, 'content.page.schedule_failed', page.id, 'failure', reason);
                });
            }
        }
        return published;
    }
}
