-- M11 优惠：券规则模板、订单级核销记录、核销事件与额度返还记录。
-- 报价/订单只保存规则快照；后续改券不改既有订单金额，因此 coupon 只允许停用、不允许删除。

CREATE TABLE "Coupon" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "discountType" TEXT NOT NULL,
  "discountValue" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "validFrom" TIMESTAMPTZ(3) NOT NULL,
  "validUntil" TIMESTAMPTZ(3) NOT NULL,
  "minSubtotalMinor" INTEGER,
  "totalLimit" INTEGER,
  "perCustomerLimit" INTEGER,
  "eligibleProductIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "eligibleCategoryIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "memberTierIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "refundPolicy" TEXT NOT NULL DEFAULT 'none',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Coupon_code_key" UNIQUE ("code"),
  -- 码只保留大写字母/数字/下划线/连字符：避免大小写与空白造成的“同码不同券”。
  CONSTRAINT "Coupon_code_format_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,79}$'),
  CONSTRAINT "Coupon_status_check" CHECK ("status" IN ('active','disabled')),
  CONSTRAINT "Coupon_discount_type_check" CHECK ("discountType" IN ('fixed','percent')),
  -- 百分比用整数 basis points（100 bps = 1%）；固定额用最小货币单位。
  CONSTRAINT "Coupon_discount_value_check"
    CHECK (("discountType" = 'percent' AND "discountValue" BETWEEN 1 AND 10000)
        OR ("discountType" = 'fixed' AND "discountValue" BETWEEN 1 AND 100000000)),
  CONSTRAINT "Coupon_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "Coupon_validity_check" CHECK ("validUntil" > "validFrom"),
  CONSTRAINT "Coupon_min_subtotal_check" CHECK ("minSubtotalMinor" IS NULL OR "minSubtotalMinor" >= 0),
  CONSTRAINT "Coupon_total_limit_check" CHECK ("totalLimit" IS NULL OR "totalLimit" >= 1),
  CONSTRAINT "Coupon_per_customer_limit_check" CHECK ("perCustomerLimit" IS NULL OR "perCustomerLimit" >= 1),
  CONSTRAINT "Coupon_scope_size_check"
    CHECK ((array_length("eligibleProductIds", 1) IS NULL OR array_length("eligibleProductIds", 1) <= 200)
       AND (array_length("eligibleCategoryIds", 1) IS NULL OR array_length("eligibleCategoryIds", 1) <= 200)
       AND (array_length("memberTierIds", 1) IS NULL OR array_length("memberTierIds", 1) <= 50)),
  CONSTRAINT "Coupon_refund_policy_check" CHECK ("refundPolicy" IN ('none','restore')),
  CONSTRAINT "Coupon_version_positive_check" CHECK ("version" >= 1)
);
CREATE INDEX "Coupon_status_validity_idx" ON "Coupon" ("status", "validFrom", "validUntil");
CREATE INDEX "Coupon_created_idx" ON "Coupon" ("createdAt", "id");

-- 一张订单最多一条核销记录：下单（预占）时创建，之后只做状态推进。
CREATE TABLE "CouponRedemption" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "couponId" UUID NOT NULL REFERENCES "Coupon" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "orderId" UUID NOT NULL REFERENCES "ShopOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'reserved',
  "discountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  -- 访客限额用“实例密钥 HMAC(规范化邮箱/电话)”，不落原联系方式。
  "customerKey" TEXT,
  "codeSnapshot" TEXT NOT NULL,
  "ruleSnapshot" JSONB NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "reservedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "redeemedAt" TIMESTAMPTZ(3),
  "releasedAt" TIMESTAMPTZ(3),
  "expiresAt" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CouponRedemption_order_key" UNIQUE ("orderId"),
  CONSTRAINT "CouponRedemption_dedupe_key" UNIQUE ("dedupeKey"),
  CONSTRAINT "CouponRedemption_status_check" CHECK ("status" IN ('reserved','redeemed','released','expired')),
  CONSTRAINT "CouponRedemption_discount_positive_check" CHECK ("discountMinor" >= 1),
  CONSTRAINT "CouponRedemption_redeemed_at_check" CHECK (("status" = 'redeemed') = ("redeemedAt" IS NOT NULL)),
  CONSTRAINT "CouponRedemption_released_at_check" CHECK (("status" = 'released') = ("releasedAt" IS NOT NULL)),
  -- 预占与核销共享 `expiresAt`；已核销的券不再按时间过期。
  CONSTRAINT "CouponRedemption_expiry_check" CHECK ("status" <> 'redeemed' OR "expiresAt" IS NULL),
  CONSTRAINT "CouponRedemption_customer_key_check"
    CHECK ("customerKey" IS NULL OR "customerKey" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CouponRedemption_version_positive_check" CHECK ("version" >= 1)
);
CREATE INDEX "CouponRedemption_coupon_status_idx" ON "CouponRedemption" ("couponId", "status");
CREATE INDEX "CouponRedemption_customer_idx" ON "CouponRedemption" ("couponId", "customerKey");

-- 只追加的核销事件：预占/核销/释放/过期/返还都各留一条，不覆盖历史。
CREATE TABLE "CouponRedemptionEvent" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "redemptionId" UUID NOT NULL REFERENCES "CouponRedemption" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "fromStatus" TEXT,
  "toStatus" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorId" UUID,
  "dedupeKey" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CouponRedemptionEvent_dedupe_key" UNIQUE ("dedupeKey"),
  CONSTRAINT "CouponRedemptionEvent_from_status_check"
    CHECK ("fromStatus" IS NULL OR "fromStatus" IN ('reserved','redeemed','released','expired')),
  CONSTRAINT "CouponRedemptionEvent_to_status_check"
    CHECK ("toStatus" IN ('reserved','redeemed','released','expired')),
  CONSTRAINT "CouponRedemptionEvent_actor_type_check" CHECK ("actorType" IN ('customer','admin','system')),
  CONSTRAINT "CouponRedemptionEvent_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 200)
);
CREATE INDEX "CouponRedemptionEvent_redemption_idx" ON "CouponRedemptionEvent" ("redemptionId", "createdAt", "id");

-- 整单退款完成后按券的 refundPolicy 返还额度：新建一条返还记录，不改原核销历史。
CREATE TABLE "CouponQuotaReturn" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "redemptionId" UUID NOT NULL REFERENCES "CouponRedemption" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "refundId" UUID REFERENCES "Refund" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CouponQuotaReturn_redemption_key" UNIQUE ("redemptionId"),
  CONSTRAINT "CouponQuotaReturn_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 200)
);

ALTER TABLE "CheckoutQuote"
  ADD COLUMN "couponId" UUID REFERENCES "Coupon" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- 报价冻结完整规则快照；下单只复制快照，不按当前规则重算。
  ADD COLUMN "couponSnapshot" JSONB;

ALTER TABLE "ShopOrder"
  ADD COLUMN "couponId" UUID REFERENCES "Coupon" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
