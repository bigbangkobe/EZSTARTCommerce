-- 购物车与结账（M06）：游客购物袋、配送区/费率、不可变报价快照、订单与库存预留。
-- 金额一律非负整数最小货币单位；“总额 = 小计 - 折扣 + 运费 + 税”由 CHECK 兜底，
-- 服务端算错时无法写入快照，客户端金额从不参与这两个表。

CREATE TABLE "GuestCart" (
 "id" UUID PRIMARY KEY,
 "tokenDigest" TEXT NOT NULL CHECK ("tokenDigest" ~ '^[0-9a-f]{64}$'),
 "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','converted','abandoned')),
 "currency" TEXT NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
 "marketCode" TEXT,
 "locale" TEXT,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "GuestCart_tokenDigest_key" UNIQUE ("tokenDigest")
);
CREATE INDEX "GuestCart_status_expiresAt_idx" ON "GuestCart"("status", "expiresAt");

CREATE TABLE "CartItem" (
 "id" UUID PRIMARY KEY,
 "cartId" UUID NOT NULL REFERENCES "GuestCart"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "variantId" UUID NOT NULL REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "quantity" INTEGER NOT NULL CHECK ("quantity" BETWEEN 1 AND 99),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CartItem_cartId_variantId_key" UNIQUE ("cartId", "variantId")
);
CREATE INDEX "CartItem_cartId_idx" ON "CartItem"("cartId");

CREATE TABLE "ShippingZone" (
 "id" UUID PRIMARY KEY,
 "code" TEXT NOT NULL CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
 "nameByLocale" JSONB NOT NULL,
 "countryCodes" TEXT[] NOT NULL CHECK (cardinality("countryCodes") >= 1),
 "regionCodes" TEXT[] NOT NULL DEFAULT '{}',
 "priority" INTEGER NOT NULL DEFAULT 0 CHECK ("priority" >= 0),
 "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ShippingZone_code_key" UNIQUE ("code")
);

CREATE TABLE "ShippingRate" (
 "id" UUID PRIMARY KEY,
 "code" TEXT NOT NULL CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
 "nameByLocale" JSONB NOT NULL,
 "fixedFeeMinor" INTEGER NOT NULL CHECK ("fixedFeeMinor" >= 0),
 "freeAboveMinor" INTEGER CHECK ("freeAboveMinor" >= 0),
 "currency" TEXT NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
 "estimatedMinDays" INTEGER CHECK ("estimatedMinDays" BETWEEN 0 AND 365),
 "estimatedMaxDays" INTEGER CHECK ("estimatedMaxDays" BETWEEN 0 AND 365),
 "codEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
 "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ShippingRate_code_key" UNIQUE ("code"),
 CHECK ("estimatedMinDays" IS NULL OR "estimatedMaxDays" IS NULL OR "estimatedMaxDays" >= "estimatedMinDays")
);

CREATE TABLE "ShippingRateZone" (
 "rateId" UUID NOT NULL REFERENCES "ShippingRate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "zoneId" UUID NOT NULL REFERENCES "ShippingZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 PRIMARY KEY ("rateId", "zoneId")
);
CREATE INDEX "ShippingRateZone_zoneId_idx" ON "ShippingRateZone"("zoneId");

CREATE TABLE "CheckoutQuote" (
 "id" UUID PRIMARY KEY,
 "cartId" UUID NOT NULL REFERENCES "GuestCart"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','consumed','superseded','expired')),
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "locale" TEXT NOT NULL,
 "marketCode" TEXT NOT NULL,
 "currency" TEXT NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
 "contact" JSONB NOT NULL,
 "shippingAddress" JSONB NOT NULL,
 "shippingMethodId" UUID NOT NULL,
 "shippingMethodSnapshot" JSONB NOT NULL,
 "subtotalMinor" INTEGER NOT NULL CHECK ("subtotalMinor" >= 0),
 "discountMinor" INTEGER NOT NULL CHECK ("discountMinor" >= 0),
 "shippingMinor" INTEGER NOT NULL CHECK ("shippingMinor" >= 0),
 "taxMinor" INTEGER NOT NULL CHECK ("taxMinor" >= 0),
 "totalMinor" INTEGER NOT NULL CHECK ("totalMinor" >= 0),
 "couponCode" TEXT,
 "couponSummary" JSONB,
 "ruleVersions" JSONB NOT NULL,
 "warnings" JSONB NOT NULL,
 "policyAcceptances" JSONB NOT NULL,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ("discountMinor" <= "subtotalMinor"),
 CHECK ("totalMinor" = "subtotalMinor" - "discountMinor" + "shippingMinor" + "taxMinor")
);
CREATE INDEX "CheckoutQuote_cartId_status_idx" ON "CheckoutQuote"("cartId", "status");

CREATE TABLE "CheckoutQuoteLine" (
 "id" UUID PRIMARY KEY,
 "quoteId" UUID NOT NULL REFERENCES "CheckoutQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "variantId" UUID NOT NULL REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "sku" TEXT NOT NULL,
 "productName" TEXT NOT NULL,
 "variantName" TEXT,
 "quantity" INTEGER NOT NULL CHECK ("quantity" BETWEEN 1 AND 99),
 "unitPriceMinor" INTEGER NOT NULL CHECK ("unitPriceMinor" >= 0),
 "lineSubtotalMinor" INTEGER NOT NULL CHECK ("lineSubtotalMinor" >= 0),
 "lineDiscountMinor" INTEGER NOT NULL CHECK ("lineDiscountMinor" >= 0),
 "lineTotalMinor" INTEGER NOT NULL CHECK ("lineTotalMinor" >= 0),
 CONSTRAINT "CheckoutQuoteLine_quoteId_variantId_key" UNIQUE ("quoteId", "variantId"),
 CHECK ("lineSubtotalMinor" = "unitPriceMinor" * "quantity"),
 CHECK ("lineTotalMinor" = "lineSubtotalMinor" - "lineDiscountMinor")
);

CREATE TABLE "ShopOrder" (
 "id" UUID PRIMARY KEY,
 "publicOrderNumber" TEXT NOT NULL CHECK ("publicOrderNumber" ~ '^EZ-[0-9]{8}-[A-Z0-9]{6}$'),
 "idempotencyKey" TEXT NOT NULL CHECK (length("idempotencyKey") BETWEEN 16 AND 128),
 "requestDigest" TEXT NOT NULL CHECK ("requestDigest" ~ '^[0-9a-f]{64}$'),
 "quoteId" UUID NOT NULL REFERENCES "CheckoutQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "cartId" UUID REFERENCES "GuestCart"("id") ON DELETE SET NULL ON UPDATE CASCADE,
 "shippingRateId" UUID REFERENCES "ShippingRate"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "orderStatus" TEXT NOT NULL CHECK ("orderStatus" IN ('pending_payment','awaiting_confirmation')),
 "paymentStatus" TEXT NOT NULL CHECK ("paymentStatus" IN ('created','requires_action','processing','unknown','cod_due')),
 "fulfillmentStatus" TEXT NOT NULL DEFAULT 'unfulfilled' CHECK ("fulfillmentStatus" IN ('unfulfilled','partial','fulfilled')),
 "currency" TEXT NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
 "subtotalMinor" INTEGER NOT NULL CHECK ("subtotalMinor" >= 0),
 "discountMinor" INTEGER NOT NULL CHECK ("discountMinor" >= 0),
 "shippingMinor" INTEGER NOT NULL CHECK ("shippingMinor" >= 0),
 "taxMinor" INTEGER NOT NULL CHECK ("taxMinor" >= 0),
 "totalMinor" INTEGER NOT NULL CHECK ("totalMinor" >= 0),
 "locale" TEXT NOT NULL,
 "marketCode" TEXT NOT NULL,
 "contact" JSONB NOT NULL,
 "shippingAddress" JSONB,
 "shippingMethodSnapshot" JSONB NOT NULL,
 "couponSnapshot" JSONB,
 "customerNote" TEXT CHECK ("customerNote" IS NULL OR length("customerNote") <= 1000),
 "paymentMethodCode" TEXT NOT NULL,
 "policyAcceptances" JSONB NOT NULL,
 "placedAt" TIMESTAMPTZ(3) NOT NULL,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ShopOrder_publicOrderNumber_key" UNIQUE ("publicOrderNumber"),
 CONSTRAINT "ShopOrder_idempotencyKey_key" UNIQUE ("idempotencyKey"),
 CONSTRAINT "ShopOrder_quoteId_key" UNIQUE ("quoteId"),
 CHECK ("discountMinor" <= "subtotalMinor"),
 CHECK ("totalMinor" = "subtotalMinor" - "discountMinor" + "shippingMinor" + "taxMinor")
);
CREATE INDEX "ShopOrder_orderStatus_placedAt_idx" ON "ShopOrder"("orderStatus", "placedAt");
CREATE INDEX "ShopOrder_placedAt_idx" ON "ShopOrder"("placedAt");

CREATE TABLE "OrderItem" (
 "id" UUID PRIMARY KEY,
 "orderId" UUID NOT NULL REFERENCES "ShopOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "variantId" UUID REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE,
 "sku" TEXT NOT NULL,
 "productName" TEXT NOT NULL,
 "variantName" TEXT,
 "quantity" INTEGER NOT NULL CHECK ("quantity" BETWEEN 1 AND 99),
 "unitPriceMinor" INTEGER NOT NULL CHECK ("unitPriceMinor" >= 0),
 "lineSubtotalMinor" INTEGER NOT NULL CHECK ("lineSubtotalMinor" >= 0),
 "lineDiscountMinor" INTEGER NOT NULL CHECK ("lineDiscountMinor" >= 0),
 "lineTotalMinor" INTEGER NOT NULL CHECK ("lineTotalMinor" >= 0),
 CHECK ("lineSubtotalMinor" = "unitPriceMinor" * "quantity"),
 CHECK ("lineTotalMinor" = "lineSubtotalMinor" - "lineDiscountMinor")
);
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

CREATE TABLE "InventoryReservation" (
 "id" UUID PRIMARY KEY,
 "orderId" UUID NOT NULL REFERENCES "ShopOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "variantId" UUID NOT NULL REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "quantity" INTEGER NOT NULL CHECK ("quantity" BETWEEN 1 AND 99),
 "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','released','committed')),
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "InventoryReservation_orderId_variantId_key" UNIQUE ("orderId", "variantId")
);
CREATE INDEX "InventoryReservation_status_expiresAt_idx" ON "InventoryReservation"("status", "expiresAt");

CREATE TABLE "OrderStatusEvent" (
 "id" UUID PRIMARY KEY,
 "orderId" UUID NOT NULL REFERENCES "ShopOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "fromStatus" TEXT,
 "toStatus" TEXT NOT NULL,
 "reason" TEXT,
 "actorType" TEXT NOT NULL DEFAULT 'customer',
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OrderStatusEvent_orderId_createdAt_idx" ON "OrderStatusEvent"("orderId", "createdAt");
