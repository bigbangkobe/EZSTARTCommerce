-- 首页/分类/专题的陈列版面（M04 第三批，第 31 条迁移）。
-- 不变量：
-- 1. 版面按 pageKey 唯一：一个地址只有一份陈列配置，不存在两份互相覆盖的草稿。
-- 2. 草稿（sections）与线上（publishedSnapshot）分离：保存草稿永远不改线上陈列。
-- 3. 每次发布写一条不可变 MerchandisingVersion；版本号在同一版面内递增且唯一。
-- 4. 发布快照必须是对象（不是数组/null），避免前台读到半截数据后渲染出空页面。
-- 5. 不含任何顾客数据：陈列配置只有商品引用与运营文案。

CREATE TABLE "MerchandisingLayout" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "pageKey" TEXT NOT NULL UNIQUE CHECK ("pageKey" ~ '^[a-z][a-z0-9-]{1,31}$'),
  "kind" TEXT NOT NULL DEFAULT 'home' CHECK ("kind" IN ('home','category','collection')),
  "status" TEXT NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft','published')),
  "sections" JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("sections") = 'array'),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "publishedSnapshot" JSONB CHECK ("publishedSnapshot" IS NULL OR jsonb_typeof("publishedSnapshot") = 'object'),
  "publishedAt" TIMESTAMPTZ(3),
  "publishedBy" UUID,
  "createdBy" UUID,
  "updatedBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "merchandising_published_consistent"
    CHECK (("status" = 'draft' AND "publishedSnapshot" IS NULL AND "publishedAt" IS NULL)
        OR ("status" = 'published' AND "publishedSnapshot" IS NOT NULL AND "publishedAt" IS NOT NULL))
);
CREATE INDEX "merchandising_layout_status_idx" ON "MerchandisingLayout"("status");

CREATE TABLE "MerchandisingVersion" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "layoutId" UUID NOT NULL REFERENCES "MerchandisingLayout"("id") ON DELETE CASCADE,
  "version" INTEGER NOT NULL CHECK ("version" >= 1),
  "snapshot" JSONB NOT NULL CHECK (jsonb_typeof("snapshot") = 'object'),
  "note" TEXT,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "publishedBy" UUID,
  UNIQUE ("layoutId", "version")
);
CREATE INDEX "merchandising_version_layout_idx" ON "MerchandisingVersion"("layoutId", "publishedAt");
