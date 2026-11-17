-- 「收到但不可卖」的处置（damaged/quarantine/scrap）必须留流水，但不能动库存。
-- 原约束 "stockDelta" <> 0 会把这些记录直接拒掉，与质检业务的真实语义冲突：
-- 货确实入库了，只是没进可售库存。改成按类型分档，并把非法组合继续拦下。
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_stockDelta_check";

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_stockDelta_check"
  CHECK (
    ("type" = 'adjustment' AND "stockDelta" <> 0)
    OR ("type" = 'return_restock' AND "stockDelta" > 0)
    OR ("type" IN ('return_damaged','return_quarantine','return_scrap') AND "stockDelta" = 0)
  );

-- 预留行在「全部发出」后必然剩 0：保留该行是为了让历史可追溯，不是继续占额度。
-- 原 CHECK 要求 quantity >= 1，会让最后一件发货直接 500（dispatch 无法把 active 转 committed）。
ALTER TABLE "InventoryReservation" DROP CONSTRAINT "InventoryReservation_quantity_check";

ALTER TABLE "InventoryReservation"
  ADD CONSTRAINT "InventoryReservation_quantity_check"
  CHECK ("quantity" BETWEEN 0 AND 99);
