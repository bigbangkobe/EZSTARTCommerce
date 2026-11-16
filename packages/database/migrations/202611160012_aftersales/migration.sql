-- 售后案件、退货质检与退款（M16 第一批）。
-- 这里的约束只兜“记录自身是否自洽”，业务上限（累计数量、可退余额）由服务层在事务内判定：
-- 1. 批准金额必须有批准时间和批准人，不能出现“批了钱但没人批”。
-- 2. 退款成功必须有执行时间和执行人；退回的商品在质检前不增加可售库存。
-- 3. 同一案件行的退货入库只能记一次（dedupeKey 唯一），避免重复加回库存。

CREATE TABLE "AfterSalesCase" (
 "id" UUID PRIMARY KEY,
 "publicCaseNumber" TEXT NOT NULL CHECK ("publicCaseNumber" ~ '^AS-[0-9]{8}-[A-Z0-9]{6}$'),
 "orderId" UUID NOT NULL REFERENCES "ShopOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "caseType" TEXT NOT NULL CHECK ("caseType" IN ('cancel','refund','return','exchange')),
 "status" TEXT NOT NULL DEFAULT 'submitted' CHECK ("status" IN
   ('submitted','under_review','approved','rejected','needs_information','return_in_transit',
    'received_inspection','refund_pending','refunded','replacement_sent','completed','closed')),
 "reasonCode" TEXT CHECK ("reasonCode" IS NULL OR "reasonCode" ~ '^[a-z0-9][a-z0-9_]{0,79}$'),
 "reason" TEXT NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 1000),
 "source" TEXT NOT NULL DEFAULT 'admin' CHECK ("source" IN ('admin','customer')),
 "requestedRefundMinor" INTEGER CHECK ("requestedRefundMinor" IS NULL OR "requestedRefundMinor" >= 0),
 "approvedRefundMinor" INTEGER CHECK ("approvedRefundMinor" IS NULL OR "approvedRefundMinor" >= 0),
 "ownerId" UUID,
 "approvedAt" TIMESTAMPTZ(3),
 "approvedBy" UUID,
 "rejectedAt" TIMESTAMPTZ(3),
 "rejectedBy" UUID,
 "rejectReason" TEXT CHECK ("rejectReason" IS NULL OR length(btrim("rejectReason")) BETWEEN 1 AND 1000),
 "closedAt" TIMESTAMPTZ(3),
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AfterSalesCase_publicCaseNumber_key" UNIQUE ("publicCaseNumber"),
 -- 批准时间与批准人是一对；批准金额不能脱离批准记录存在。
 CONSTRAINT "AfterSalesCase_approval_pair_check"
   CHECK (("approvedAt" IS NULL) = ("approvedBy" IS NULL)),
 CONSTRAINT "AfterSalesCase_approved_amount_requires_approval_check"
   CHECK ("approvedRefundMinor" IS NULL OR "approvedAt" IS NOT NULL),
 CONSTRAINT "AfterSalesCase_rejection_pair_check"
   CHECK (("rejectedAt" IS NULL) = ("rejectedBy" IS NULL)),
 -- 进入处理中之后的状态必须已有批准记录，不能靠改状态绕过审核。
 CONSTRAINT "AfterSalesCase_status_requires_approval_check"
   CHECK ("status" NOT IN ('approved','return_in_transit','received_inspection','refund_pending','refunded',
     'replacement_sent','completed','closed') OR "approvedAt" IS NOT NULL),
 CONSTRAINT "AfterSalesCase_rejected_status_check"
   CHECK ("status" <> 'rejected' OR ("rejectedAt" IS NOT NULL AND "rejectReason" IS NOT NULL)),
 CONSTRAINT "AfterSalesCase_completed_closed_check"
   CHECK (("status" IN ('completed','closed')) = ("closedAt" IS NOT NULL))
);
CREATE INDEX "AfterSalesCase_orderId_createdAt_idx" ON "AfterSalesCase" ("orderId", "createdAt");
CREATE INDEX "AfterSalesCase_status_createdAt_idx" ON "AfterSalesCase" ("status", "createdAt");
CREATE INDEX "AfterSalesCase_caseType_createdAt_idx" ON "AfterSalesCase" ("caseType", "createdAt");

CREATE TABLE "AfterSalesItem" (
 "id" UUID PRIMARY KEY,
 "caseId" UUID NOT NULL REFERENCES "AfterSalesCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "orderItemId" UUID NOT NULL REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "requestedQuantity" INTEGER NOT NULL CHECK ("requestedQuantity" BETWEEN 1 AND 99),
 "approvedQuantity" INTEGER CHECK ("approvedQuantity" IS NULL OR "approvedQuantity" BETWEEN 0 AND 99),
 "amountMinor" INTEGER CHECK ("amountMinor" IS NULL OR "amountMinor" >= 0),
 "disposition" TEXT CHECK ("disposition" IS NULL OR "disposition" IN ('sellable','damaged','quarantine','scrap')),
 -- 批准数量不能多于申请数量；金额是“批准后”才有的快照，不能先有金额再补数量。
 CONSTRAINT "AfterSalesItem_approved_le_requested_check"
   CHECK ("approvedQuantity" IS NULL OR "approvedQuantity" <= "requestedQuantity"),
 CONSTRAINT "AfterSalesItem_amount_requires_quantity_check"
   CHECK ("amountMinor" IS NULL OR "approvedQuantity" IS NOT NULL),
 CONSTRAINT "AfterSalesItem_case_line_key" UNIQUE ("caseId", "orderItemId")
);
CREATE INDEX "AfterSalesItem_orderItemId_idx" ON "AfterSalesItem" ("orderItemId");

CREATE TABLE "Refund" (
 "id" UUID PRIMARY KEY,
 "publicRefundNumber" TEXT NOT NULL CHECK ("publicRefundNumber" ~ '^REF-[0-9]{8}-[A-Z0-9]{6}$'),
 "idempotencyKey" TEXT NOT NULL CHECK (length("idempotencyKey") BETWEEN 16 AND 128),
 "requestDigest" TEXT NOT NULL CHECK ("requestDigest" ~ '^[0-9a-f]{64}$'),
 "orderId" UUID NOT NULL REFERENCES "ShopOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "paymentId" UUID NOT NULL REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "caseId" UUID REFERENCES "AfterSalesCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "channel" TEXT NOT NULL CHECK ("channel" IN ('cod','manual','online')),
 "providerCode" TEXT NOT NULL CHECK ("providerCode" ~ '^[a-z][a-z0-9_]{1,31}$'),
 "environment" TEXT NOT NULL CHECK ("environment" IN ('sandbox','production')),
 "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" > 0),
 "currency" TEXT NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
 "status" TEXT NOT NULL DEFAULT 'requested' CHECK ("status" IN
   ('requested','approved','processing','refunded','failed','rejected','cancelled','unknown')),
 "reasonCode" TEXT CHECK ("reasonCode" IS NULL OR "reasonCode" ~ '^[a-z0-9][a-z0-9_]{0,79}$'),
 "reason" TEXT NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 1000),
 "requestedBy" UUID NOT NULL,
 "approvedBy" UUID,
 "executedBy" UUID,
 "approvedAt" TIMESTAMPTZ(3),
 "executedAt" TIMESTAMPTZ(3),
 "externalRefundId" TEXT CHECK ("externalRefundId" IS NULL OR length(btrim("externalRefundId")) BETWEEN 1 AND 160),
 "reference" TEXT CHECK ("reference" IS NULL OR length(btrim("reference")) BETWEEN 1 AND 200),
 "failureCode" TEXT CHECK ("failureCode" IS NULL OR length(btrim("failureCode")) BETWEEN 1 AND 80),
 "failureMessage" TEXT CHECK ("failureMessage" IS NULL OR length("failureMessage") <= 1000),
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "Refund_publicRefundNumber_key" UNIQUE ("publicRefundNumber"),
 CONSTRAINT "Refund_idempotencyKey_key" UNIQUE ("idempotencyKey"),
 CONSTRAINT "Refund_approval_pair_check"
   CHECK (("approvedAt" IS NULL) = ("approvedBy" IS NULL)),
 -- 审批前不能执行；执行成功必须有执行时间和执行人。
 CONSTRAINT "Refund_status_requires_approval_check"
   CHECK ("status" NOT IN ('approved','processing','refunded') OR "approvedAt" IS NOT NULL),
 CONSTRAINT "Refund_requested_not_approved_check"
   CHECK ("status" <> 'requested' OR "approvedAt" IS NULL),
 CONSTRAINT "Refund_refunded_requires_execution_check"
   CHECK ("status" <> 'refunded' OR ("executedAt" IS NOT NULL AND "executedBy" IS NOT NULL))
);
CREATE INDEX "Refund_orderId_createdAt_idx" ON "Refund" ("orderId", "createdAt");
CREATE INDEX "Refund_paymentId_status_idx" ON "Refund" ("paymentId", "status");
CREATE INDEX "Refund_status_createdAt_idx" ON "Refund" ("status", "createdAt");
CREATE INDEX "Refund_caseId_idx" ON "Refund" ("caseId");

CREATE TABLE "RefundEvent" (
 "id" UUID PRIMARY KEY,
 "refundId" UUID NOT NULL REFERENCES "Refund"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "type" TEXT NOT NULL CHECK ("type" IN ('requested','approved','rejected','executed','failed','cancelled','unknown')),
 "fromStatus" TEXT,
 "toStatus" TEXT NOT NULL CHECK ("toStatus" IN
   ('requested','approved','processing','refunded','failed','rejected','cancelled','unknown')),
 "source" TEXT NOT NULL CHECK ("source" IN ('admin','system','provider')),
 "actorId" UUID,
 "dedupeKey" TEXT NOT NULL CHECK (length("dedupeKey") BETWEEN 3 AND 160),
 "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
 "occurredAt" TIMESTAMPTZ(3) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "RefundEvent_dedupeKey_key" UNIQUE ("dedupeKey")
);
CREATE INDEX "RefundEvent_refundId_occurredAt_idx" ON "RefundEvent" ("refundId", "occurredAt");

CREATE TABLE "ReturnShipment" (
 "id" UUID PRIMARY KEY,
 "caseId" UUID NOT NULL REFERENCES "AfterSalesCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "carrierCode" TEXT CHECK ("carrierCode" IS NULL OR length(btrim("carrierCode")) BETWEEN 1 AND 80),
 "carrierName" TEXT CHECK ("carrierName" IS NULL OR length(btrim("carrierName")) BETWEEN 1 AND 120),
 "trackingNumber" TEXT CHECK ("trackingNumber" IS NULL OR length(btrim("trackingNumber")) BETWEEN 1 AND 160),
 "status" TEXT NOT NULL DEFAULT 'in_transit' CHECK ("status" IN ('in_transit','received')),
 "shippedAt" TIMESTAMPTZ(3),
 "receivedAt" TIMESTAMPTZ(3),
 "reference" TEXT CHECK ("reference" IS NULL OR length(btrim("reference")) BETWEEN 1 AND 200),
 "note" TEXT CHECK ("note" IS NULL OR length("note") <= 1000),
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 -- 寄回必须有寄出时间；签收必须有签收时间，两者不能互相冒充。
 CONSTRAINT "ReturnShipment_shipped_check" CHECK ("status" <> 'in_transit' OR "shippedAt" IS NOT NULL),
 CONSTRAINT "ReturnShipment_received_check" CHECK ("status" <> 'received' OR "receivedAt" IS NOT NULL)
);
CREATE INDEX "ReturnShipment_caseId_createdAt_idx" ON "ReturnShipment" ("caseId", "createdAt");

CREATE TABLE "ReturnReceipt" (
 "id" UUID PRIMARY KEY,
 "caseId" UUID NOT NULL REFERENCES "AfterSalesCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "shipmentId" UUID REFERENCES "ReturnShipment"("id") ON DELETE SET NULL ON UPDATE CASCADE,
 "receivedAt" TIMESTAMPTZ(3) NOT NULL,
 "reference" TEXT CHECK ("reference" IS NULL OR length(btrim("reference")) BETWEEN 1 AND 200),
 "actorId" UUID,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ReturnReceipt_caseId_receivedAt_idx" ON "ReturnReceipt" ("caseId", "receivedAt");

CREATE TABLE "ReturnReceiptItem" (
 "id" UUID PRIMARY KEY,
 "receiptId" UUID NOT NULL REFERENCES "ReturnReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "orderItemId" UUID NOT NULL REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "quantity" INTEGER NOT NULL CHECK ("quantity" BETWEEN 1 AND 99),
 CONSTRAINT "ReturnReceiptItem_receipt_line_key" UNIQUE ("receiptId", "orderItemId")
);
CREATE INDEX "ReturnReceiptItem_orderItemId_idx" ON "ReturnReceiptItem" ("orderItemId");

CREATE TABLE "InspectionRecord" (
 "id" UUID PRIMARY KEY,
 "caseId" UUID NOT NULL REFERENCES "AfterSalesCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "receiptId" UUID REFERENCES "ReturnReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE,
 "orderItemId" UUID NOT NULL REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "quantity" INTEGER NOT NULL CHECK ("quantity" BETWEEN 1 AND 99),
 "disposition" TEXT NOT NULL CHECK ("disposition" IN ('sellable','damaged','quarantine','scrap')),
 "note" TEXT CHECK ("note" IS NULL OR length("note") <= 1000),
 "actorId" UUID,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "InspectionRecord_caseId_createdAt_idx" ON "InspectionRecord" ("caseId", "createdAt");

CREATE TABLE "InventoryMovement" (
 "id" UUID PRIMARY KEY,
 "variantId" UUID NOT NULL REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "orderId" UUID REFERENCES "ShopOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE,
 "caseId" UUID REFERENCES "AfterSalesCase"("id") ON DELETE SET NULL ON UPDATE CASCADE,
 "type" TEXT NOT NULL CHECK ("type" IN ('return_restock','return_damaged','return_quarantine','return_scrap')),
 "quantity" INTEGER NOT NULL CHECK ("quantity" BETWEEN 1 AND 99),
 "stockDelta" INTEGER NOT NULL DEFAULT 0 CHECK ("stockDelta" >= 0),
 "onHandAfter" INTEGER CHECK ("onHandAfter" IS NULL OR "onHandAfter" >= 0),
 "reason" TEXT NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 1000),
 "dedupeKey" TEXT NOT NULL CHECK (length("dedupeKey") BETWEEN 3 AND 160),
 "actorId" UUID,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "InventoryMovement_dedupeKey_key" UNIQUE ("dedupeKey"),
 -- 只有“可重新入库”才允许增加可售库存；其余处置只记录去向。
 CONSTRAINT "InventoryMovement_restock_delta_check"
   CHECK (("type" = 'return_restock') = ("stockDelta" = "quantity")),
 CONSTRAINT "InventoryMovement_onhand_only_on_restock_check"
   CHECK (("onHandAfter" IS NULL) = ("type" <> 'return_restock'))
);
CREATE INDEX "InventoryMovement_variantId_createdAt_idx" ON "InventoryMovement" ("variantId", "createdAt");
CREATE INDEX "InventoryMovement_caseId_idx" ON "InventoryMovement" ("caseId");

CREATE TABLE "AfterSalesEvent" (
 "id" UUID PRIMARY KEY,
 "caseId" UUID NOT NULL REFERENCES "AfterSalesCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "type" TEXT NOT NULL CHECK ("type" IN
   ('created','approved','rejected','return_registered','received','inspected','refund_requested','refunded','closed')),
 "fromStatus" TEXT,
 "toStatus" TEXT NOT NULL CHECK ("toStatus" IN
   ('submitted','under_review','approved','rejected','needs_information','return_in_transit',
    'received_inspection','refund_pending','refunded','replacement_sent','completed','closed')),
 "note" TEXT CHECK ("note" IS NULL OR length("note") <= 1000),
 "actorId" UUID,
 "dedupeKey" TEXT NOT NULL CHECK (length("dedupeKey") BETWEEN 3 AND 160),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AfterSalesEvent_dedupeKey_key" UNIQUE ("dedupeKey")
);
CREATE INDEX "AfterSalesEvent_caseId_createdAt_idx" ON "AfterSalesEvent" ("caseId", "createdAt");
