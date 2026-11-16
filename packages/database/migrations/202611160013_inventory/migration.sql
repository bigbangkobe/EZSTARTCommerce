-- M12 库存：库存项目获得版本（并发调整的凭据）、流水支持带符号的人工调整与调整原因/凭据，
-- 并新增按变体维护的低库存阈值。既有退货入库流水完全兼容新的约束形状。

ALTER TABLE "InventoryItem"
 ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "InventoryItem"
 ADD CONSTRAINT "InventoryItem_version_positive_check" CHECK ("version" >= 1),
 ADD CONSTRAINT "InventoryItem_onhand_non_negative_check" CHECK ("onHand" >= 0),
 ADD CONSTRAINT "InventoryItem_reserved_non_negative_check" CHECK ("reserved" >= 0);

ALTER TABLE "InventoryMovement"
 ADD COLUMN "reasonCode" TEXT,
 ADD COLUMN "reference" TEXT,
 ADD COLUMN "requestFingerprint" TEXT;

-- 人工调整与退货入库共用一张流水表，但允许的形状不同：
-- 退货入库只能为正且等于数量；人工调整可正可负，quantity 记绝对值，delta 不得为 0。
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_type_check";
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_quantity_check";
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_stockDelta_check";
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_onHandAfter_check";
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_restock_delta_check";
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_onhand_only_on_restock_check";

ALTER TABLE "InventoryMovement"
 ADD CONSTRAINT "InventoryMovement_type_check"
   CHECK ("type" IN ('return_restock','return_damaged','return_quarantine','return_scrap','adjustment')),
 ADD CONSTRAINT "InventoryMovement_quantity_check"
   CHECK (("type" = 'adjustment' AND "quantity" BETWEEN 1 AND 100000)
     OR ("type" <> 'adjustment' AND "quantity" BETWEEN 1 AND 99)),
 ADD CONSTRAINT "InventoryMovement_stockDelta_check"
   CHECK ("stockDelta" <> 0 AND ("type" = 'adjustment' OR "stockDelta" > 0)),
 ADD CONSTRAINT "InventoryMovement_restock_delta_check"
   CHECK ("type" <> 'return_restock' OR "stockDelta" = "quantity"),
 ADD CONSTRAINT "InventoryMovement_adjustment_delta_check"
   CHECK ("type" <> 'adjustment' OR abs("stockDelta") = "quantity"),
 ADD CONSTRAINT "InventoryMovement_onhand_required_check"
   CHECK (("type" IN ('return_restock','adjustment')) = ("onHandAfter" IS NOT NULL)),
 ADD CONSTRAINT "InventoryMovement_reasoncode_check"
   CHECK ("reasonCode" IS NULL OR length(btrim("reasonCode")) BETWEEN 1 AND 80),
 ADD CONSTRAINT "InventoryMovement_reference_check"
   CHECK ("reference" IS NULL OR length(btrim("reference")) BETWEEN 1 AND 200),
 ADD CONSTRAINT "InventoryMovement_fingerprint_check"
   CHECK ("requestFingerprint" IS NULL OR "requestFingerprint" ~ '^[0-9a-f]{64}$');

CREATE INDEX "InventoryMovement_type_createdAt_idx" ON "InventoryMovement" ("type", "createdAt");

CREATE TABLE "InventoryThreshold" (
 "id" UUID PRIMARY KEY,
 "variantId" UUID NOT NULL UNIQUE REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "lowStockLevel" INTEGER NOT NULL DEFAULT 0 CHECK ("lowStockLevel" BETWEEN 0 AND 1000000),
 "updatedBy" UUID,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "InventoryThreshold_lowStockLevel_idx" ON "InventoryThreshold" ("lowStockLevel");
