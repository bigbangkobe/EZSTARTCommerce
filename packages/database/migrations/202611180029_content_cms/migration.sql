-- 内容页与发布版本（M04 第一批，第 29 条迁移）。
-- 安全与一致性不变量：
-- 1. 前台只读 ContentPageVersion.snapshot（不可变 JSON）；草稿表只给后台用，
--    草稿 slug 永远不会被公开地址命中（publishedSlug 才是前台查询键）。
-- 2. publishedSlug 用部分唯一索引保证「同一语言下同一地址只有一个页面」，
--    撤下时清空，因此不会因历史草稿阻塞别人占用该地址。
-- 3. 发布/撤下都写新版本行，不覆盖历史：回滚 = 用旧快照建新版本。
-- 4. ContentRelease 只有一行，seq 单调递增，派生 cr-N 作为内容发布标记；
--    区块埋点的 publishVersionId 用它，报表按它分组即可区分内容换代。
-- 5. 全表无顾客标识：内容页只描述店铺自己写的内容。

CREATE SEQUENCE IF NOT EXISTS "content_release_seq" AS integer START WITH 1 INCREMENT BY 1;

CREATE TABLE "ContentPage" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "pageKey" TEXT NOT NULL UNIQUE CHECK ("pageKey" ~ '^[a-z][a-z0-9-]{1,63}$'),
  "pageType" TEXT NOT NULL DEFAULT 'standard'
    CHECK ("pageType" IN ('standard','article','policy','faq','announcement')),
  "blocks" JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("blocks") = 'array'),
  "status" TEXT NOT NULL DEFAULT 'draft'
    CHECK ("status" IN ('draft','scheduled','published','withdrawn')),
  "position" INTEGER NOT NULL DEFAULT 0 CHECK ("position" >= 0),
  "scheduledAt" TIMESTAMPTZ(3),
  "publishedVersionId" UUID UNIQUE,
  "publishedAt" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "createdBy" UUID,
  "updatedBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "content_page_schedule_check"
    CHECK (("status" = 'scheduled') = ("scheduledAt" IS NOT NULL))
);
CREATE INDEX "content_page_status_position_idx" ON "ContentPage"("status", "position");

CREATE TABLE "ContentPageTranslation" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "pageId" UUID NOT NULL REFERENCES "ContentPage"("id") ON DELETE CASCADE,
  "locale" TEXT NOT NULL CHECK ("locale" IN ('zh-CN','zh-HK','en')),
  "title" TEXT NOT NULL CHECK (length("title") BETWEEN 1 AND 200),
  "slug" TEXT NOT NULL CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") <= 180),
  "seoTitle" TEXT CHECK ("seoTitle" IS NULL OR length("seoTitle") <= 70),
  "seoDescription" TEXT CHECK ("seoDescription" IS NULL OR length("seoDescription") <= 320),
  "indexable" BOOLEAN NOT NULL DEFAULT false,
  "publishedSlug" TEXT,
  CONSTRAINT "content_translation_page_locale_key" UNIQUE ("pageId", "locale"),
  CONSTRAINT "content_translation_locale_slug_key" UNIQUE ("locale", "slug")
);
-- 发布地址唯一（NULL 不参与比较）：只有同时在线的两页才可能撞地址。
CREATE UNIQUE INDEX "content_translation_published_slug_key"
  ON "ContentPageTranslation"("locale", "publishedSlug") WHERE "publishedSlug" IS NOT NULL;

CREATE TABLE "ContentPageVersion" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "pageId" UUID NOT NULL REFERENCES "ContentPage"("id") ON DELETE CASCADE,
  "version" INTEGER NOT NULL CHECK ("version" >= 1),
  "releaseSeq" INTEGER NOT NULL UNIQUE DEFAULT nextval('content_release_seq'),
  "status" TEXT NOT NULL DEFAULT 'published'
    CHECK ("status" IN ('published','superseded','withdrawn')),
  "snapshot" JSONB NOT NULL,
  "note" TEXT CHECK ("note" IS NULL OR length("note") <= 1000),
  "publishedAt" TIMESTAMPTZ(3) NOT NULL,
  "publishedBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "content_version_page_version_key" UNIQUE ("pageId", "version")
);
CREATE INDEX "content_version_status_published_idx" ON "ContentPageVersion"("status", "publishedAt");

ALTER TABLE "ContentPage" ADD CONSTRAINT "ContentPage_publishedVersionId_fkey"
  FOREIGN KEY ("publishedVersionId") REFERENCES "ContentPageVersion"("id") ON DELETE SET NULL;

CREATE TABLE "ContentRelease" (
  "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "seq" INTEGER NOT NULL DEFAULT 0 CHECK ("seq" >= 0),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
INSERT INTO "ContentRelease" ("id", "seq") VALUES (1, 0) ON CONFLICT ("id") DO NOTHING;
