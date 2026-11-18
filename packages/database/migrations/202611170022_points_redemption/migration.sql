-- 结账积分抵扣（M10 批次八B）。
-- 报价冻结「想用多少、实扣多少、折算多少钱、按哪个口径、绑哪位会员」；
-- 下单在同事务里扣减，订单快照与报价逐项一致，取消/整单退款只补回实扣点数。

-- 原表上的总额恒等式没有减积分项；不换掉它，任何抵扣订单都会被旧约束拒绝。
ALTER TABLE "CheckoutQuote" DROP CONSTRAINT "CheckoutQuote_check1";
ALTER TABLE "ShopOrder" DROP CONSTRAINT "ShopOrder_check1";

ALTER TABLE "CheckoutQuote"
  ADD COLUMN "pointsRequested" INTEGER NOT NULL DEFAULT 0 CHECK ("pointsRequested" >= 0),
  ADD COLUMN "pointsRedeemed" INTEGER NOT NULL DEFAULT 0 CHECK ("pointsRedeemed" >= 0),
  ADD COLUMN "pointsValueMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("pointsValueMinor" >= 0),
  ADD COLUMN "pointsMemberId" UUID REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN "pointsRuleVersion" TEXT,
  ADD CONSTRAINT "checkout_quote_points_pairing" CHECK (
    "pointsRedeemed" = 0 AND "pointsValueMinor" = 0 AND "pointsRuleVersion" IS NULL
    OR "pointsRedeemed" > 0 AND "pointsValueMinor" > 0 AND "pointsMemberId" IS NOT NULL AND "pointsRuleVersion" IS NOT NULL
  ),
  ADD CONSTRAINT "checkout_quote_points_within_merchandise" CHECK ("pointsValueMinor" <= "subtotalMinor" - "discountMinor");

ALTER TABLE "ShopOrder"
  ADD COLUMN "pointsRedeemed" INTEGER NOT NULL DEFAULT 0 CHECK ("pointsRedeemed" >= 0),
  ADD COLUMN "pointsValueMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("pointsValueMinor" >= 0),
  ADD COLUMN "pointsMemberId" UUID REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN "pointsRuleVersion" TEXT,
  ADD CONSTRAINT "shop_order_points_pairing" CHECK (
    "pointsRedeemed" = 0 AND "pointsValueMinor" = 0 AND "pointsRuleVersion" IS NULL
    OR "pointsRedeemed" > 0 AND "pointsValueMinor" > 0 AND "pointsMemberId" IS NOT NULL AND "pointsRuleVersion" IS NOT NULL
  ),
  ADD CONSTRAINT "shop_order_points_within_merchandise" CHECK ("pointsValueMinor" <= "subtotalMinor" - "discountMinor");

ALTER TABLE "CheckoutQuote" ADD CONSTRAINT "CheckoutQuote_check1" CHECK (
  "totalMinor" = "subtotalMinor" - "discountMinor" - "pointsValueMinor" + "shippingMinor" + "taxMinor"
);
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_check1" CHECK (
  "totalMinor" = "subtotalMinor" - "discountMinor" - "pointsValueMinor" + "shippingMinor" + "taxMinor"
);
