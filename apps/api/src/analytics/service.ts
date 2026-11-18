import type { Prisma } from '../../../../packages/database/src/client.js';
import {
  ANALYTICS_SCHEMA_VERSION, funnelStepIndex,
  normalizeAnalyticsBatch, countsTowardFunnel, AnalyticsRuleError,
  type AnalyticsEventInput,
} from '../../../../packages/domain/src/analytics.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';
import { CartService } from '../checkout/cart-service.js';

type Tx = Prisma.TransactionClient;

/**
 * 访问漏斗事件采集（M14 第二批）。
 *
 * 不变量：
 * 1. 开关门控：StoreConfig.featureFlags.analyticsEnabled 未开启时直接拒绝，不落库——
 *    未经批准的追踪不得默认启用；服务端独立判断，前端开关只是 UX，不是安全边界。
 * 2. 同意门控：consentState != granted 的事件仍可落库（便于审计"来过但不同意"），
 *    但 countsTowardFunnel 决定是否计入漏斗指标，报表层只聚合 granted 事件。
 * 3. 会话关联：sessionId 由浏览器随机生成；服务端读 HttpOnly 的 ez_guest_cart 后用
 *    CartService.locate 解析出 cartId 回填到会话，用于把成功订单（ShopOrder.cartId）归因。
 *    没有 cart cookie 时也能记页面浏览，cartId 留空，后续事件到达时再补。
 * 4. 幂等：eventId 唯一，重复上报（网络重试）忽略，不二次写入也不二次计数。
 * 5. 绝不采信 purchase：契约与领域层已拒，这里再断言一次。
 */
export class AnalyticsService {
  constructor(private readonly identity: IdentityService, private readonly cart: CartService) {}
  private get db() { return this.identity.db; }

  private rule<T>(fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof AnalyticsRuleError) throw new AuthError(422, error.code);
      throw error;
    }
  }

  /** 采集开关：默认关闭。只有 featureFlags.analyticsEnabled === true 才采集。 */
  private async assertEnabled(tx: Tx): Promise<void> {
    const row = await tx.storeConfig.findUnique({ where: { id: 1 } });
    const flags = (row?.featureFlags ?? {}) as Record<string, unknown>;
    if (flags['analyticsEnabled'] !== true) throw new AuthError(403, 'ANALYTICS_DISABLED');
  }

  /**
   * 批量上报：公开端点，由 controller 完成 CSRF + 限流 + 契约 assert。
   * cartToken 是 ez_guest_cart 的原文（可选），解析失败当作没有购物袋，不让坏 cookie 阻断采集。
   */
  async ingest(cartToken: string | null, body: unknown, ctx: RequestContext) {
    const events = this.rule(() => normalizeAnalyticsBatch(body));
    return this.db.$transaction(async tx => {
      await this.assertEnabled(tx);
      await this.identity.limitIp(ctx);

      // 尝试把会话关联到购物袋；坏 token / 过期购物袋都按"无 cart"处理，不抛给客户端。
      let cartId: string | null = null;
      if (cartToken && /^[A-Za-z0-9_-]{43}$/.test(cartToken)) {
        try { cartId = (await this.cart.locate(tx, cartToken)).id; } catch { cartId = null; }
      }

      const accepted: string[] = [];
      const duplicates: string[] = [];
      const now = new Date();

      for (const event of events) {
        const existing = await tx.analyticsEvent.findUnique({ where: { eventId: event.eventId } });
        if (existing) { duplicates.push(event.eventId); continue; }

        // 会话 upsert：首次写入带 cartId 与首见时间，后续只在有 cartId 时回填并续期。
        const occurredAt = new Date(event.occurredAt);
        await this.upsertSession(tx, event, cartId, occurredAt, now);
        await tx.analyticsEvent.create({ data: {
          eventId: event.eventId, sessionId: event.sessionId, eventName: event.eventName,
          occurredAt, schemaVersion: event.schemaVersion, consentState: event.consentState,
          pageKey: event.pageKey, locale: event.locale, deviceClass: event.deviceClass,
          marketCode: event.marketCode, variantId: event.variantId, interactionId: event.interactionId,
          source: event.source, sectionId: event.sectionId, sectionKey: event.sectionKey,
          placementId: event.placementId, publishVersionId: event.publishVersionId,
          environment: event.environment, trafficClass: event.trafficClass,
        } });
        accepted.push(event.eventId);
      }

      return {
        accepted: accepted.length, duplicates: duplicates.length,
        schemaVersion: ANALYTICS_SCHEMA_VERSION,
      };
    });
  }

  /** 会话首见/续期：sessionId 是自然键；只前进 lastSeenAt，不回退。 */
  private async upsertSession(tx: Tx, event: AnalyticsEventInput, cartId: string | null,
    occurredAt: Date, now: Date): Promise<void> {
    const seen = occurredAt.getTime() < now.getTime() ? occurredAt : now;
    const existing = await tx.analyticsSession.findUnique({ where: { sessionId: event.sessionId } });
    if (!existing) {
      await tx.analyticsSession.create({ data: {
        sessionId: event.sessionId, cartId,
        firstSeenAt: seen, lastSeenAt: seen,
        locale: event.locale, deviceClass: event.deviceClass, marketCode: event.marketCode,
        source: event.source, consentState: event.consentState,
      } });
      return;
    }
    await tx.analyticsSession.update({ where: { sessionId: event.sessionId }, data: {
      ...(cartId && !existing.cartId ? { cartId } : {}),
      lastSeenAt: seen > existing.lastSeenAt ? seen : existing.lastSeenAt,
      ...(!existing.locale && event.locale ? { locale: event.locale } : {}),
      ...(!existing.deviceClass && event.deviceClass ? { deviceClass: event.deviceClass } : {}),
      ...(!existing.marketCode && event.marketCode ? { marketCode: event.marketCode } : {}),
      ...(!existing.source && event.source ? { source: event.source } : {}),
      ...(existing.consentState !== 'granted' && event.consentState === 'granted' ? { consentState: 'granted' } : {}),
    } });
  }

  /**
   * 漏斗聚合的会话/事件数据源：只取 granted 事件（未同意不计转化），按会话去重。
   * 供 ReportsService 复用——相同筛选下页面与导出同一口径。
   */
  async funnelSnapshot(tx: Tx, from: Date, to: Date, filters: Record<string, unknown>) {
    const where: Prisma.AnalyticsEventWhereInput = {
      occurredAt: { gte: from, lt: to }, consentState: 'granted',
      ...(filters['locale'] ? { locale: filters['locale'] as string } : {}),
      ...(filters['deviceClass'] ? { deviceClass: filters['deviceClass'] as string } : {}),
      ...(filters['marketCode'] ? { marketCode: filters['marketCode'] as string } : {}),
      ...(filters['source'] ? { source: filters['source'] as string } : {}),
    };
    const [events, sessions, orders] = await Promise.all([
      tx.analyticsEvent.findMany({ where }),
      tx.analyticsSession.findMany(),
      tx.shopOrder.findMany({ where: {
        placedAt: { gte: from, lt: to }, cartId: { not: null },
        ...(filters['marketCode'] ? { marketCode: filters['marketCode'] as string } : {}),
      } }),
    ]);
    return {
      events: events.map(e => ({ sessionId: e.sessionId, eventName: e.eventName,
        occurredAt: e.occurredAt, deviceClass: e.deviceClass, source: e.source,
        locale: e.locale, marketCode: e.marketCode })),
      sessions: sessions.map(s => ({ sessionId: s.sessionId, cartId: s.cartId,
        deviceClass: s.deviceClass, source: s.source, locale: s.locale, marketCode: s.marketCode })),
      orders: orders.map(o => ({ cartId: o.cartId, placedAt: o.placedAt, currency: o.currency })),
    };
  }
}

/** 供测试/文档断言：事件名闭集不含 purchase。 */
export const BROWSER_EVENT_NAME_SET = new Set(
  ['page_view', 'view_item', 'add_to_cart', 'begin_checkout'],
);
export { funnelStepIndex, countsTowardFunnel };
