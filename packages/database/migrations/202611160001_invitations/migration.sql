CREATE TABLE "AdminInvitation" (
 "id" UUID PRIMARY KEY, "userId" UUID NOT NULL UNIQUE REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "inviterId" UUID NOT NULL REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
 "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','accepted','revoked')),
 "tokenDigest" TEXT NOT NULL UNIQUE, "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "lastSentAt" TIMESTAMPTZ(3) NOT NULL, "sendWindowStartedAt" TIMESTAMPTZ(3) NOT NULL,
 "sendsInWindow" INTEGER NOT NULL CHECK ("sendsInWindow" > 0),
 "notificationJobId" UUID, "resendReceipts" JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE "IdentityNotificationJob" (
 "id" UUID PRIMARY KEY, "invitationId" UUID NOT NULL REFERENCES "AdminInvitation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "invitationVersion" INTEGER NOT NULL CHECK ("invitationVersion" > 0), "encryptedPayload" TEXT,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','cancelled','sent','failed')),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "IdentityNotificationJob_status_expiresAt_idx" ON "IdentityNotificationJob"("status", "expiresAt");
