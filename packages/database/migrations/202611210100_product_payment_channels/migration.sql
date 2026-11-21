-- 商品级收款渠道约束 + 订单「必须预付」快照
--
-- 背景：烟草商城的商品并非都能货到付款。高价值或受限商品必须先行付款，
-- 而现有模型只有站点级支付方式，无法表达「这件商品不许 COD」。
--
-- 兼容性：两列都有安全默认值。存量商品取空数组 = 不限（行为完全不变），
-- 存量订单取 false = 不强制预付（发货拦截不会突然生效）。

ALTER TABLE "Product" ADD COLUMN "allowedPaymentChannels" TEXT[] NOT NULL DEFAULT '{}';

-- 值域收在数据库层：应用层白名单之外再加一道，避免脚本或手工 SQL 写进未知渠道，
-- 导致结账时「交集算不出来」这种线上事故。
ALTER TABLE "Product" ADD CONSTRAINT "Product_allowedPaymentChannels_check"
  CHECK ("allowedPaymentChannels" <@ ARRAY['cod', 'manual', 'online']::TEXT[]);

ALTER TABLE "ShopOrder" ADD COLUMN "requiresPrepayment" BOOLEAN NOT NULL DEFAULT false;

-- 未收款强行发货的留痕。为空表示走的是正常放行路径。
ALTER TABLE "ShopOrder" ADD COLUMN "dispatchOverrideReason" TEXT;
ALTER TABLE "ShopOrder" ADD COLUMN "dispatchOverrideAt" TIMESTAMPTZ(3);
