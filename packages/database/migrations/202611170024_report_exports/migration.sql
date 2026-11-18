-- 交易经营报表导出（M14 第一批，第 25 条迁移）：异步任务与短时下载。
-- 报表是服务端权威数据的只读聚合，导出结果是聚合数值，不含联系方式/订单明细，
-- 因此 CSV 以明文存储在 content 列即可——没有个人资料需要加密。
-- 下载 URL 用任务 id（UUID，不可枚举）并在 expiresAt 后失效，避免生成长期有效的公开链接。

CREATE TABLE "ReportExport" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "requestedBy" UUID NOT NULL,
  "reportKey" TEXT NOT NULL CHECK (length("reportKey") BETWEEN 1 AND 64),
  "format" TEXT NOT NULL DEFAULT 'csv' CHECK ("format" IN ('csv')),
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','completed','failed')),
  "filters" JSONB NOT NULL,
  "includePii" BOOLEAN NOT NULL DEFAULT false,
  "fileName" TEXT,
  "rowCount" INTEGER,
  "errorCode" TEXT,
  "content" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "completedAt" TIMESTAMPTZ(3),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "report_export_completed_fields" CHECK (
    ("status" = 'pending' AND "completedAt" IS NULL)
    OR ("status" IN ('completed','failed') AND "completedAt" IS NOT NULL)
  )
);

CREATE INDEX "report_export_requested_idx" ON "ReportExport"("requestedBy", "createdAt" DESC);
CREATE INDEX "report_export_expires_idx" ON "ReportExport"("expiresAt");
