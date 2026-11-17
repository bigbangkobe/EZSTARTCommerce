-- 会员等级与积分台账（M10 第二批）。
-- 四条边界写进数据库：
-- 1. 积分只能通过追加流水变动：PointLedger 由触发器拒绝 UPDATE/DELETE，
--    余额与流水写在同一个事务里，balanceAfter 必须等于变动后的账户余额。
-- 2. 余额不可为负：账户与流水两侧都有 CHECK，兑换/扣回不能把会员扣成负数。
-- 3. 同一业务事件只能记一次账：idempotencyKey 全表唯一（订单发放用 order:{id}:earn）。
-- 4. 等级是配置而不是事实：MemberProfile.tierId 只是当前归属，历史归属由审计与流水留痕；
--    规则变更只影响未来计算，流水里保留 ruleVersion。

CREATE TABLE "LoyaltySetting" (
 -- 店铺级单例：开关、换算口径、积分有效期。
 "id" INTEGER PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
 "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
 -- 多少「分」（最小货币单位）换 1 点；100 表示 HK$1 = 1 点。整数口径，不引入浮点。
 "minorPerPoint" INTEGER NOT NULL DEFAULT 100 CHECK ("minorPerPoint" BETWEEN 1 AND 1000000),
 "pointsExpiryMonths" INTEGER CHECK ("pointsExpiryMonths" IS NULL OR "pointsExpiryMonths" BETWEEN 1 AND 120),
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "LoyaltySetting" ("id") VALUES (1);

CREATE TABLE "MembershipTier" (
 "id" UUID PRIMARY KEY,
 "code" TEXT NOT NULL CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{0,39}$'),
 "nameByLocale" JSONB NOT NULL CHECK (jsonb_typeof("nameByLocale") = 'object' AND "nameByLocale" <> '{}'::jsonb),
 -- rank 决定高低，不用金额排序：最低消费相同的两个等级也必须有确定先后。
 "rank" INTEGER NOT NULL CHECK ("rank" BETWEEN 1 AND 100),
 "minLifetimeSpendMinor" BIGINT NOT NULL DEFAULT 0 CHECK ("minLifetimeSpendMinor" >= 0),
 -- 空表示沿用店铺口径；填了就是该等级的加速倍率（数值越小，同样的钱积更多点）。
 "minorPerPoint" INTEGER CHECK ("minorPerPoint" IS NULL OR "minorPerPoint" BETWEEN 1 AND 1000000),
 "benefits" JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof("benefits") = 'array'),
 "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','retired')),
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "MembershipTier_code_key" UNIQUE ("code"),
 CONSTRAINT "MembershipTier_rank_key" UNIQUE ("rank")
);
CREATE INDEX "MembershipTier_status_rank_idx" ON "MembershipTier"("status", "rank");

ALTER TABLE "MemberProfile"
 ADD COLUMN "tierId" UUID REFERENCES "MembershipTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 ADD COLUMN "lifetimeSpendMinor" BIGINT NOT NULL DEFAULT 0 CHECK ("lifetimeSpendMinor" >= 0);
CREATE INDEX "MemberProfile_tierId_idx" ON "MemberProfile"("tierId");

CREATE TABLE "PointAccount" (
 "id" UUID PRIMARY KEY,
 "memberId" UUID NOT NULL REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "balance" INTEGER NOT NULL DEFAULT 0 CHECK ("balance" >= 0),
 "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','frozen')),
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "PointAccount_memberId_key" UNIQUE ("memberId")
);

CREATE TABLE "PointLedger" (
 "id" UUID PRIMARY KEY,
 "memberId" UUID NOT NULL REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "deltaPoints" INTEGER NOT NULL CHECK ("deltaPoints" <> 0),
 "balanceAfter" INTEGER NOT NULL CHECK ("balanceAfter" >= 0),
 "entryType" TEXT NOT NULL CHECK ("entryType" IN ('earn','adjust','redeem','expire','reversal')),
 "sourceType" TEXT NOT NULL CHECK ("sourceType" IN ('order','manual','system')),
 "sourceRef" TEXT CHECK ("sourceRef" IS NULL OR length("sourceRef") BETWEEN 1 AND 120),
 "reasonCode" TEXT NOT NULL CHECK (length("reasonCode") BETWEEN 1 AND 80),
 "reason" TEXT CHECK ("reason" IS NULL OR length("reason") BETWEEN 1 AND 1000),
 "actorId" UUID,
 "ruleVersion" TEXT NOT NULL CHECK (length("ruleVersion") BETWEEN 1 AND 40),
 "idempotencyKey" TEXT NOT NULL CHECK (length("idempotencyKey") BETWEEN 8 AND 160),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "PointLedger_idempotencyKey_key" UNIQUE ("idempotencyKey")
);
CREATE INDEX "PointLedger_memberId_createdAt_idx" ON "PointLedger"("memberId", "createdAt");
CREATE INDEX "PointLedger_source_idx" ON "PointLedger"("sourceType", "sourceRef");

CREATE FUNCTION reject_point_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Point ledger is append-only';
END;
$$;
CREATE TRIGGER point_ledger_append_only BEFORE UPDATE OR DELETE ON "PointLedger"
FOR EACH ROW EXECUTE FUNCTION reject_point_ledger_mutation();
