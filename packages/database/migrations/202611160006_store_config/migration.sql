-- 商店设置：单实例单店铺配置、市场档案与市场审核历史（M01）。
CREATE TABLE "StoreConfig" (
 "id" INTEGER PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
 "displayName" TEXT NOT NULL CHECK (length(btrim("displayName")) BETWEEN 1 AND 120),
 "locales" TEXT[] NOT NULL CHECK (cardinality("locales") BETWEEN 1 AND 3),
 "defaultLocale" TEXT NOT NULL CHECK ("defaultLocale" IN ('zh-CN','zh-HK','en')),
 "baseCurrency" TEXT NOT NULL CHECK ("baseCurrency" ~ '^[A-Z]{3}$'),
 "timezone" TEXT NOT NULL CHECK (length("timezone") BETWEEN 1 AND 100),
 "featureFlags" JSONB NOT NULL DEFAULT '{}',
 "logoMediaId" UUID,
 "faviconMediaId" UUID,
 "tradingStartedAt" TIMESTAMPTZ(3),
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ("defaultLocale" = ANY ("locales"))
);

CREATE TABLE "MarketProfile" (
 "id" UUID PRIMARY KEY,
 "marketCode" TEXT NOT NULL UNIQUE CHECK ("marketCode" ~ '^[A-Z0-9-]{2,16}$'),
 "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
 "eligibleProductIds" UUID[] NOT NULL DEFAULT '{}',
 "reviewStatus" TEXT NOT NULL DEFAULT 'pending' CHECK ("reviewStatus" IN ('pending','approved','rejected','revoked')),
 "reviewValidUntil" TIMESTAMPTZ(3),
 "storeConfigId" INTEGER NOT NULL DEFAULT 1 REFERENCES "StoreConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 -- 未通过审核的市场不允许开放在交易：数据库层也守住这条规则。
 CHECK (NOT "enabled" OR "reviewStatus" = 'approved')
);

CREATE TABLE "MarketReviewRecord" (
 "id" UUID PRIMARY KEY,
 "storeConfigId" INTEGER NOT NULL DEFAULT 1 REFERENCES "StoreConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "marketCode" TEXT NOT NULL CHECK ("marketCode" ~ '^[A-Z0-9-]{2,16}$'),
 "decision" TEXT NOT NULL CHECK ("decision" IN ('approved','rejected','revoked')),
 "evidenceReference" TEXT NOT NULL CHECK (length(btrim("evidenceReference")) BETWEEN 1 AND 500),
 "reason" TEXT NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 1000),
 "reviewedBy" UUID NOT NULL,
 "reviewedAt" TIMESTAMPTZ(3) NOT NULL,
 "validUntil" TIMESTAMPTZ(3),
 "storeConfigVersion" INTEGER NOT NULL CHECK ("storeConfigVersion" > 0),
 CHECK ("decision" <> 'approved' OR "validUntil" IS NULL OR "validUntil" > "reviewedAt")
);
CREATE INDEX "MarketReviewRecord_marketCode_reviewedAt_idx" ON "MarketReviewRecord"("marketCode", "reviewedAt");
