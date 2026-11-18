-- 区块陈列效果分析（M14 P1，第 28 条迁移）。
-- 安全不变量：
-- 1. 事件与归因表都没有 name/email/phone/address/完整 URL/支付凭证列；
--    sectionKey/sectionId/placementId 是主题注册的匿名标识，publishVersionId 是发布版本标记。
-- 2. environment 区分 production/preview/staff/sandbox，正式指标只取 production；
--    trafficClass 允许 suspected_bot 标记但保留原始事件，便于审计而不静默删除。
-- 3. 归因行由服务端在「成功加购」后写入，浏览器不能直接写；orderItemId 唯一，
--    一个订单行最多归因给一个区块。
-- 4. 订单行只在 24 小时窗口内回填归因，过期交互留在台账但不归因。

ALTER TABLE "AnalyticsEvent" DROP CONSTRAINT IF EXISTS "AnalyticsEvent_eventName_check";
ALTER TABLE "AnalyticsEvent"
  ADD COLUMN "sectionId" TEXT,
  ADD COLUMN "sectionKey" TEXT,
  ADD COLUMN "placementId" TEXT,
  ADD COLUMN "publishVersionId" TEXT,
  ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'production',
  ADD COLUMN "trafficClass" TEXT NOT NULL DEFAULT 'human';

ALTER TABLE "AnalyticsEvent"
  ADD CONSTRAINT "analytics_event_name_check" CHECK ("eventName" IN
    ('page_view','view_item','add_to_cart','begin_checkout','section_impression','section_click')),
  ADD CONSTRAINT "analytics_event_section_check" CHECK (
    ("eventName" NOT IN ('section_impression','section_click'))
    OR ("sectionId" IS NOT NULL AND "sectionKey" IS NOT NULL)),
  ADD CONSTRAINT "analytics_event_environment_check" CHECK ("environment" IN
    ('production','preview','staff','sandbox')),
  ADD CONSTRAINT "analytics_event_traffic_check" CHECK ("trafficClass" IN ('human','suspected_bot'));

CREATE INDEX "analytics_event_section_occurred_idx" ON "AnalyticsEvent"("sectionKey", "occurredAt");

CREATE TABLE "PlacementAttribution" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "cartId" UUID,
  "variantId" UUID NOT NULL,
  "productId" UUID,
  "orderItemId" UUID UNIQUE,
  "sectionId" TEXT NOT NULL CHECK (length("sectionId") BETWEEN 1 AND 128),
  "sectionKey" TEXT NOT NULL CHECK ("sectionKey" ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$'),
  "placementId" TEXT,
  "publishVersionId" TEXT NOT NULL CHECK ("publishVersionId" ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  "interactionId" TEXT NOT NULL CHECK ("interactionId" ~ '^[A-Za-z0-9_-]{16,128}$'),
  "pageKey" TEXT,
  "sessionId" TEXT,
  "locale" TEXT,
  "deviceClass" TEXT CHECK ("deviceClass" IS NULL OR "deviceClass" IN ('desktop','mobile','tablet')),
  "marketCode" TEXT,
  "consentState" TEXT NOT NULL DEFAULT 'granted' CHECK ("consentState" IN ('granted','denied','unknown')),
  "ruleVersion" TEXT NOT NULL,
  "addedAt" TIMESTAMPTZ(3) NOT NULL,
  "attributedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "placement_attribution_order_item_fk" FOREIGN KEY ("orderItemId")
    REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "placement_attribution_attributed_after_added" CHECK
    ("attributedAt" IS NULL OR "attributedAt" >= "addedAt")
);
CREATE INDEX "placement_attribution_added_idx" ON "PlacementAttribution"("addedAt");
CREATE INDEX "placement_attribution_section_added_idx" ON "PlacementAttribution"("sectionKey", "addedAt");
CREATE INDEX "placement_attribution_cart_variant_idx" ON "PlacementAttribution"("cartId", "variantId");
CREATE INDEX "placement_attribution_version_added_idx" ON "PlacementAttribution"("publishVersionId", "addedAt");
