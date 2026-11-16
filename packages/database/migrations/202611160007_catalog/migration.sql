-- 商品目录（M03）：分类、品牌、商品、翻译、规格、图片、属性与库存数量。
-- 多语言用翻译表；SKU 全店唯一；金额为非负整数最小货币单位。

CREATE TABLE "Category" (
 "id" UUID PRIMARY KEY,
 "parentId" UUID REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "position" INTEGER NOT NULL DEFAULT 0 CHECK ("position" >= 0),
 "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ("parentId" IS NULL OR "parentId" <> "id")
);
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

CREATE TABLE "CategoryTranslation" (
 "id" UUID PRIMARY KEY,
 "categoryId" UUID NOT NULL REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "locale" TEXT NOT NULL CHECK ("locale" IN ('zh-CN','zh-HK','en')),
 "name" TEXT NOT NULL CHECK (length(btrim("name")) BETWEEN 1 AND 160),
 "slug" TEXT CHECK ("slug" ~ '^[^[:space:]/]{1,180}$'),
 "description" TEXT,
 UNIQUE ("categoryId", "locale"), UNIQUE ("locale", "slug")
);

CREATE TABLE "Brand" (
 "id" UUID PRIMARY KEY,
 "logoMediaId" UUID,
 "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "BrandTranslation" (
 "id" UUID PRIMARY KEY,
 "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "locale" TEXT NOT NULL CHECK ("locale" IN ('zh-CN','zh-HK','en')),
 "name" TEXT NOT NULL CHECK (length(btrim("name")) BETWEEN 1 AND 160),
 "slug" TEXT CHECK ("slug" ~ '^[^[:space:]/]{1,180}$'),
 "description" TEXT,
 UNIQUE ("brandId", "locale"), UNIQUE ("locale", "slug")
);

CREATE TABLE "Product" (
 "id" UUID PRIMARY KEY,
 "status" TEXT NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft','active','archived')),
 "baseSku" TEXT CHECK ("baseSku" IS NULL OR "baseSku" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 "brandId" UUID REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "taxClassRef" TEXT,
 "marketCodes" TEXT[] NOT NULL DEFAULT '{}',
 "publishedAt" TIMESTAMPTZ(3),
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Product_status_createdAt_idx" ON "Product"("status", "createdAt");

CREATE TABLE "ProductTranslation" (
 "id" UUID PRIMARY KEY,
 "productId" UUID NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "locale" TEXT NOT NULL CHECK ("locale" IN ('zh-CN','zh-HK','en')),
 "name" TEXT NOT NULL CHECK (length(btrim("name")) BETWEEN 1 AND 160),
 "slug" TEXT NOT NULL CHECK ("slug" ~ '^[^[:space:]/]{1,180}$'),
 "shortDescription" TEXT,
 "description" TEXT,
 "seoTitle" TEXT,
 "seoDescription" TEXT,
 UNIQUE ("productId", "locale"), UNIQUE ("locale", "slug")
);

CREATE TABLE "ProductVariant" (
 "id" UUID PRIMARY KEY,
 "productId" UUID NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "sku" TEXT NOT NULL UNIQUE CHECK ("sku" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 "optionValues" JSONB NOT NULL,
 "priceMinor" INTEGER NOT NULL CHECK ("priceMinor" >= 0),
 "compareAtMinor" INTEGER CHECK ("compareAtMinor" IS NULL OR "compareAtMinor" >= 0),
 "currency" TEXT NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
 "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','inactive')),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

CREATE TABLE "ProductMedia" (
 "id" UUID PRIMARY KEY,
 "productId" UUID NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "mediaId" UUID NOT NULL,
 "position" INTEGER NOT NULL CHECK ("position" >= 0),
 "altByLocale" JSONB NOT NULL DEFAULT '{}',
 UNIQUE ("productId", "mediaId")
);
CREATE INDEX "ProductMedia_productId_position_idx" ON "ProductMedia"("productId", "position");

CREATE TABLE "ProductAttribute" (
 "id" UUID PRIMARY KEY,
 "productId" UUID NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "code" TEXT NOT NULL CHECK (length(btrim("code")) BETWEEN 1 AND 80),
 "value" TEXT NOT NULL CHECK (length("value") <= 200),
 UNIQUE ("productId", "code")
);

CREATE TABLE "ProductCategory" (
 "productId" UUID NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "categoryId" UUID NOT NULL REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 PRIMARY KEY ("productId", "categoryId")
);
CREATE INDEX "ProductCategory_categoryId_idx" ON "ProductCategory"("categoryId");

CREATE TABLE "InventoryItem" (
 "id" UUID PRIMARY KEY,
 "variantId" UUID NOT NULL UNIQUE REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "onHand" INTEGER NOT NULL DEFAULT 0 CHECK ("onHand" >= 0),
 "reserved" INTEGER NOT NULL DEFAULT 0 CHECK ("reserved" >= 0),
 CHECK ("reserved" <= "onHand")
);
