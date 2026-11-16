-- 默认岗位权限包：角色增加稳定标识 presetKey（自定义角色为 NULL）。
ALTER TABLE "AdminRole" ADD COLUMN "presetKey" TEXT;

-- 既有实例的店主角色回填为 owner 预设，便于启动时的预设核对识别。
UPDATE "AdminRole" SET "presetKey" = 'owner' WHERE "kind" = 'owner' AND "presetKey" IS NULL;

CREATE UNIQUE INDEX "AdminRole_presetKey_key" ON "AdminRole"("presetKey");
