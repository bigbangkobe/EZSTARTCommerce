-- 店主直建员工账号：一次性初始密码标记
--
-- 背景：邮件邀请依赖 SMTP，实例未配发信时「超管给员工建号」这条路是断的。
-- 允许店主直接指定账号与初始密码建号，但初始密码会经微信/口头传递，
-- 因此首次登录必须由员工本人改密后才能使用后台。
--
-- 兼容性：默认 false。存量账号与邀请流程创建的账号都不受影响。

ALTER TABLE "AdminUser" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- 只为「已直建但还没改密」的少数账号服务，按需查询；部分索引避免全表扫描。
CREATE INDEX "AdminUser_mustChangePassword_idx" ON "AdminUser" ("mustChangePassword") WHERE "mustChangePassword" = true;
