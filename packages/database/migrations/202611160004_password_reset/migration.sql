CREATE TABLE "AdminPasswordReset" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "tokenDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL,
    "notificationJobId" UUID,
    CONSTRAINT "AdminPasswordReset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminPasswordReset_userId_key" ON "AdminPasswordReset"("userId");
CREATE UNIQUE INDEX "AdminPasswordReset_tokenDigest_key" ON "AdminPasswordReset"("tokenDigest");

ALTER TABLE "AdminPasswordReset"
  ADD CONSTRAINT "AdminPasswordReset_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One delivery queue for every single-use identity secret. Existing rows are invitations.
ALTER TABLE "IdentityNotificationJob" RENAME COLUMN "invitationVersion" TO "targetVersion";
ALTER TABLE "IdentityNotificationJob"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'invitation',
  ADD COLUMN "passwordResetId" UUID,
  ALTER COLUMN "invitationId" DROP NOT NULL;

ALTER TABLE "IdentityNotificationJob"
  ADD CONSTRAINT "IdentityNotificationJob_passwordResetId_fkey" FOREIGN KEY ("passwordResetId")
  REFERENCES "AdminPasswordReset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A job must reference exactly the target its kind describes; neither zero nor two.
ALTER TABLE "IdentityNotificationJob"
  ADD CONSTRAINT "IdentityNotificationJob_target_check" CHECK (
    ("kind" = 'invitation' AND "invitationId" IS NOT NULL AND "passwordResetId" IS NULL) OR
    ("kind" = 'password_reset' AND "passwordResetId" IS NOT NULL AND "invitationId" IS NULL)
  );

CREATE INDEX "IdentityNotificationJob_passwordResetId_idx" ON "IdentityNotificationJob"("passwordResetId");
