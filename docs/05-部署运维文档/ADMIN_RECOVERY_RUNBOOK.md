# 管理员凭据恢复与轮换流程

本文件分两层：

1. **密码轮换**：低风险、随时可做，不需要批准流程——只要目标是「换掉一个可能已泄露的密码」。
2. **MFA 因子恢复**：高风险，`禁止手工改数据库关闭 MFA，也禁止把密码重设当作 MFA 恢复`。有可用恢复码时走既有登录验证与正常登记授权；全部因子与恢复码都遗失时，只能按本文件「责任与批准 + 降级程序」执行。

2026-11-23 首次按本文件执行了一次密码轮换与 MFA 强制恢复，实际命令见第 1 节（可复用）。

---

## 0. 当前可执行性

| 场景 | 是否有现成程序 | 做法 |
|---|---|---|
| 超管密码疑泄露 / 需要定期轮换 | ✅ 有（本文第 1 节） | 直接执行；设临时密码 + 强制改密 + 吊销全部会话 |
| MFA 未强制，需要恢复强制 | ✅ 有（本文第 2 节） | 改 `ADMIN_REQUIRE_MFA` 并重建 api；不需要动数据库 |
| 仍有恢复码，但 TOTP 设备丢了 | ✅ 有 | 用恢复码登录 → 正常登记重新绑定 TOTP |
| 因子与恢复码全部遗失 | ⚠️ 只有「需批准」的降级程序（第 4 节） | 按批准流程执行，事后写审计说明 |
| 需要「只看计划、不执行」的离线工具 | ❌ 未实现 | 见「工具实施门槛」 |

---

## 1. 密码轮换（2026-11-23 实测可复用）

目标：旧密码立即失效、其他设备上的会话全部下线、本人下次登录被强制改密。

**为什么用临时密码 + 强制改密**：运维不应知道店主的长期密码。临时密码只用一次，登录后必须自己改。

在服务器上执行（`ec2-user@35.79.20.20`）：

```bash
# 1) 生成临时密码（不经命令行历史、不落盘）
PW=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-22)

# 2) 用 API 容器里的 @node-rs/argon2 算哈希（与登录校验同一实现、同一参数）
HASH=$(printf '%s' "$PW" | docker exec -i ezstart-mrinhk-api-1 node --input-type=module -e "
  const fs=await import('node:fs');
  const {hash,Algorithm}=await import('@node-rs/argon2');
  process.stdout.write(await hash(fs.readFileSync(0,'utf8'),
    {algorithm:Algorithm.Argon2id,memoryCost:65536,timeCost:3,parallelism:1,outputLen:32}));")

# 3) 事务内改哈希 + 置强制改密 + 吊销全部会话与挑战（等价于 invalidateAuthority 的效果）
cat > /tmp/rotate.sql <<SQL
BEGIN;
UPDATE "AdminUser" SET "passwordHash" = '$HASH', "mustChangePassword" = true, "version" = "version" + 1
  WHERE email = 'admin';
UPDATE "AdminSession" SET "revokedAt" = now()
  WHERE "userId" = (SELECT id FROM "AdminUser" WHERE email = 'admin') AND "revokedAt" IS NULL;
UPDATE "AdminChallenge" SET "consumedAt" = now()
  WHERE "userId" = (SELECT id FROM "AdminUser" WHERE email = 'admin') AND "consumedAt" IS NULL;
COMMIT;
SQL
docker exec -i ezstart-mrinhk-postgres-1 psql -U ezstart -d ezstart -v ON_ERROR_STOP=1 < /tmp/rotate.sql
rm -f /tmp/rotate.sql

# 4) 核验：mustChangePassword=t、version 递增、活跃会话 0
docker exec ezstart-mrinhk-postgres-1 psql -U ezstart -d ezstart -tAc \
  'select "mustChangePassword", version from "AdminUser" where email = ''admin'''
docker exec ezstart-mrinhk-postgres-1 psql -U ezstart -d ezstart -tAc \
  'select count(*) from "AdminSession" where "revokedAt" is null'
```

核验（从服务器本机打公网，确认行为而不是只看数据库）：

```bash
# 错密码 → 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://admin.mrinhk.com/api/v1/admin/auth/login \
  -H 'Origin: https://admin.mrinhk.com' -H 'content-type: application/json' \
  -d '{"email":"admin","password":"definitely-wrong"}'
# 临时密码 → 202（启用了 MFA：先要 TOTP）或 200（未启用 MFA：直接建会话）
```

要点与坑：

- **哈希必须在 api 容器内算**：宿主机的 node 与镜像里的 `@node-rs/argon2` 版本/参数不一致会生成永远验证不过的哈希。
- **注意 stdin**：`docker exec` 里的进程看不到宿主机的 `/tmp`，密码只能用 stdin 或 env 传。env 会出现在 `ps`，优先用 stdin。
- 改哈希后**必须同时吊销会话**，否则旧会话仍然有效——数据库改密不经过应用的 `invalidateAuthority`。
- `mustChangePassword=true` 时后端只放行「看会话 / 改密 / 登出」，其它接口一律 403 `PASSWORD_CHANGE_REQUIRED`；后台外壳会把用户重定向到 `/admin/password`（`apps/admin/app/admin-shell.tsx`），不需要人工引导。
- 临时密码只经一次受控渠道交付，**不写进任何文档、聊天记录或工单正文**。

---

## 2. 恢复「强制 MFA」

实例可以显式关闭强制 MFA（私有部署的店主可能只要账号+密码）。恢复步骤：

```bash
cd /opt/ezstart-mrinhk/deploy/merchants/mrinhk
sed -i 's/^ADMIN_REQUIRE_MFA=false/ADMIN_REQUIRE_MFA=true/' .env
docker compose up -d api
```

判定依据是登录应答：**正确的账号密码返回 202**（需要 TOTP）而不是 200。仅看 `.env` 不算验证。

执行前必须确认两条，否则会把店主锁在门外：

```bash
# 1) 是否已绑定因子（>0 表示有 authenticator 可用）
docker exec ezstart-mrinhk-postgres-1 psql -U ezstart -d ezstart -tAc \
  'select count(*) from "MfaFactor"'
# 2) 是否还有未使用的恢复码
docker exec ezstart-mrinhk-postgres-1 psql -U ezstart -d ezstart -tAc \
  'select count(*) from "RecoveryCode"'
```

2026-11-23 执行时：因子 1 条、恢复码 10 条未使用，因此直接开启；正确密码从 200 变为 202。

---

## 3. 责任与批准（MFA 恢复适用）

- 商家预先登记的店主/账户持有人通过合同或上线表中的既有可信渠道提出请求，不使用本次请求临时提供的联系方式作为唯一核验来源。
- 商家另一个已授权负责人批准；如果店主是唯一负责人，按交接时签署的紧急恢复授权和身份核验方式批准，不能临时由客服自行决定。
- 被授权运维人员执行，批准人与执行人分离；记录工单、实例 ID、员工 ID、核验依据、批准时间和执行窗口。身份资料按客户隐私策略受控保存，不写入普通应用日志。

## 4. 因子重置的降级程序（需批准，未默认启用）

**仅在「TOTP 设备与全部恢复码同时遗失」且已按第 3 节完成批准时执行。**它绕过应用的恢复工具设计，因此必须留下说明性审计。

```bash
# 停用因子并要求重新登记：删因子行 + 置 mfaRequired
docker exec ezstart-mrinhk-postgres-1 psql -U ezstart -d ezstart -v ON_ERROR_STOP=1 -c "
BEGIN;
DELETE FROM \"MfaFactor\" WHERE \"userId\" = (SELECT id FROM \"AdminUser\" WHERE email = 'admin');
DELETE FROM \"RecoveryCode\" WHERE \"userId\" = (SELECT id FROM \"AdminUser\" WHERE email = 'admin');
UPDATE \"AdminUser\" SET \"mfaRequired\" = true, \"version\" = \"version\" + 1 WHERE email = 'admin';
UPDATE \"AdminSession\" SET \"revokedAt\" = now()
  WHERE \"userId\" = (SELECT id FROM \"AdminUser\" WHERE email = 'admin') AND \"revokedAt\" IS NULL;
COMMIT;"
```

之后下一次登录会进入「登记 MFA」挑战，用户自行绑定新设备并重新获得恢复码。收尾：确认旧因子/恢复码不可用、账号仍要求 MFA、工单记录核验依据与执行人。

> 注意：这一步只是把账号恢复到「可重新登记」的状态，**不会**自动生成恢复能力，也不会重新打开 `bootstrap` 入口。

## 5. 执行步骤（原恢复工具契约，保持不变）

1. 确认是否为账号入侵；存在可疑行为时先停用账号及撤销会话，并启动事故流程。锁定目标实例、数据库与员工，双人核对；不接受跨实例批量恢复。
2. 核验原有可信联系渠道及批准依据，确认当前没有其他可用验证器/恢复码。缺任一批准或核验依据则不执行，记录拒绝原因。
3. 未来离线工具先显示不含秘密的 dry-run 计划，核对目标、将撤销的因子/会话及恢复授权截止。批准记录绑定具体计划摘要，任何目标变化均重新批准。
4. 执行时在事务中撤销目标员工的旧会话、邀请、登录/登记挑战及旧因子，保留强制 MFA；签发最长 10 分钟且仅可登记的单次恢复能力，不生成普通后台会话。写不可改审计；不能将部署 bootstrap 入口重新打开。
5. 受控渠道交付登记能力；用户登记并确认新 TOTP 后才获得新会话和一次性恢复码。能力到期不延长、不可重复读取；失败重办须重新批准。账户持有人和批准人收到不含秘密的完成/失败通知。
6. 核对旧凭据均不可用、账号已恢复强制 MFA、审计与通知完整，关闭工单。中断或事务失败必须可判断最终状态；不能通过重复执行生成并行有效能力。

## 6. 工具实施门槛

工具必须要求目标实例/用户、批准记录/计划摘要、执行人身份和有效执行窗口；禁止在命令行参数、终端日志或审计输出明文恢复凭据。凭据经受控秘密交付机制发送，工具仅输出关联 ID、状态和到期时间。需要数据库原子消费、重复执行保护、通知失败补偿及双实例隔离测试。

恢复能力应使用独立 purpose，与普通登录和可主动登记的 setup 挑战区分；服务器只允许核准的登记操作。该 purpose、交付方式和 CLI 实现需要与数据库/认证实现一起交付后，才能实际启用本流程。商家应在交接时登记批准人与可信联系渠道，并完成一次隔离环境演练。
