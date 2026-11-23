import { Prisma } from '../../../../packages/database/src/client.js';
import { normalizeTheme, themeSnapshot, themeFromSnapshot, ThemeRuleError, } from '../../../../packages/domain/src/theme.js';
import { AuthError } from '../identity/service.js';
const THEME_CODES = [
    'THEME_VALIDATION_ERROR', 'THEME_COLOR_INVALID', 'THEME_FONT_UNSUPPORTED',
    'THEME_SECTION_UNSUPPORTED', 'THEME_SECTION_DUPLICATE',
];
function rule(fn) {
    try {
        return fn();
    }
    catch (error) {
        if (error instanceof ThemeRuleError) {
            const code = THEME_CODES.includes(error.code) ? error.code : 'VALIDATION_ERROR';
            throw new AuthError(422, code);
        }
        throw error;
    }
}
/**
 * 主题配置服务（配置驱动前台）。
 *
 * 后台只写 draftConfig；线上主题是发布时固化的 publishedSnapshot，前台只读它。
 * 保存草稿不改变线上外观；撤下只是摘掉线上快照，草稿留着可再发。
 * 每次发布/撤下写一条不可变 ThemeVersion，可按版本回滚。
 * 版本语义与 MerchandisingService 一致：没有草稿视作版本 1。
 */
export class ThemeService {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    view(row) {
        if (!row) {
            return { status: 'draft', version: 1, config: null,
                published: null, publishedAt: null, versions: [], updatedAt: null };
        }
        const published = row.publishedSnapshot
            ? { version: Number(row.publishedSnapshot.version ?? row.version),
                publishedAt: row.publishedAt?.toISOString() ?? null }
            : null;
        return {
            status: row.status,
            version: row.version,
            config: row.draftConfig,
            published,
            publishedAt: row.publishedAt?.toISOString() ?? null,
            versions: row.versions.map(v => ({ version: v.version, note: v.note,
                publishedAt: v.publishedAt.toISOString() })),
            updatedAt: row.updatedAt.toISOString(),
        };
    }
    /** 后台读取：草稿 + 当前线上版本 + 发布历史。 */
    async get(supplied) {
        return this.identity.withPermission(supplied, null, 'content.read', async (tx) => {
            const row = await tx.themeConfig.findUnique({ where: { singletonKey: 'main' },
                include: { versions: { orderBy: { version: 'desc' }, take: 20 } } });
            return this.view(row);
        });
    }
    /** 保存草稿：expectedVersion 必须与库里一致（没有草稿时为 1）。保存不改 status/快照。 */
    async save(supplied, csrfValue, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'content.write', async (tx, actor, _session, now) => {
            const config = rule(() => normalizeTheme(body.config));
            await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext('theme:main'))`;
            const existing = await tx.themeConfig.findUnique({ where: { singletonKey: 'main' } });
            if ((existing?.version ?? 1) !== body.expectedVersion)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const row = existing
                ? await tx.themeConfig.update({ where: { id: existing.id },
                    data: { draftConfig: config, version: existing.version + 1,
                        updatedBy: actor.id, updatedAt: now },
                    include: { versions: { orderBy: { version: 'desc' }, take: 20 } } })
                : await tx.themeConfig.create({ data: { singletonKey: 'main', status: 'draft', version: 2,
                        draftConfig: config, createdBy: actor.id, updatedBy: actor.id },
                    include: { versions: true } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'theme.config.saved', row.id, 'success', `v${row.version}`);
            return this.view(row);
        });
    }
    /** 发布：草稿固化为不可变快照，切线上指针，并写一条版本历史。 */
    async publish(supplied, csrfValue, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'content.publish', async (tx, actor, _session, now) => {
            await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext('theme:main'))`;
            const existing = await tx.themeConfig.findUnique({ where: { singletonKey: 'main' } });
            if (!existing)
                throw new AuthError(404, 'NOT_FOUND');
            if (existing.version !== body.expectedVersion)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const config = rule(() => normalizeTheme(existing.draftConfig));
            const version = existing.version + 1;
            const snapshot = themeSnapshot(config, version, now);
            await tx.themeVersion.create({ data: { themeId: existing.id, version,
                    snapshot: snapshot, note: body.note ?? null,
                    publishedAt: now, publishedBy: actor.id } });
            const row = await tx.themeConfig.update({ where: { id: existing.id },
                data: { status: 'published', version, publishedAt: now, publishedBy: actor.id,
                    publishedSnapshot: snapshot, updatedBy: actor.id, updatedAt: now },
                include: { versions: { orderBy: { version: 'desc' }, take: 20 } } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'theme.config.published', existing.id, 'success', `v${version}`);
            return this.view(row);
        });
    }
    /** 撤下：摘掉线上快照，草稿保留；不影响草稿，下次改完可再发。 */
    async unpublish(supplied, csrfValue, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'content.publish', async (tx, actor, _session, now) => {
            await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext('theme:main'))`;
            const existing = await tx.themeConfig.findUnique({ where: { singletonKey: 'main' } });
            if (!existing)
                throw new AuthError(404, 'NOT_FOUND');
            if (existing.version !== body.expectedVersion)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const row = await tx.themeConfig.update({ where: { id: existing.id },
                data: { status: 'draft', version: existing.version + 1, publishedSnapshot: Prisma.DbNull,
                    publishedAt: null, publishedBy: null, updatedBy: actor.id, updatedAt: now },
                include: { versions: { orderBy: { version: 'desc' }, take: 20 } } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'theme.config.withdrawn', existing.id, 'success', body.reason);
            return this.view(row);
        });
    }
    /** 回滚：把历史版本快照重新发布为线上快照，再写一条新版本记录（历史不可变）。 */
    async rollback(supplied, csrfValue, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'content.publish', async (tx, actor, _session, now) => {
            await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext('theme:main'))`;
            const existing = await tx.themeConfig.findUnique({ where: { singletonKey: 'main' } });
            if (!existing)
                throw new AuthError(404, 'NOT_FOUND');
            if (existing.version !== body.expectedVersion)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const target = await tx.themeVersion.findUnique({ where: { themeId_version: { themeId: existing.id, version: body.version } } });
            if (!target)
                throw new AuthError(404, 'NOT_FOUND');
            const config = rule(() => normalizeTheme(themeFromSnapshot(target.snapshot)));
            const version = existing.version + 1;
            const snapshot = themeSnapshot(config, version, now);
            await tx.themeVersion.create({ data: { themeId: existing.id, version,
                    snapshot: snapshot, note: `rollback to v${body.version}`,
                    publishedAt: now, publishedBy: actor.id } });
            const row = await tx.themeConfig.update({ where: { id: existing.id },
                data: { status: 'published', version, publishedAt: now, publishedBy: actor.id,
                    publishedSnapshot: snapshot,
                    draftConfig: config, updatedBy: actor.id, updatedAt: now },
                include: { versions: { orderBy: { version: 'desc' }, take: 20 } } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'theme.config.rolled_back', existing.id, 'success', `v${body.version} -> v${version}`);
            return this.view(row);
        });
    }
}
