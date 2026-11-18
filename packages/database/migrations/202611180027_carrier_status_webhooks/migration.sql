-- 承运商状态回传（M09 剩余，第 27 条迁移）：签名 webhook 的幂等事件台账与包裹当前回传状态。
-- 安全不变量：
-- 1. eventId 唯一，重复回调只落一条；signatureRef 只存签名前缀用于审计，不存完整签名。
-- 2. 表内没有顾客姓名/电话/邮箱/地址/完整 URL/支付凭证列，回调契约同样禁止这些字段。
-- 3. status 是闭集；delivered 只有在包裹已由授权员工 dispatch 后才由服务端推进履约，不采信浏览器事件。

ALTER TABLE "Shipment"
  ADD COLUMN "carrierStatus" TEXT CHECK ("carrierStatus" IS NULL OR "carrierStatus" IN ('in_transit','out_for_delivery','delivered','exception','returned')),
  ADD COLUMN "lastCarrierEventAt" TIMESTAMPTZ(3);

CREATE TABLE "CarrierStatusEvent" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "eventId" TEXT NOT NULL UNIQUE CHECK (length("eventId") BETWEEN 16 AND 128),
  "shipmentId" UUID NOT NULL,
  "carrierCode" TEXT NOT NULL CHECK ("carrierCode" ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  "status" TEXT NOT NULL CHECK ("status" IN ('in_transit','out_for_delivery','delivered','exception','returned')),
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "trackingNumber" TEXT CHECK ("trackingNumber" IS NULL OR length("trackingNumber") BETWEEN 1 AND 160),
  "note" TEXT CHECK ("note" IS NULL OR length("note") BETWEEN 1 AND 500),
  "signatureRef" TEXT NOT NULL CHECK ("signatureRef" ~ '^v1=[0-9a-f]{16}$'),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "carrier_status_event_shipment_fk" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "carrier_status_event_shipment_occurred_idx" ON "CarrierStatusEvent"("shipmentId", "occurredAt");
CREATE INDEX "carrier_status_event_carrier_occurred_idx" ON "CarrierStatusEvent"("carrierCode", "occurredAt");
