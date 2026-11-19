-- 陈列版面绑定到分类页（M04 第四批，第 32 条迁移）。
-- 第三批只开放 home，pageKey 的 CHECK 也只允许短横线小写串。分类版面需要 `category:<uuid>`：
-- 用分类 id 而不是 slug，分类改名/改 slug 时已发布版面不会跟着失效或指向别的分类。
--
-- 不变量：
-- 1. pageKey 只有两种形状：home 或 category:<uuid>；其它（含尚未上线的 collection:）一律存不进来。
-- 2. kind 必须与 pageKey 形状一致，避免「kind=category 但 key=home」这种读出来会错位的行。
-- 3. 一个分类最多一份版面（pageKey 唯一已经覆盖，这里只补 kind 索引给后台列表用）。

ALTER TABLE "MerchandisingLayout" DROP CONSTRAINT "MerchandisingLayout_pageKey_check";
ALTER TABLE "MerchandisingLayout" DROP CONSTRAINT "MerchandisingLayout_kind_check";

ALTER TABLE "MerchandisingLayout" ADD CONSTRAINT "merchandising_page_key_shape"
  CHECK ("pageKey" = 'home'
      OR "pageKey" ~ '^category:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

ALTER TABLE "MerchandisingLayout" ADD CONSTRAINT "merchandising_kind_known"
  CHECK ("kind" IN ('home','category'));

ALTER TABLE "MerchandisingLayout" ADD CONSTRAINT "merchandising_kind_matches_key"
  CHECK (("kind" = 'home' AND "pageKey" = 'home')
      OR ("kind" = 'category' AND "pageKey" LIKE 'category:%'));

CREATE INDEX "merchandising_layout_kind_idx" ON "MerchandisingLayout"("kind");
