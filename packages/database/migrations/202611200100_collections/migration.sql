-- 专题（Collection）：运营挑选的一组商品，独立于分类的策展位（M04 第五批，第 33 条迁移）。
--
-- 「专题」和「分类」不是一回事：分类是商品归类的稳定骨架，专题是临时策展（例如「中秋礼盒」「日本酒入门」），
-- 一个商品可以同时出现在多个专题里，专题也可以跨分类。因此不复用 ProductCategory，单独建关联表。
--
-- 不变量：
-- 1. 专题名称与 slug 按语言各一行；(locale, slug) 唯一保证同一语言下只有一个专题占用该地址。
-- 2. 专题商品是「有序集合」：position 决定前台顺序，去重由联合主键保证。
-- 3. 专题停用不影响已关联商品，只是前台不再列出（重新启用不需要重排）。
-- 4. 改 slug 后旧地址 301 到新地址；跳转记录按 collectionId 归属，专题删除时自动置空而不是级联删记录
--    （保留历史跳转，避免删掉专题时把别人的跳转一起带走）。
-- 5. 陈列版面开放专题作用域：pageKey = collection:<uuid>，与分类一样用 id 绑定，改 slug 不利旧版面失联。

CREATE TABLE "Collection" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "position" INTEGER NOT NULL DEFAULT 0 CHECK ("position" >= 0),
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "collection_enabled_position_idx" ON "Collection"("enabled", "position");

CREATE TABLE "CollectionTranslation" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "collectionId" UUID NOT NULL REFERENCES "Collection"("id") ON DELETE CASCADE,
  "locale" TEXT NOT NULL,
  "name" TEXT NOT NULL CHECK (length(btrim("name")) BETWEEN 1 AND 160),
  -- slug 允许暂时留空（草稿可以先只写名称），但一旦填写就必须是合法的 URL 片段。
  "slug" TEXT CHECK ("slug" IS NULL OR (length("slug") BETWEEN 1 AND 180 AND "slug" !~ '[[:space:]/]')),
  "description" TEXT,
  UNIQUE ("collectionId", "locale"),
  UNIQUE ("locale", "slug")
);
CREATE INDEX "collection_translation_slug_idx" ON "CollectionTranslation"("locale", "slug");

CREATE TABLE "CollectionProduct" (
  "collectionId" UUID NOT NULL REFERENCES "Collection"("id") ON DELETE CASCADE,
  "productId" UUID NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE,
  "position" INTEGER NOT NULL DEFAULT 0 CHECK ("position" >= 0),
  PRIMARY KEY ("collectionId", "productId")
);
CREATE INDEX "collection_product_product_idx" ON "CollectionProduct"("productId");

-- 跳转归属：内容页用 pageId，专题用 collectionId；两者都可为空（手工登记的外链跳转）。
ALTER TABLE "SeoRedirect" ADD COLUMN "collectionId" UUID;
ALTER TABLE "SeoRedirect" ADD CONSTRAINT "SeoRedirect_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "SeoRedirect_collectionId_idx" ON "SeoRedirect"("collectionId");

-- 陈列版面放开专题作用域：形状与分类同构，kind 必须与 key 前缀一致。
ALTER TABLE "MerchandisingLayout" DROP CONSTRAINT "merchandising_page_key_shape";
ALTER TABLE "MerchandisingLayout" DROP CONSTRAINT "merchandising_kind_known";
ALTER TABLE "MerchandisingLayout" DROP CONSTRAINT "merchandising_kind_matches_key";

ALTER TABLE "MerchandisingLayout" ADD CONSTRAINT "merchandising_page_key_shape"
  CHECK ("pageKey" = 'home'
      OR "pageKey" ~ '^category:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR "pageKey" ~ '^collection:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

ALTER TABLE "MerchandisingLayout" ADD CONSTRAINT "merchandising_kind_known"
  CHECK ("kind" IN ('home','category','collection'));

ALTER TABLE "MerchandisingLayout" ADD CONSTRAINT "merchandising_kind_matches_key"
  CHECK (("kind" = 'home' AND "pageKey" = 'home')
      OR ("kind" = 'category' AND "pageKey" LIKE 'category:%')
      OR ("kind" = 'collection' AND "pageKey" LIKE 'collection:%'));
