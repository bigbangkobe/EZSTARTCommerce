-- 积分到期（M10 第五批）。
--
-- 到期是发放时的快照，不是读取时的配置：每笔 earn 在入账时就写死 expiresAt，
-- 之后改配置只影响未来的发放（与「规则变更只影响未来计算」的总口径一致）。
-- 人工补发（adjust）是补偿性质，不随配置过期，CHECK 保证只有 earn 行能带到期时间。
-- 过期本身不是 DELETE：到期的点由追加的 expire 流水（entryType='expire'，
-- sourceRef 指向原 earn 行，幂等键 expire:{earnId}）从余额里扣掉，账面全程可对。

ALTER TABLE "PointLedger" ADD COLUMN "expiresAt" TIMESTAMPTZ(3);
ALTER TABLE "PointLedger"
 ADD CONSTRAINT "point_ledger_expiry_earn_only" CHECK ("expiresAt" IS NULL OR "entryType" = 'earn');
CREATE INDEX "point_ledger_expiry_idx" ON "PointLedger"("expiresAt") WHERE "expiresAt" IS NOT NULL;
