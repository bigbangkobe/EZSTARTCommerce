-- 隐私请求的数据处置（M10 批次八A）。
-- 1. 导出工件不落明文：快照用实例密钥加密，AAD 绑任务行，下载时解密并校验 SHA-256。
-- 2. 结构化营销同意：按渠道记录授予/退订，退订是可查询的状态，不是一句备注。
-- 3. 匿名化只改写顾客可识别资料；订单/支付/积分流水等交易事实与审计原样保留。

-- 匿名化后的顾客仍在库里承载交易关联，只是不能再作为可联系人使用：状态闭集加一档。
ALTER TABLE "Customer" DROP CONSTRAINT "Customer_status_check";
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_status_check" CHECK ("status" IN ('active','blocked','anonymized'));

CREATE TABLE "CustomerDataExportJob" (
 "id" UUID PRIMARY KEY,
 "requestId" UUID NOT NULL UNIQUE REFERENCES "CustomerPrivacyRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "customerId" UUID NOT NULL REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "status" TEXT NOT NULL DEFAULT 'ready' CHECK ("status" IN ('ready','expired','revoked')),
 "encryptedPayload" TEXT,
 "byteSize" INTEGER NOT NULL CHECK ("byteSize" >= 0),
 "sha256" CHAR(64) NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
 "createdAt" TIMESTAMPTZ(3) NOT NULL,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "revokedAt" TIMESTAMPTZ(3),
 CONSTRAINT "privacy_export_payload_pairing" CHECK (
   ("status" = 'ready') = ("encryptedPayload" IS NOT NULL)
 )
);
CREATE INDEX "CustomerDataExportJob_customer_idx" ON "CustomerDataExportJob"("customerId");
CREATE INDEX "CustomerDataExportJob_expires_idx" ON "CustomerDataExportJob"("expiresAt");

CREATE TABLE "CustomerConsent" (
 "id" UUID PRIMARY KEY,
 "customerId" UUID NOT NULL REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "channel" TEXT NOT NULL CHECK ("channel" IN ('email','sms','phone','push')),
 "purpose" TEXT NOT NULL DEFAULT 'marketing' CHECK ("purpose" = 'marketing'),
 "status" TEXT NOT NULL CHECK ("status" IN ('granted','withdrawn')),
 "source" TEXT NOT NULL CHECK (char_length("source") BETWEEN 1 AND 80),
 "evidenceRef" TEXT CHECK ("evidenceRef" IS NULL OR char_length("evidenceRef") BETWEEN 1 AND 200),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CustomerConsent_customer_channel_purpose_key" UNIQUE ("customerId", "channel", "purpose")
);
CREATE INDEX "CustomerConsent_customer_status_idx" ON "CustomerConsent"("customerId", "status");
