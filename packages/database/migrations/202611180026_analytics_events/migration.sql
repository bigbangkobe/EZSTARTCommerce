-- 访问漏斗（M14 第二批，第 26 条迁移）：第一方匿名事件采集。
-- 安全不变量：
-- 1. sessionId 是浏览器随机生成的高熵串，不是购物袋 token、不是邮箱/电话派生值；
--    服务端读 HttpOnly 的 ez_guest_cart 后才把 cartId 写进会话，用于把成功订单权威归因。
-- 2. 两张表在 schema 层就没有 name/email/phone/address/完整 URL/支付凭证列，
--    source 只是 UTM 来源桶（契约限制长度且禁止 URL 形态），pageKey 是页面标识而非 URL。
-- 3. eventId 唯一，重复上报幂等忽略；eventName 闭集不含 purchase（成交只认服务端订单）。
-- 4. 同意状态必填；采集服务在上层还会检查 analytics 开关，未开启时根本不落库。

CREATE TABLE "AnalyticsSession" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "sessionId" TEXT NOT NULL UNIQUE CHECK (length("sessionId") BETWEEN 16 AND 128),
  "cartId" UUID,
  "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
  "locale" TEXT,
  "deviceClass" TEXT CHECK ("deviceClass" IS NULL OR "deviceClass" IN ('desktop','mobile','tablet')),
  "marketCode" TEXT,
  "source" TEXT,
  "consentState" TEXT NOT NULL DEFAULT 'unknown' CHECK ("consentState" IN ('granted','denied','unknown')),
  CONSTRAINT "analytics_session_seen_order" CHECK ("lastSeenAt" >= "firstSeenAt"),
  CONSTRAINT "analytics_session_cart_fk" FOREIGN KEY ("cartId") REFERENCES "GuestCart"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "analytics_session_cart_idx" ON "AnalyticsSession"("cartId");
CREATE INDEX "analytics_session_first_seen_idx" ON "AnalyticsSession"("firstSeenAt");

CREATE TABLE "AnalyticsEvent" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "eventId" TEXT NOT NULL UNIQUE CHECK (length("eventId") BETWEEN 16 AND 128),
  "sessionId" TEXT NOT NULL,
  "eventName" TEXT NOT NULL CHECK ("eventName" IN ('page_view','view_item','add_to_cart','begin_checkout')),
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "schemaVersion" TEXT NOT NULL CHECK ("schemaVersion" ~ '^[0-9]+\.[0-9]+$'),
  "consentState" TEXT NOT NULL CHECK ("consentState" IN ('granted','denied','unknown')),
  "pageKey" TEXT,
  "locale" TEXT,
  "deviceClass" TEXT CHECK ("deviceClass" IS NULL OR "deviceClass" IN ('desktop','mobile','tablet')),
  "marketCode" TEXT,
  "variantId" TEXT,
  "interactionId" TEXT,
  "source" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "analytics_event_session_fk" FOREIGN KEY ("sessionId") REFERENCES "AnalyticsSession"("sessionId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "analytics_event_session_occurred_idx" ON "AnalyticsEvent"("sessionId", "occurredAt");
CREATE INDEX "analytics_event_name_occurred_idx" ON "AnalyticsEvent"("eventName", "occurredAt");
CREATE INDEX "analytics_event_occurred_idx" ON "AnalyticsEvent"("occurredAt");
