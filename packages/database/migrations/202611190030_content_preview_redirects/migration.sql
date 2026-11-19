-- 预览外链与已发布地址重定向（M04 第二批，第 30 条迁移）。
-- 安全与一致性不变量：
-- 1. 预览 token 只存 SHA-256：库被读走也拿不到可用链接；有效期由服务端判定，过期即失效。
-- 2. token 绑定页面 + 语言 + 视口，且必须与后台看到的草稿版本一致才签发（防止预览到未审阅的内容）。
-- 3. 预览链接只读草稿，不改变线上版本、不写内容发布标记、不产生埋点。
-- 4. 重定向只允许站内相对路径（无协议/域名/查询串），同址自跳、循环链直接拒绝。
-- 5. 更改已发布 slug 时自动登记旧地址 → 新地址的 301，避免旧链接变成死链；撤下页面时清掉指向它的重定向。
-- 6. 两张表都不含顾客标识：内容运维数据与顾客数据分离。

CREATE TABLE "ContentPreviewToken" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "pageId" UUID NOT NULL REFERENCES "ContentPage"("id") ON DELETE CASCADE,
  "tokenHash" TEXT NOT NULL UNIQUE CHECK ("tokenHash" ~ '^[a-f0-9]{64}$'),
  "locale" TEXT NOT NULL CHECK ("locale" IN ('zh-CN','zh-HK','en')),
  "viewport" TEXT NOT NULL DEFAULT 'desktop' CHECK ("viewport" IN ('mobile','desktop')),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "content_preview_expiry_idx" ON "ContentPreviewToken"("expiresAt");
CREATE INDEX "content_preview_page_idx" ON "ContentPreviewToken"("pageId", "expiresAt");

CREATE TABLE "SeoRedirect" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "locale" TEXT NOT NULL CHECK ("locale" IN ('zh-CN','zh-HK','en')),
  "fromPath" TEXT NOT NULL UNIQUE
    CHECK ("fromPath" ~ '^/[A-Za-z0-9._~-][A-Za-z0-9._~/-]*$' AND length("fromPath") BETWEEN 2 AND 300),
  "toPath" TEXT NOT NULL
    CHECK ("toPath" ~ '^/[A-Za-z0-9._~-][A-Za-z0-9._~/-]*$' AND length("toPath") BETWEEN 2 AND 300),
  "statusCode" INTEGER NOT NULL DEFAULT 301 CHECK ("statusCode" IN (301, 308)),
  "pageId" UUID REFERENCES "ContentPage"("id") ON DELETE SET NULL,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_redirect_not_self" CHECK ("fromPath" <> "toPath")
);
CREATE INDEX "seo_redirect_locale_idx" ON "SeoRedirect"("locale");
CREATE INDEX "seo_redirect_page_idx" ON "SeoRedirect"("pageId");
