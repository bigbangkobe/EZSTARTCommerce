-- 顾客资料请求（M10 第六批）：后台受理工作流。
-- 四条边界写进数据库：
-- 1. 未核验身份不得处置：status 进入 approved/completed 必须已经 verified，且核验三件套
--    （方法、时间、核验人）同时存在——少一样就不能算核验过。
-- 2. 决定必须留痕：进入 approved/rejected/needs_information/completed 必须同时有决定时间与原因。
-- 3. 完成必须有完成时间：status = 'completed' 与 completedAt 互为充要条件，不能「完成」了却没时间。
-- 4. 重试不重复：idempotencyKey 全表唯一，同一把键不会让核验/决定被执行两次。

CREATE TABLE "PrivacySetting" (
 -- 店铺级单例：请求到期天数（受理后多少天必须处理完）。
 "id" INTEGER PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
 "dueDays" INTEGER NOT NULL DEFAULT 30 CHECK ("dueDays" BETWEEN 1 AND 365),
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "PrivacySetting" ("id") VALUES (1);

CREATE TABLE "CustomerPrivacyRequest" (
 "id" UUID PRIMARY KEY,
 -- 对外单号：PR-YYYYMMDD-0001。顾客与店主沟通时用它，不暴露内部 uuid。
 "requestNumber" TEXT NOT NULL,
 "requestType" TEXT NOT NULL
   CHECK ("requestType" IN ('access','export','correct','withdraw_marketing','delete','anonymize')),
 "sourceChannel" TEXT NOT NULL CHECK ("sourceChannel" IN ('email','phone','admin','storefront')),
 -- 请求范围：要处理哪些类别的资料。只是「顾客说要什么」，不是事实认定。
 "requestScope" TEXT[] NOT NULL DEFAULT '{}',
 -- 申请人自述身份（邮箱/电话/姓名）。核验前它只是线索，不能当成已确认的顾客。
 "customerRef" TEXT CHECK ("customerRef" IS NULL OR char_length("customerRef") BETWEEN 1 AND 200),
 -- 核验通过并确认到具体顾客后才回填；此前为空，避免未核验请求挂到某人名下。
 "customerId" UUID REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "verificationState" TEXT NOT NULL DEFAULT 'pending' CHECK ("verificationState" IN ('pending','verified')),
 "verificationMethod" TEXT,
 "verificationEvidenceRef" TEXT,
 "verifiedAt" TIMESTAMPTZ(3),
 "verifiedBy" UUID REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "status" TEXT NOT NULL DEFAULT 'received'
   CHECK ("status" IN ('received','verified','approved','needs_information','rejected','completed')),
 "receivedAt" TIMESTAMPTZ(3) NOT NULL,
 "dueAt" TIMESTAMPTZ(3) NOT NULL,
 "ownerId" UUID REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "reviewerId" UUID REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "decisionAt" TIMESTAMPTZ(3),
 "decisionReason" TEXT,
 "retentionExceptionRef" TEXT,
 "exportJobRef" TEXT,
 "completedAt" TIMESTAMPTZ(3),
 "idempotencyKey" TEXT,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CustomerPrivacyRequest_requestNumber_key" UNIQUE ("requestNumber"),
 CONSTRAINT "CustomerPrivacyRequest_idempotencyKey_key" UNIQUE ("idempotencyKey"),
 -- 核验是不可逆的：状态说 verified，就必须有方法、时间与核验人。
 CONSTRAINT "privacy_verification_pairing" CHECK (
   ("verificationState" = 'verified')
   = ("verifiedAt" IS NOT NULL AND "verifiedBy" IS NOT NULL AND "verificationMethod" IS NOT NULL)
 ),
 -- 未核验身份不得进入处置阶段。
 CONSTRAINT "privacy_verified_before_handling" CHECK (
   "status" NOT IN ('approved','completed') OR "verificationState" = 'verified'
 ),
 CONSTRAINT "privacy_decision_recorded" CHECK (
   "status" NOT IN ('approved','rejected','needs_information','completed')
   OR ("decisionAt" IS NOT NULL AND "decisionReason" IS NOT NULL)
 ),
 CONSTRAINT "privacy_completion_time" CHECK (
   ("status" = 'completed') = ("completedAt" IS NOT NULL)
 ),
 CONSTRAINT "privacy_due_after_received" CHECK ("dueAt" > "receivedAt"),
 CONSTRAINT "privacy_scope_size" CHECK (
   array_length("requestScope", 1) IS NULL OR array_length("requestScope", 1) <= 20
 )
);
CREATE INDEX "CustomerPrivacyRequest_status_due_idx" ON "CustomerPrivacyRequest"("status", "dueAt");
CREATE INDEX "CustomerPrivacyRequest_due_idx" ON "CustomerPrivacyRequest"("dueAt");
CREATE INDEX "CustomerPrivacyRequest_received_idx" ON "CustomerPrivacyRequest"("receivedAt");
CREATE INDEX "CustomerPrivacyRequest_customer_idx" ON "CustomerPrivacyRequest"("customerId");
