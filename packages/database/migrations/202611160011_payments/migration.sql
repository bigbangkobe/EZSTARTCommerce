-- 付款方式配置与交易台账（M08 第一批）。
-- 三条不变量在这里由数据库兜底：
-- 1. 启用的支付方式必须有批准依据（approvalReference + approvedAt 同时存在）。
-- 2. 数据库只存凭证引用（secret:// / env:// 这类 URI），不存凭证本身。
-- 3. 台账状态与时间必须同时成立：收款成功必须有到账时间，退回必须有退回时间。

CREATE TABLE "PaymentMethodConfig" (
 "id" UUID PRIMARY KEY,
 "providerCode" TEXT NOT NULL CHECK ("providerCode" ~ '^[a-z][a-z0-9_]{1,31}$'),
 "environment" TEXT NOT NULL CHECK ("environment" IN ('sandbox','production')),
 "displayName" TEXT NOT NULL CHECK (length(btrim("displayName")) BETWEEN 1 AND 80),
 "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
 "approvalReference" TEXT CHECK ("approvalReference" IS NULL OR length(btrim("approvalReference")) BETWEEN 1 AND 200),
 "approvedAt" TIMESTAMPTZ(3),
 "publicConfig" JSONB NOT NULL DEFAULT '{}'::jsonb,
 "secretRef" TEXT CHECK ("secretRef" IS NULL OR "secretRef" ~ '^[a-z][a-z0-9+.-]*://[A-Za-z0-9._:/-]{1,200}$'),
 "secretFingerprint" TEXT CHECK ("secretFingerprint" IS NULL OR "secretFingerprint" ~ '^[0-9a-f]{16}$'),
 "connectionStatus" TEXT NOT NULL DEFAULT 'unverified' CHECK ("connectionStatus" IN ('unverified','ok','failed')),
 "lastCheckedAt" TIMESTAMPTZ(3),
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdBy" UUID,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "PaymentMethodConfig_provider_environment_key" UNIQUE ("providerCode", "environment"),
 -- 批准依据是两个字段的一对：只有一个就说明写错了，而不是“半批准”。
 CONSTRAINT "PaymentMethodConfig_approval_pair_check"
   CHECK (("approvalReference" IS NULL) = ("approvedAt" IS NULL)),
 -- 启用必须有批准依据；未批准的方式即使被打开也写不进去。
 CONSTRAINT "PaymentMethodConfig_enabled_requires_approval_check"
   CHECK (NOT "enabled" OR ("approvalReference" IS NOT NULL AND "approvedAt" IS NOT NULL))
);

CREATE TABLE "Payment" (
 "id" UUID PRIMARY KEY,
 "publicPaymentNumber" TEXT NOT NULL CHECK ("publicPaymentNumber" ~ '^PAY-[0-9]{8}-[A-Z0-9]{6}$'),
 "dedupeKey" TEXT NOT NULL CHECK (length("dedupeKey") BETWEEN 3 AND 120),
 "orderId" UUID NOT NULL REFERENCES "ShopOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "methodConfigId" UUID REFERENCES "PaymentMethodConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "providerCode" TEXT NOT NULL CHECK ("providerCode" ~ '^[a-z][a-z0-9_]{1,31}$'),
 "environment" TEXT NOT NULL CHECK ("environment" IN ('sandbox','production')),
 "channel" TEXT NOT NULL CHECK ("channel" IN ('cod','manual','online')),
 "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN
   ('pending','authorized','succeeded','failed','cancelled','unknown','collected','rejected','returned')),
 "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" > 0),
 "currency" TEXT NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
 "providerTransactionId" TEXT CHECK ("providerTransactionId" IS NULL OR length(btrim("providerTransactionId")) BETWEEN 1 AND 160),
 "paidAt" TIMESTAMPTZ(3),
 "returnedAt" TIMESTAMPTZ(3),
 "reference" TEXT CHECK ("reference" IS NULL OR length(btrim("reference")) BETWEEN 1 AND 200),
 "failureCode" TEXT CHECK ("failureCode" IS NULL OR length(btrim("failureCode")) BETWEEN 1 AND 80),
 "failureMessage" TEXT CHECK ("failureMessage" IS NULL OR length("failureMessage") <= 1000),
 "recordedBy" UUID,
 "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "Payment_publicPaymentNumber_key" UNIQUE ("publicPaymentNumber"),
 CONSTRAINT "Payment_dedupeKey_key" UNIQUE ("dedupeKey"),
 -- 已收/已退必须有到账时间；没收到钱的记录不能伪装成收款成功。
 CONSTRAINT "Payment_paidAt_check"
   CHECK ("status" NOT IN ('collected','succeeded','returned') OR "paidAt" IS NOT NULL),
 CONSTRAINT "Payment_returnedAt_check"
   CHECK (("status" = 'returned') = ("returnedAt" IS NOT NULL))
);
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");
-- 同一个服务商交易号只能入账一次；空值不参与唯一性，等待渠道号的历史行不受影响。
CREATE UNIQUE INDEX "Payment_providerTransactionId_key"
 ON "Payment"("providerCode", "providerTransactionId") WHERE "providerTransactionId" IS NOT NULL;

CREATE TABLE "PaymentEvent" (
 "id" UUID PRIMARY KEY,
 "paymentId" UUID NOT NULL REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "orderId" UUID NOT NULL REFERENCES "ShopOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "type" TEXT NOT NULL CHECK ("type" IN ('created','collected','rejected','returned','succeeded','cancelled','failed')),
 "fromStatus" TEXT,
 "toStatus" TEXT NOT NULL CHECK ("toStatus" IN
   ('pending','authorized','succeeded','failed','cancelled','unknown','collected','rejected','returned')),
 "source" TEXT NOT NULL CHECK ("source" IN ('admin','system','provider')),
 "actorId" UUID,
 "dedupeKey" TEXT NOT NULL CHECK (length("dedupeKey") BETWEEN 3 AND 160),
 "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
 "occurredAt" TIMESTAMPTZ(3) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 -- 事件按去重键只落一条：重复回调或重放请求不会产生第二笔流水。
 CONSTRAINT "PaymentEvent_dedupeKey_key" UNIQUE ("dedupeKey")
);
CREATE INDEX "PaymentEvent_paymentId_occurredAt_idx" ON "PaymentEvent"("paymentId", "occurredAt");
