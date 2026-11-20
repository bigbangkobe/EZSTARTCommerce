-- 主题配置（配置驱动前台，重做方案 P1）。
-- 不变量：
-- 1. 单行：singletonKey 唯一且固定为 'main'，一个实例只有一份主题。
-- 2. 草稿（draftConfig）与线上（publishedSnapshot）分离：保存草稿永远不改变线上外观。
-- 3. 每次发布写一条不可变 ThemeVersion；版本号在单行内递增且唯一。
-- 4. 发布快照必须是对象，避免前台读到半截数据后渲染出空页面。
-- 5. 不含任何顾客数据：主题配置只有品牌、视觉 tokens、区块编排与导航。

CREATE TABLE "ThemeConfig" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "singletonKey" TEXT NOT NULL UNIQUE DEFAULT 'main' CHECK ("singletonKey" = 'main'),
  "status" TEXT NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft','published')),
  "draftConfig" JSONB NOT NULL CHECK (jsonb_typeof("draftConfig") = 'object'),
  "publishedSnapshot" JSONB CHECK ("publishedSnapshot" IS NULL OR jsonb_typeof("publishedSnapshot") = 'object'),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "publishedAt" TIMESTAMPTZ(3),
  "publishedBy" UUID,
  "createdBy" UUID,
  "updatedBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "theme_published_consistent"
    CHECK (("status" = 'draft' AND "publishedSnapshot" IS NULL AND "publishedAt" IS NULL)
        OR ("status" = 'published' AND "publishedSnapshot" IS NOT NULL AND "publishedAt" IS NOT NULL))
);

CREATE TABLE "ThemeVersion" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "themeId" UUID NOT NULL REFERENCES "ThemeConfig"("id") ON DELETE CASCADE,
  "version" INTEGER NOT NULL CHECK ("version" >= 1),
  "snapshot" JSONB NOT NULL CHECK (jsonb_typeof("snapshot") = 'object'),
  "note" TEXT,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "publishedBy" UUID,
  UNIQUE ("themeId", "version")
);
CREATE INDEX "theme_version_theme_idx" ON "ThemeVersion"("themeId", "publishedAt");
