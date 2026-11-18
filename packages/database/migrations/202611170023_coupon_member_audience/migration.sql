-- 优惠会员解锁（M11 续）：批量发放批次（第 24 条迁移）。
-- 批次是「先建、复核收件人数、再确认发放」的两步写：建批只登记意图，
-- 真正发放必须在 issue 时再次确认人数，防止建批后名单被悄悄改动。
--
-- 会员专属等级券不需要新表：Coupon.memberTierIds 已有列，本次只解锁其写入与资格判定。
-- 会员侧限额：CouponRedemption.customerKey 仍存最终键，但报价须先冻结「用哪个主体算限额」，
-- 否则报价按会员身份试算、下单按访客联系方式核销，同一顾客会被算成两个人。

ALTER TABLE "CheckoutQuote" ADD COLUMN "couponCustomerKey" TEXT;

CREATE TABLE "CouponBatch" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "couponId" UUID NOT NULL REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "channel" TEXT NOT NULL CHECK ("channel" IN ('account_only','email','sms')),
  -- 显式名单与筛选条件互斥，且至少要有一个：否则会建出一个不知道发给谁的批次。
  "recipientMemberIds" UUID[] NOT NULL DEFAULT '{}',
  "recipientFilter" JSONB,
  "recipientCount" INTEGER NOT NULL CHECK ("recipientCount" >= 0),
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','issued')),
  "confirmedRecipientCount" INTEGER,
  "templateId" UUID,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "issuedAt" TIMESTAMPTZ(3),
  -- 名单与筛选只能有一个来源。
  CONSTRAINT "coupon_batch_recipients_exclusive" CHECK (
    (cardinality("recipientMemberIds") > 0 AND "recipientFilter" IS NULL)
    OR (cardinality("recipientMemberIds") = 0 AND "recipientFilter" IS NOT NULL)
  ),
  -- issued 必须记确认数、发放人、发放时间，三者同真同假。
  CONSTRAINT "coupon_batch_issued_fields" CHECK (
    ("status" = 'pending' AND "issuedAt" IS NULL AND "confirmedRecipientCount" IS NULL)
    OR ("status" = 'issued' AND "issuedAt" IS NOT NULL AND "confirmedRecipientCount" IS NOT NULL)
  )
);

CREATE INDEX "coupon_batch_created_idx" ON "CouponBatch"("createdAt" DESC, "id" DESC);
CREATE UNIQUE INDEX "coupon_batch_coupon_idempotency_idx" ON "CouponBatch"("couponId", "idempotencyKey");
