-- 订单履约（M07）：取消、改址、内部备注、包裹与签收，以及后台写操作的幂等表。
-- 本迁移同时把 ShopOrder 的三个状态 CHECK 放宽到契约枚举全集：
-- 第 10 条迁移只允许 “下单后的两个初始状态”，履约状态当时还没有写入路径。

ALTER TABLE "ShopOrder" DROP CONSTRAINT "ShopOrder_orderStatus_check";
ALTER TABLE "ShopOrder" DROP CONSTRAINT "ShopOrder_paymentStatus_check";
ALTER TABLE "ShopOrder" DROP CONSTRAINT "ShopOrder_fulfillmentStatus_check";

ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_orderStatus_check" CHECK ("orderStatus" IN
 ('pending_payment','awaiting_confirmation','confirmed','processing','partially_shipped','shipped','completed','cancelled','on_hold'));
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_paymentStatus_check" CHECK ("paymentStatus" IN
 ('created','requires_action','processing','succeeded','failed','cancelled','unknown','cod_due','collected','rejected','returned'));
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_fulfillmentStatus_check" CHECK ("fulfillmentStatus" IN
 ('unfulfilled','preparing','partially_fulfilled','fulfilled','delivered','exception'));

ALTER TABLE "ShopOrder" ADD COLUMN "cancelledAt" TIMESTAMPTZ(3);
ALTER TABLE "ShopOrder" ADD COLUMN "cancelReasonCode" TEXT;
ALTER TABLE "ShopOrder" ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "ShopOrder" ADD COLUMN "customerNotified" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_cancelReason_check"
 CHECK ("cancelReason" IS NULL OR (length(btrim("cancelReason")) BETWEEN 1 AND 1000));
-- 取消必须有时间与原因；未取消的订单不允许残留这两个字段，避免“取消了但看起来没取消”。
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_cancelledAt_check"
 CHECK (("orderStatus" = 'cancelled') = ("cancelledAt" IS NOT NULL));

CREATE TABLE "OrderNote" (
 "id" UUID PRIMARY KEY,
 "orderId" UUID NOT NULL REFERENCES "ShopOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "note" TEXT NOT NULL CHECK (length(btrim("note")) BETWEEN 1 AND 1000),
 "authorId" UUID,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OrderNote_orderId_createdAt_idx" ON "OrderNote"("orderId", "createdAt");

CREATE TABLE "OrderAction" (
 "id" UUID PRIMARY KEY,
 "idempotencyKey" TEXT NOT NULL CHECK (length("idempotencyKey") BETWEEN 16 AND 128),
 "orderId" UUID NOT NULL REFERENCES "ShopOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "action" TEXT NOT NULL CHECK ("action" ~ '^[a-z][a-z0-9_.]{0,63}$'),
 "requestDigest" TEXT NOT NULL CHECK ("requestDigest" ~ '^[0-9a-f]{64}$'),
 "objectId" UUID,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "OrderAction_idempotencyKey_key" UNIQUE ("idempotencyKey")
);
CREATE INDEX "OrderAction_orderId_idx" ON "OrderAction"("orderId");

CREATE TABLE "Shipment" (
 "id" UUID PRIMARY KEY,
 "orderId" UUID NOT NULL REFERENCES "ShopOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "status" TEXT NOT NULL DEFAULT 'created' CHECK ("status" IN ('created','dispatched','delivered','cancelled')),
 "carrierCode" TEXT CHECK ("carrierCode" IS NULL OR length(btrim("carrierCode")) BETWEEN 1 AND 80),
 "carrierName" TEXT CHECK ("carrierName" IS NULL OR length(btrim("carrierName")) BETWEEN 1 AND 120),
 "trackingNumber" TEXT CHECK ("trackingNumber" IS NULL OR length(btrim("trackingNumber")) BETWEEN 1 AND 160),
 "note" TEXT CHECK ("note" IS NULL OR length("note") <= 1000),
 "dispatchedAt" TIMESTAMPTZ(3),
 "deliveredAt" TIMESTAMPTZ(3),
 "evidenceRef" TEXT,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 -- 发货与签收时间不能凭空出现：状态和时间必须同时成立。
 CHECK (("status" IN ('dispatched','delivered')) = ("dispatchedAt" IS NOT NULL)),
 CHECK (("status" = 'delivered') = ("deliveredAt" IS NOT NULL))
);
CREATE INDEX "Shipment_orderId_createdAt_idx" ON "Shipment"("orderId", "createdAt");

CREATE TABLE "ShipmentItem" (
 "id" UUID PRIMARY KEY,
 "shipmentId" UUID NOT NULL REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "orderItemId" UUID NOT NULL REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "quantity" INTEGER NOT NULL CHECK ("quantity" BETWEEN 1 AND 99),
 CONSTRAINT "ShipmentItem_shipmentId_orderItemId_key" UNIQUE ("shipmentId", "orderItemId")
);
CREATE INDEX "ShipmentItem_orderItemId_idx" ON "ShipmentItem"("orderItemId");

CREATE TABLE "OrderAddressChange" (
 "id" UUID PRIMARY KEY,
 "orderId" UUID NOT NULL REFERENCES "ShopOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "previousAddress" JSONB,
 "newAddress" JSONB NOT NULL,
 "shippingMinorBefore" INTEGER NOT NULL CHECK ("shippingMinorBefore" >= 0),
 "shippingMinorAfter" INTEGER NOT NULL CHECK ("shippingMinorAfter" >= 0),
 "totalMinorBefore" INTEGER NOT NULL CHECK ("totalMinorBefore" >= 0),
 "totalMinorAfter" INTEGER NOT NULL CHECK ("totalMinorAfter" >= 0),
 "customerConfirmationRef" TEXT,
 "actorId" UUID,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OrderAddressChange_orderId_createdAt_idx" ON "OrderAddressChange"("orderId", "createdAt");
