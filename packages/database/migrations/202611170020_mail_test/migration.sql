-- 邮件自检（M10 批次七C）：让店主填好 SMTP 凭据后，能自己验证 worker 与投递链路是否可用。
-- 第四种 kind 不绑定任何目标行：邀请/重设/验证码都必须指到一张目标表，自检邮件只需要一个收件人，
-- 收件人只存在于密文里，列表展示用掩码列。
ALTER TABLE "IdentityNotificationJob" DROP CONSTRAINT "IdentityNotificationJob_target_check";
ALTER TABLE "IdentityNotificationJob" ADD CONSTRAINT "IdentityNotificationJob_target_check" CHECK (
  ("kind" = 'invitation' AND "invitationId" IS NOT NULL AND "passwordResetId" IS NULL AND "otpChallengeId" IS NULL) OR
  ("kind" = 'password_reset' AND "passwordResetId" IS NOT NULL AND "invitationId" IS NULL AND "otpChallengeId" IS NULL) OR
  ("kind" = 'member_otp' AND "otpChallengeId" IS NOT NULL AND "invitationId" IS NULL AND "passwordResetId" IS NULL) OR
  ("kind" = 'admin_mail_test' AND "invitationId" IS NULL AND "passwordResetId" IS NULL AND "otpChallengeId" IS NULL)
);

-- 自检收件人在密文销毁后（发送完成）仍要能显示发给谁：只存掩码。
ALTER TABLE "IdentityNotificationJob" ADD COLUMN "maskedTarget" TEXT;
