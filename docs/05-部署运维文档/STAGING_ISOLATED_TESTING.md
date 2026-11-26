# Staging 隔离测试环境搭建与高风险用例执行方案

> 目的：为**高风险、不可逆**的写操作（真实下单、支付回调、退款、售后、主题/陈列发布等）提供一个与生产隔离、可随意重置的环境，
> 使 `MRINHK_LIVE_TEST_SUITE.md` 中标 🔒 的用例能真正跑起来，而**绝不污染生产交易数据或改变线上呈现**。
>
> 适用实例：IN先生 `mrinhk.com`（生产 `ezstart-mrinhk`）。编写日期 2026-11-26。
> 状态：**已执行（2026-11-26 18:00）** —— 复用现有 staging 基础设施并完成高风险用例实测，详见文末「8. 执行记录」。实测结果回填于 `MRINHK_LIVE_TEST_SUITE.md` 第 11 节。

---

## 1. 为什么需要 staging（问题陈述）

生产环境实测已覆盖所有只读接口、加购/报价链路、会员 OTP、CSRF/越权边界。但以下用例**无法在生产安全执行**：

| 类别 | 为何不能在生产测 |
|---|---|
| 真实下单 `POST /checkout/orders` | 产生真实订单、占用库存、写账本；即使清理也会留审计痕迹 |
| 支付渠道回调 `POST /webhooks/payments/*` | 渠道密钥 + 真实资金状态，误触发可能对账错乱 |
| 退款 / 售后 `refunds`、`after-sales` | 不可逆资金动作，需真实支付流水 |
| 主题 / 首页陈列发布 `theme/publish`、`merchandising/publish` | 立即改变线上前台视觉，影响真实访客 |
| 邀请 / 重设密码 / MFA 登记 `admin/auth/*` | 会改动真实管理员账号与会话，可能锁死店主 |
| 大数据量导入 `import-jobs/execute` | 批量写生产商品库，难以精确回滚 |

staging 的价值：**同一套代码、同一套 schema、隔离的数据** —— 在上面把不可逆动作全跑一遍，验证通过后再放心在生产点按钮。

---

## 2. 现状盘点（服务器上已有什么）

实测服务器 `ec2-user@35.79.20.20` 当前状态：

| 资源 | 现状 | 能否复用 |
|---|---|---|
| `ezstart-staging` compose 项目 | `/opt/ezstart-staging`，含 api / caddy / postgres / migrate | ✅ 核心可复用 |
| staging postgres | 95 张表（与生产同 schema），healthy | ✅ |
| staging caddy | `https://localhost:8443`，`tls internal` 自签，仅反代 api | ⚠️ 需补强（无 storefront/admin，无域名） |
| staging api | APP_ORIGIN=`https://localhost:8443`，healthy | ✅ |
| 生产每日备份 | `/opt/ezstart-backups/ezstart-*.sql.gz`（每日 03:10，含库），media tar | ✅ 可作克隆源 |
| 磁盘 / 内存 | 100G 盘用 37%（64G 空闲）；内存 3.9G（约 1G 可用 + 1.8G 缓存可释放） | ✅ 资源充足 |

**结论**：无需新建实例，复用 `ezstart-staging` 并做三项补强即可：**① 数据克隆 + PII 脱敏；② 补齐 admin/storefront 与访问方式；③ 独立测试账号与凭据**。

---

## 3. 方案设计

### 3.1 三种可选方案对比

| 方案 | 做法 | 优点 | 缺点 | 适用 |
|---|---|---|---|---|
| A. 复用现有 staging（**推荐**） | 清空 staging 库 → 导入生产脱敏快照 → 补 admin/storefront | 零新增容器，资源占用最小，10–20 分钟可就绪 | staging 是老自签配置，需小改 Caddyfile | **当前最优** |
| B. 全新独立实例 scratch | 用 `deploy/merchants/scratch-test/` 模板另起一套 | 与 staging 完全隔离，可长期保留两套 | 多一组容器，4G 内存机偏紧 | 需要长期并行多套环境时 |
| C. 每人本地 Docker | 开发者本机起完整栈 | 不占服务器资源 | 无法验证"反代/HTTPS/域名"等真实链路 | 纯功能单测阶段 |

**本方案采用 A**。若后续需要长期保留一套干净的"验收环境"和一套"随手测试环境"，再按 B 加一套。

### 3.2 目标架构

```
                 ┌──────────────────────── 生产（不可动）────────────────────────┐
  访客 ──HTTPS──▶ mrinhk.com / admin.mrinhk.com ──▶ caddy ──▶ [api/storefront/admin/worker] ──▶ 生产 postgres
                 └───────────────────────────────────────────────────────────────┘
                                          │ 每日 pg_dump 快照（脱敏后）
                                          ▼
                 ┌──────────────────────── Staging（可随意重置）──────────────────┐
  测试人员 ─────▶ staging.mrinhk.com:8443（自签/hosts）──▶ caddy ─▶ [api/admin/storefront] ──▶ staging postgres
                 或 SSH 隧道 + 本地 Host                          └─ 独立保密凭据，绝不复用生产密钥
                 └───────────────────────────────────────────────────────────────┘
```

**隔离硬约束**：
1. staging 用**独立的 `INSTANCE_ID`、`IDENTITY_ENCRYPTION_KEY`、管理员密码**，绝不复用生产值。
2. staging 的 `APP_ORIGIN` / `ADMIN_ORIGIN` 指向 staging 域名，避免邀请链接/回调打到生产。
3. staging 数据库**只进不出**：绝不能让 staging 的 worker/回调反向写生产。
4. 网络层：staging caddy 不占用 80/443（用 8443），且**不配公网 DNS**，仅内网/SSH 隧道访问。

---

## 4. 落地步骤

### 步骤 1：克隆生产数据到 staging（含 PII 脱敏）

> 在服务器执行。用最近一次每日备份作为源，避免直接对生产库加锁。

```bash
cd /opt/ezstart-mrinhk/deploy/merchants/mrinhk
SRC=$(ls -1t /opt/ezstart-backups/ezstart-*.sql.gz | head -1)
echo "克隆源: $SRC"

# 1a. 把备份导入 staging 库（先清空，保证 schema 与数据一致）
docker exec -i ezstart-staging-postgres-1 \
  sh -c 'psql -U ezstart -d postgres -c "DROP DATABASE IF EXISTS ezstart;" -c "CREATE DATABASE ezstart OWNER ezstart;"'
gunzip -c "$SRC" | docker exec -i ezstart-staging-postgres-1 psql -U ezstart -d ezstart -v ON_ERROR_STOP=1 >/tmp/staging_restore.log 2>&1 \
  || { echo "导入失败"; tail -30 /tmp/staging_restore.log; exit 1; }
echo "导入完成，表数: $(docker exec ezstart-staging-postgres-1 psql -U ezstart -d ezstart -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public';")"
```

**1b. PII 脱敏**（staging 里不留真实顾客信息）——用下面 SQL 在 staging 库执行。
**以下列名已按 2026-11-26 实际 schema 核对**（`Customer`: emailNormalized/phone/displayName；
`ShopOrder` 的收货人是 JSONB 字段 `contact` / `shippingAddress`）：

```sql
-- 在 staging 库执行：把真实 PII 替换为合成值，保留数据结构与关联关系
UPDATE "Customer" SET "emailNormalized" = 'qa-customer-' || id || '@test.invalid',
  "phone" = '90000000', "displayName" = 'QA Test Customer', "internalNote" = NULL;
-- ShopOrder 的 contact / shippingAddress 是 JSONB，整体替换为合成对象（保留结构）
UPDATE "ShopOrder" SET
  "contact" = jsonb_build_object('fullName','QA Recipient','phone','90000000'),
  "shippingAddress" = jsonb_build_object('recipientName','QA Recipient','phone','90000000',
    'countryCode','HK','city','Hong Kong','addressLine1','QA Test Road 1');
-- 清会话与验证码，避免生产令牌/OTP 残留在 staging
TRUNCATE "AdminSession", "MemberSession", "MemberOtpChallenge", "AnalyticsSession";
```

> ⚠️ **坑**：JSONB 字段（`contact` / `shippingAddress`）的原始 key 可能比上面多。
> 更稳妥的做法是先 `SELECT "contact" FROM "ShopOrder" LIMIT 1;` 看真实结构，
> 用 `jsonb_set` 只覆盖 PII key、保留其余字段；上面的整体替换适合"测试环境无所谓结构细节"的场景。
> 若换过 schema，执行前先 `docker exec ... psql -c '\d "Customer"'` 核对列名。

### 步骤 2：补齐 staging 的 admin / storefront 与访问方式

现有 staging Caddyfile 只反代 api。两种访问方式任选：

**方式 A（推荐，最省事）：只测 API，不测页面** —— 直接用现有 `https://localhost:8443/api/v1/*`，
所有高风险接口（下单/退款/发布）本质是 HTTP 调用，用 curl 即可完整验证，无需页面。

**方式 B：需要连后台页面点按钮** —— 补 admin 服务并改 Caddyfile：

```bash
# 在 /opt/ezstart-staging 的 compose 里加 admin 服务（参照 mrinhk compose，APP 指向 staging api）
# Caddyfile 改为按路径分流：
#   https://localhost:8443 {
#     tls internal
#     handle /api/*   { reverse_proxy api:3001 }
#     handle /admin/* { reverse_proxy admin:3000 }
#     handle          { reverse_proxy admin:3000 }
#   }
cd /opt/ezstart-staging && docker compose up -d --build admin caddy
```

访问：`https://localhost:8443/admin`（自签证书，浏览器需点"继续访问"）。

### 步骤 3：建立 staging 独立管理员账号

```bash
# 用 staging 的 bootstrap 或直接在 staging 库建测试超管（凭据仅测试用，绝不复用生产 admin）
# 关键：staging 的 IDENTITY_ENCRYPTION_KEY 与生产不同，密文不可互换，天然隔离
docker exec -i ezstart-staging-api-1 node --input-type=module -e '...'  # 参照 ADMIN_RECOVERY_RUNBOOK.md 第 1 节生成 hash
```

staging 建议**开启 MFA=false**（纯密码），方便自动化测试脚本登录；因为环境隔离，安全门槛可放宽。

### 步骤 4：把 🔒 用例搬到 staging 执行

按 `MRINHK_LIVE_TEST_SUITE.md` 的用例 ID，以下为 staging 首批执行清单：

| 用例 ID | 动作 | staging 验证点 |
|---|---|---|
| API-184 | POST /checkout/orders | 订单创建、库存扣减、账本一致 |
| API-185 | POST /orders/:id/pay | COD 拒绝 / 在线渠道字段正确 |
| API-004/005 | Webhook 回调 | 签名正确入账一次、重放/乱序幂等 |
| API-094~101 | 退款全流程 | 审批→执行→账本、重复执行幂等 |
| API-086~095 | 售后全流程 | 建案→质检→收货→退款状态机 |
| API-147 | theme/publish | 发布后前台主题变更、rollback 可回滚 |
| API-143 | merchandising/home publish | 陈列发布与前台渲染一致 |
| API-050~055 | 导入任务 | CSV 预检→执行→错误报告→取消 |

执行前先 `curl staging /api/v1/health/live` 确认 200；每测完一类用步骤 1 的快照重置库。

### 步骤 5：重置 staging（可反复）

```bash
# 复制步骤 1 的导入命令即可；或直接重置到干净快照
gunzip -c /opt/ezstart-backups/ezstart-<日期>.sql.gz | \
  docker exec -i ezstart-staging-postgres-1 psql -U ezstart -d ezstart -v ON_ERROR_STOP=1
```

---

## 5. 风险提示与常见坑

| 风险/坑 | 说明与规避 |
|---|---|
| **staging 误连生产库** | staging 的 `DATABASE_URL` 指向自己的 postgres 容器（服务名 `postgres`），与生产 compose 网络隔离。**每次操作前 `docker exec ... sh -c 'echo $DATABASE_URL'` 确认** |
| PII 脱敏遗漏 | 导入生产快照后顾客真实信息进了 staging；必须脱敏，且 staging 不对外网开放 |
| 邮件误发真实顾客 | staging 的 worker 要么不开，要么 SMTP 指向测试邮箱（如 MailHog）；**绝不用生产 SMTP 凭据** |
| 支付回调打生产 | staging 的 `PAYMENTS_BASE_URL` / webhook 地址指向 staging；渠道沙箱密钥与生产分开 |
| 自签证书告警 | staging 用 `tls internal`，curl 加 `-k`，浏览器点继续；不要给 staging 配公网 DNS 和 Let's Encrypt |
| 资源不足 | 4G 内存机同时跑生产+staging 偏紧；测试期间观察 `free -m`，必要时先停 pg-test 释放内存 |
| 备份快照过时 | 克隆源用最近一次每日备份；结构变更后先跑 migrate 再导入 |
| 导入数据带生产管理员会话 | 脱敏 SQL 里 `TRUNCATE AdminSession/MemberSession`，否则 staging 里残留生产会话令牌 |

---

## 6. dev / staging / prod 差异化建议

| 维度 | dev（本地） | staging（本方案） | prod（生产 mrinhk） |
|---|---|---|---|
| 数据 | 合成种子数据 | 生产脱敏快照 | 真实数据 |
| MFA | 关闭 | 关闭（便于自动化） | 店主决策：当前关闭（见 DEPLOY.md 决策记录） |
| 支付/邮件 | 全 mock | 沙箱 / MailHog | 真实渠道、真实 SMTP |
| 写操作 | 随意 | 全覆盖高风险用例 | 只读 + 低风险，谨慎 |
| 重置成本 | 无 | 一次导入即可重置 | 不可重置，需备份回滚 |
| HTTPS | 可 HTTP | 自签 8443 | Let's Encrypt 443 |

---

## 7. 验收标准

- [x] staging 库表数与生产一致（本次导入后 96 表，migrate 无 pending）
- [x] staging `health/live` 200、`health/ready` 200
- [x] 生产快照导入成功且 PII 已脱敏（Customer/ShopOrder 合成值，会话/OTP/队列表已清）
- [x] staging 管理员可用独立凭据登录（`qa.admin@staging.test`，Owner 角色，不复用生产密码）
- [x] 🔒 用例在 staging 跑通并记录（下单/幂等/COD 拒绝/主题发布/CUD 闭环/鉴权边界，详见测试报告第 11 节）
- [x] 生产环境未受任何影响（订单 0、QA 数据 0、MFA 配置未变、health/登录 200）
- [x] 每次测试后能一键重置 staging（本次已用快照重置验证，`ShopOrder` 归 0）

---

> 执行前请确认：① 已阅读 `DEPLOY.md`「关键配置决策记录」；② 明确本次测试窗口；③ 生产与 staging 凭据分离。
> 本方案为可执行清单，实际列名/服务名以服务器上 schema 与 compose 为准，遇到不符先 `psql \d` / `docker inspect` 核对再执行。

---

## 8. 执行记录（2026-11-26 18:00）

### 8.1 与方案的差异（实际执行时的调整）

| 项 | 原方案 | 实际执行 | 原因 |
|---|---|---|---|
| staging 镜像 | 复用现有的 | **用生产源码 `4d946a1` 重建** `ezstart-staging-api:latest` | 原 staging 是 11-21 旧镜像（旧 schema，无 `AdminRole`/`roleIds`），无法代表生产当前代码 |
| 数据克隆 | 导入生产脱敏快照 | 一致（导入 `ezstart-20261126-044147.sql.gz`，96 表） | — |
| 访问方式 | 方式 A（只测 API） | 一致（curl 直连 `https://localhost:8443/api/v1/*`） | 高风险用例本质是 HTTP 调用，无需页面 |
| MFA | 建议 false | **必须显式加 `ADMIN_REQUIRE_MFA=false` 到 compose** | 不加则默认 true，登录返回 202 `enroll_mfa` 而非 200（本次踩坑并修复） |
| 测试超管 | 建独立账号 | 一致（`qa.admin@staging.test`，argon2id 用生产 api 容器生成 hash） | — |
| TRUNCATE | 列 4 张表 | 需加 `IdentityNotificationJob` + `CASCADE` | `MemberOtpChallenge` 被通知队列表外键引用 |

### 8.2 关键命令沉淀（可复用）

```bash
# 重建 staging 镜像（对齐生产代码）
cd /opt/ezstart-mrinhk && docker build -f deploy/shared/Dockerfile.node -t ezstart-staging-api:latest .

# 一键重置 staging（停 api → 清库 → 导入 → 脱敏 → 建账号 → 起 api）
# 完整脚本见本次执行：/tmp/reset_staging.sh（服务器上），核心步骤：
cd /opt/ezstart-staging && docker compose stop api
docker exec ezstart-staging-postgres-1 psql -U ezstart -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ezstart' AND pid<>pg_backend_pid();"
docker exec -i ezstart-staging-postgres-1 psql -U ezstart -d postgres \
  -c 'DROP DATABASE IF EXISTS ezstart;' -c 'CREATE DATABASE ezstart OWNER ezstart;'
gunzip -c "$(ls -1t /opt/ezstart-backups/ezstart-*.sql.gz | head -1)" | \
  docker exec -i ezstart-staging-postgres-1 psql -U ezstart -d ezstart -v ON_ERROR_STOP=1
docker compose up -d api
```

### 8.3 实测覆盖与结论

- 已在隔离库跑通：**真实下单 + 幂等重放 + COD 支付拒绝 + 主题草稿发布到前台生效 + 后台分类/品牌/内容页/优惠券/重定向/媒体上传 CUD + 鉴权边界 + 乐观锁 + 报表**。
- 结论：**0 个新缺陷**，并修正原 OBSERVE-02 定性（主题发布功能正常，生产 404 仅因未配置发布）。
- 仍未覆盖：`E2E-05` 支付 webhook 回调幂等、`API-101` 退款资金执行（staging 无支付沙箱密钥/worker 资金上下文），维持 🔒 静态核查。
- 生产影响：**零**（详见测试报告 11.4）。
