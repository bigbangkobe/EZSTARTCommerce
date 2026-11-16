-- 媒体（M02）：对象存储保存二进制，数据库只保存元数据与校验摘要。
-- 约束与契约一致：仅三种图片 MIME、单文件上限 10 MiB、摘要必须是 64 位小写十六进制。

CREATE TABLE "MediaAsset" (
 "id" UUID PRIMARY KEY,
 "objectKey" TEXT NOT NULL,
 "contentType" TEXT NOT NULL CHECK ("contentType" IN ('image/jpeg','image/png','image/webp')),
 "sizeBytes" INTEGER NOT NULL CHECK ("sizeBytes" BETWEEN 1 AND 10485760),
 "sha256" TEXT CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
 "width" INTEGER CHECK ("width" IS NULL OR "width" BETWEEN 1 AND 12000),
 "height" INTEGER CHECK ("height" IS NULL OR "height" BETWEEN 1 AND 12000),
 "originalFileName" TEXT NOT NULL CHECK (length(btrim("originalFileName")) BETWEEN 1 AND 255),
 "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','ready')),
 "uploadedBy" UUID,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "MediaAsset_objectKey_key" UNIQUE ("objectKey"),
 -- 只有确认过的媒体才允许缺摘要与尺寸字段保持为空之外的状态：pending 行不能对外可见。
 CHECK ("status" = 'pending' OR ("sha256" IS NOT NULL AND "width" IS NOT NULL AND "height" IS NOT NULL))
);
CREATE INDEX "MediaAsset_status_createdAt_idx" ON "MediaAsset"("status", "createdAt");

-- 引用完整性：被商品/品牌/店铺使用的媒体不能被删除，避免前台出现空图位。
ALTER TABLE "StoreConfig" ADD CONSTRAINT "StoreConfig_logoMediaId_fkey"
 FOREIGN KEY ("logoMediaId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreConfig" ADD CONSTRAINT "StoreConfig_faviconMediaId_fkey"
 FOREIGN KEY ("faviconMediaId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_logoMediaId_fkey"
 FOREIGN KEY ("logoMediaId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_mediaId_fkey"
 FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
