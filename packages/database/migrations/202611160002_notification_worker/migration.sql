ALTER TABLE "IdentityNotificationJob" DROP CONSTRAINT "IdentityNotificationJob_status_check";
ALTER TABLE "IdentityNotificationJob" ADD CONSTRAINT "IdentityNotificationJob_status_check" CHECK ("status" IN ('pending','processing','cancelled','sent','failed'));
ALTER TABLE "IdentityNotificationJob"
 ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
 ADD COLUMN "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN "leaseToken" UUID,
 ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(3),
 ADD COLUMN "lastErrorCode" TEXT,
 ADD COLUMN "sentAt" TIMESTAMPTZ(3);
CREATE INDEX "IdentityNotificationJob_status_availableAt_leaseExpiresAt_idx" ON "IdentityNotificationJob"("status", "availableAt", "leaseExpiresAt");
