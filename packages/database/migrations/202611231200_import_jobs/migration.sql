-- 商品批量导入任务（M05）——
-- 背景：客户上架靠后台表单逐条录入，50 个 SKU × 三语要手点 150 次，不可行。
-- 契约 /admin/import-jobs 早已定义四步（create → validate → execute → cancel），本表补上落地点。
--
-- 设计要点：
-- 1. 状态闭集由 CHECK 硬约束，应用层写错状态直接失败，不留「状态说完成、行没写完」的中间态。
-- 2. fileSha256 落库并在执行时二次比对：预览之后换文件必须重新校验，不能拿旧预览执行新数据。
-- 3. preview / errorReport 存校验快照与逐行错误，执行阶段不再重新解析文件（解析结果就是操作员确认过的那份）。
-- 4. 计数列非负：完成态与计数不一致时能一眼看出来，而不是靠再算一遍。
CREATE TABLE "ImportJob" (
  "id"             UUID         NOT NULL,
  "status"         TEXT         NOT NULL DEFAULT 'uploaded',
  "format"         TEXT         NOT NULL,
  "mode"           TEXT         NOT NULL,
  "commitMode"     TEXT         NOT NULL,
  "fileObjectKey"  TEXT         NOT NULL,
  "fileSha256"     CHAR(64)     NOT NULL,
  "columnMapping"  JSONB        NOT NULL,
  "localeSet"      TEXT[]       NOT NULL,
  "mappingVersion" INTEGER      NOT NULL DEFAULT 1,
  "totalRows"      INTEGER      NOT NULL DEFAULT 0,
  "validRows"      INTEGER      NOT NULL DEFAULT 0,
  "invalidRows"    INTEGER      NOT NULL DEFAULT 0,
  "createdCount"   INTEGER      NOT NULL DEFAULT 0,
  "updatedCount"   INTEGER      NOT NULL DEFAULT 0,
  "skippedCount"   INTEGER      NOT NULL DEFAULT 0,
  "failedCount"    INTEGER      NOT NULL DEFAULT 0,
  "preview"        JSONB,
  "errorReport"    JSONB,
  "idempotencyKey" TEXT,
  "createdBy"      UUID         NOT NULL,
  "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "validatedAt"    TIMESTAMPTZ(3),
  "completedAt"    TIMESTAMPTZ(3),
  CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportJob_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ImportJob_status_check" CHECK ("status" IN ('uploaded','validating','ready','processing','completed','completed_with_errors','failed','cancelled')),
  CONSTRAINT "ImportJob_format_check" CHECK ("format" IN ('csv','xlsx')),
  CONSTRAINT "ImportJob_mode_check" CHECK ("mode" IN ('create_or_update_by_sku','create_only','update_only')),
  CONSTRAINT "ImportJob_commit_mode_check" CHECK ("commitMode" IN ('valid_rows','atomic')),
  CONSTRAINT "ImportJob_sha_check" CHECK ("fileSha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ImportJob_mapping_version_check" CHECK ("mappingVersion" >= 1),
  CONSTRAINT "ImportJob_counts_check" CHECK ("totalRows" >= 0 AND "validRows" >= 0 AND "invalidRows" >= 0
    AND "createdCount" >= 0 AND "updatedCount" >= 0 AND "skippedCount" >= 0 AND "failedCount" >= 0),
  CONSTRAINT "ImportJob_locales_check" CHECK (array_length("localeSet", 1) >= 1
    AND "localeSet" <@ ARRAY['zh-CN','zh-HK','en']::TEXT[]),
  CONSTRAINT "ImportJob_completed_check" CHECK (("status" IN ('completed','completed_with_errors')) = ("completedAt" IS NOT NULL))
);

-- 同一幂等键只产生一个任务：重复提交（网络重试、双击）拿到同一个任务而不是第二份导入。
CREATE UNIQUE INDEX "ImportJob_idempotencyKey_key" ON "ImportJob" ("idempotencyKey");
-- 队列与列表页都按状态 + 时间取，避免全表扫描。
CREATE INDEX "ImportJob_status_createdAt_idx" ON "ImportJob" ("status", "createdAt");
CREATE INDEX "ImportJob_createdBy_idx" ON "ImportJob" ("createdBy");
