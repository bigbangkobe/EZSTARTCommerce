-- 分类 slug 变更的 301 归属（M04 第六批）。
--
-- 分类是商品归类的骨架，旧分类地址被外部链接、搜索引擎和顾客书签引用得比内容页更久；
-- 改 slug 时不登记跳转，等于把已经积累的入站链接直接送进 404。
-- 归属字段与内容页/专题同构：清理时按 categoryId 精确删除，不会误删别人的跳转。
ALTER TABLE "SeoRedirect" ADD COLUMN "categoryId" UUID;
ALTER TABLE "SeoRedirect" ADD CONSTRAINT "SeoRedirect_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "SeoRedirect_categoryId_idx" ON "SeoRedirect"("categoryId");

-- 一条跳转只归属于一个对象。归属字段决定停用/删除时的清理范围，
-- 多个归属并存会让「该不该跟着下线」变成不可推断的状态。
ALTER TABLE "SeoRedirect" ADD CONSTRAINT "seo_redirect_single_owner"
  CHECK (num_nonnulls("pageId", "collectionId", "categoryId") <= 1);
