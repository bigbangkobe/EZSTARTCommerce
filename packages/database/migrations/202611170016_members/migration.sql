-- 顾客与会员（M10 第一批）：顾客档案、会员档案、邮箱 OTP 挑战、会员会话与订单-会员关联。
-- 三条边界写进数据库：
-- 1. OTP 挑战不存明文验证码，也不存明文邮箱：验证码只存实例密钥 HMAC 摘要，
--    邮箱只存 AES-GCM 密文（绑定挑战行），投递任务过期即清密。
-- 2. 一个会员档案只属于一个顾客（customerId 唯一）；closed 是终态，会员号全店唯一。
-- 3. 订单-会员关联是追加事实：主键 (orderId, memberId)，链接来源闭集，不允许重复关联或级联删除顾客。

CREATE TABLE "Customer" (
 "id" UUID PRIMARY KEY,
 "emailNormalized" TEXT CHECK ("emailNormalized" IS NULL OR ("emailNormalized" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND "emailNormalized" = lower("emailNormalized"))),
 "phone" TEXT,
 "displayName" TEXT NOT NULL CHECK (length("displayName") BETWEEN 1 AND 120),
 "tags" TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality("tags") <= 50),
 "internalNote" TEXT,
 "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','blocked')),
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "Customer_emailNormalized_key" UNIQUE ("emailNormalized")
);
CREATE INDEX "Customer_emailNormalized_idx" ON "Customer"("emailNormalized");
CREATE INDEX "Customer_createdAt_idx" ON "Customer"("createdAt");

CREATE TABLE "MemberProfile" (
 "id" UUID PRIMARY KEY,
 "customerId" UUID NOT NULL REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "memberNo" TEXT NOT NULL CHECK ("memberNo" ~ '^MB-[0-9]{8}-[A-Z0-9]{6}$'),
 "consentRef" TEXT CHECK ("consentRef" IS NULL OR length("consentRef") BETWEEN 1 AND 200),
 "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','suspended','closed')),
 "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "MemberProfile_customerId_key" UNIQUE ("customerId"),
 CONSTRAINT "MemberProfile_memberNo_key" UNIQUE ("memberNo")
);
CREATE INDEX "MemberProfile_status_idx" ON "MemberProfile"("status");

CREATE TABLE "MemberOtpChallenge" (
 "id" UUID PRIMARY KEY,
 "emailDigest" TEXT NOT NULL CHECK ("emailDigest" ~ '^[0-9a-f]{64}$'),
 "emailCipher" TEXT NOT NULL,
 "codeDigest" TEXT NOT NULL CHECK ("codeDigest" ~ '^[0-9a-f]{64}$'),
 "locale" TEXT NOT NULL CHECK ("locale" IN ('zh-CN','zh-HK','en')),
 "purpose" TEXT NOT NULL DEFAULT 'member_login',
 "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','consumed','expired','failed')),
 "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
 "maxAttempts" INTEGER NOT NULL DEFAULT 5 CHECK ("maxAttempts" BETWEEN 1 AND 10),
 "notificationJobId" UUID,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "verifiedAt" TIMESTAMPTZ(3),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MemberOtpChallenge_emailDigest_createdAt_idx" ON "MemberOtpChallenge"("emailDigest", "createdAt");
CREATE INDEX "MemberOtpChallenge_status_expiresAt_idx" ON "MemberOtpChallenge"("status", "expiresAt");

CREATE TABLE "MemberSession" (
 "id" UUID PRIMARY KEY,
 "memberId" UUID NOT NULL REFERENCES "MemberProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "tokenDigest" TEXT NOT NULL CHECK ("tokenDigest" ~ '^[0-9a-f]{64}$'),
 "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','revoked')),
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "revokedAt" TIMESTAMPTZ(3),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "MemberSession_tokenDigest_key" UNIQUE ("tokenDigest"),
 -- 会话状态与撤销时间必须同时成立：撤销了却没有时间，或有时间却没撤销，都写不进来。
 CONSTRAINT "MemberSession_revoked_check" CHECK (("status" = 'revoked') = ("revokedAt" IS NOT NULL))
);
CREATE INDEX "MemberSession_memberId_idx" ON "MemberSession"("memberId");

CREATE TABLE "OrderMemberLink" (
 "orderId" UUID NOT NULL REFERENCES "ShopOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "memberId" UUID NOT NULL REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "source" TEXT NOT NULL DEFAULT 'email_match' CHECK ("source" IN ('email_match','checkout','manual')),
 "linkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("orderId", "memberId")
);
CREATE INDEX "OrderMemberLink_memberId_idx" ON "OrderMemberLink"("memberId");

-- 会员验证码走同一条通知队列：一封邮件只对应一个目标，kind 与目标列必须严格配对。
ALTER TABLE "IdentityNotificationJob" ADD COLUMN "otpChallengeId" UUID,
 DROP CONSTRAINT "IdentityNotificationJob_target_check";
ALTER TABLE "IdentityNotificationJob" ADD CONSTRAINT "IdentityNotificationJob_target_check" CHECK (
  ("kind" = 'invitation' AND "invitationId" IS NOT NULL AND "passwordResetId" IS NULL AND "otpChallengeId" IS NULL) OR
  ("kind" = 'password_reset' AND "passwordResetId" IS NOT NULL AND "invitationId" IS NULL AND "otpChallengeId" IS NULL) OR
  ("kind" = 'member_otp' AND "otpChallengeId" IS NOT NULL AND "invitationId" IS NULL AND "passwordResetId" IS NULL)
);
ALTER TABLE "IdentityNotificationJob" ADD CONSTRAINT "IdentityNotificationJob_otpChallengeId_fkey"
  FOREIGN KEY ("otpChallengeId") REFERENCES "MemberOtpChallenge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "IdentityNotificationJob_otpChallengeId_idx" ON "IdentityNotificationJob"("otpChallengeId");
