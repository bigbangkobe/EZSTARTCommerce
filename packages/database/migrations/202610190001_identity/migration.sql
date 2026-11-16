-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "passwordHash" TEXT NOT NULL,
    "mfaRequired" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminRole" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "permissionCodes" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AdminRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUserRole" (
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,

    CONSTRAINT "AdminUserRole_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "BootstrapState" (
    "id" INTEGER NOT NULL,
    "tokenDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BootstrapState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminChallenge" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenDigest" TEXT NOT NULL,
    "factorVersion" INTEGER NOT NULL,
    "userVersion" INTEGER NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "enrollmentId" UUID,
    "pendingSecret" TEXT,

    CONSTRAINT "AdminChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaFactor" (
    "userId" UUID NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastUsedStep" BIGINT NOT NULL DEFAULT -1,

    CONSTRAINT "MfaFactor_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RecoveryCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "digest" TEXT NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenDigest" TEXT NOT NULL,
    "mfaVerified" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "idleExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityRateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "blockedUntil" TIMESTAMPTZ(3),

    CONSTRAINT "IdentityRateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "objectId" TEXT,
    "result" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "reason" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AdminRole_name_key" ON "AdminRole"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BootstrapState_tokenDigest_key" ON "BootstrapState"("tokenDigest");

-- CreateIndex
CREATE UNIQUE INDEX "AdminChallenge_tokenDigest_key" ON "AdminChallenge"("tokenDigest");

-- CreateIndex
CREATE UNIQUE INDEX "AdminChallenge_enrollmentId_key" ON "AdminChallenge"("enrollmentId");

-- CreateIndex
CREATE INDEX "AdminChallenge_expiresAt_idx" ON "AdminChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCode_digest_key" ON "RecoveryCode"("digest");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenDigest_key" ON "AdminSession"("tokenDigest");

-- CreateIndex
CREATE INDEX "AdminSession_userId_revokedAt_idx" ON "AdminSession"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "AuditLog_occurredAt_idx" ON "AuditLog"("occurredAt");

-- AddForeignKey
ALTER TABLE "AdminUserRole" ADD CONSTRAINT "AdminUserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminUserRole" ADD CONSTRAINT "AdminUserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminChallenge" ADD CONSTRAINT "AdminChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaFactor" ADD CONSTRAINT "MfaFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Constraints beyond the Prisma representation, preserved in this migration.
ALTER TABLE "BootstrapState" ADD CONSTRAINT "bootstrap_singleton" CHECK ("id" = 1);
ALTER TABLE "AdminUser" ADD CONSTRAINT "admin_status" CHECK ("status" IN ('invited', 'active', 'suspended'));
ALTER TABLE "AdminUser" ADD CONSTRAINT "admin_email_normalized" CHECK ("email" = lower(trim("email")));
ALTER TABLE "AdminUser" ADD CONSTRAINT "admin_version_positive" CHECK ("version" > 0);
ALTER TABLE "AdminRole" ADD CONSTRAINT "role_version_positive" CHECK ("version" > 0);
CREATE UNIQUE INDEX "single_owner_role" ON "AdminRole" ("kind") WHERE "kind" = 'owner';
ALTER TABLE "AdminChallenge" ADD CONSTRAINT "challenge_purpose" CHECK ("purpose" IN ('verify_mfa', 'enroll_mfa'));
ALTER TABLE "AdminChallenge" ADD CONSTRAINT "challenge_failures_nonnegative" CHECK ("failures" >= 0);
ALTER TABLE "AdminChallenge" ADD CONSTRAINT "enrollment_has_id" CHECK ("pendingSecret" IS NULL OR "enrollmentId" IS NOT NULL);
ALTER TABLE "AdminSession" ADD CONSTRAINT "session_deadlines" CHECK ("idleExpiresAt" <= "absoluteExpiresAt");
ALTER TABLE "IdentityRateLimit" ADD CONSTRAINT "rate_count_nonnegative" CHECK ("count" >= 0);

CREATE FUNCTION reject_identity_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Identity audit log is append-only';
END;
$$;
CREATE TRIGGER identity_audit_append_only BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION reject_identity_audit_mutation();
