# AWS 环境接入与运维手册

> 版本：v1.0　日期：2026-11-20　状态：已验证（本次连通性实测）
> 用途：把 AWS 环境的接入方式、目录、当前状态、常用操作**固定成文档**，避免每次靠回忆或翻聊天记录。
> 凭证策略：**本文不记录任何密钥明文、密码、Token**。密钥只以路径引用出现，且必须在仓库之外。
> 关联：[私有部署模式](PRIVATE_DEPLOYMENT.md) · [交付工具链规范](../01-产品文档/DELIVERY_TOOLCHAIN_SPEC.md) · [技术架构 v2.0](../03-开发文档/ARCHITECTURE.md)

---

## 1. 环境清单

| 环境 | 用途 | 地址 | 状态 |
|---|---|---|---|
| `prod-mrinhk` | mrinhk 商户正式实例 | `mrinhk.com` / `admin.mrinhk.com` | 运行中 |
| `staging` | 新版本验证、支付链路演练 | `https://localhost:8443`（仅本机，经 SSH 访问） | **运行中**（支付冒烟 25/25，2026-11-20） |
| 本地容器 | 无 AWS 依赖的功能验证 | `docker compose` | 可用 |

> **staging 与生产完全隔离**：独立目录 `/opt/ezstart-staging`、独立 compose project `ezstart-staging`、
> 独立 Postgres 容器与卷、独立端口 8443。停掉 staging 不会影响生产的任何容器或数据；
> 生产卷名是 `ezstart-mrinhk_pgdata`，staging 是 `ezstart-staging_pgdata`，不会被互相误删。
>
> staging 用**内部 CA 自签证书**（`tls internal`），不是偷懒：生产配置强制 `APP_ORIGIN` 必须是 `https://`，
> 用 HTTP 起 staging 会直接被配置校验拒绝。这个"起不来"恰好证明那条约束是有效的。

---

## 2. 连接方式

### 2.1 主机

| 项 | 值 |
|---|---|
| 公网 IP | `35.79.20.20` |
| AWS 区域 | `ap-northeast-1`（东京） |
| 内网主机名 | `ip-172-31-30-215.ap-northeast-1.compute.internal` |
| 系统 | Amazon Linux 2023（`dnf`） |
| 规格 | 2 vCPU / 3.9 GB RAM / 100 GB 根卷（`/dev/xvda1`） |
| SSH 用户 | **`ec2-user`**（不是 `ubuntu`、不是 `root`） |

### 2.2 密钥

| 项 | 值 |
|---|---|
| 本地路径 | `~/.ssh/in.pem`（Windows：`C:\Users\Administrator\.ssh\in.pem`） |
| 原始备份 | `D:/Projects/OneNeXX/资料/AWS/IN.pem` |
| 权限要求 | `chmod 600`，否则 SSH 拒绝使用 |
| 是否入库 | **否**。`.pem` 永不进 Git，不写入任何 md |

同目录另有 `erp_aws.pem`、`onenexx_aws.pem`，属**其它项目**，不要混用。

### 2.3 连接命令

```bash
chmod 600 ~/.ssh/in.pem
ssh -i ~/.ssh/in.pem -o StrictHostKeyChecking=no ec2-user@35.79.20.20
```

首次连接会出现 post-quantum 算法告警（`store now, decrypt later`），属 OpenSSH 版本提示，不影响使用。

### 2.4 权限边界

| 允许 | 不允许 |
|---|---|
| 读取容器状态、日志、磁盘 | 未经确认删除数据卷 |
| 在隔离目录起 staging 演练 | 直接改生产 `.env` 并重启 |
| 拉取代码、构建、迁移 | 对生产库执行 `DROP` / 清空 |
| 执行备份与只读核对 | 修改 DNS、安全组、IAM（需控制台） |

---

## 3. 目录结构

```text
/opt/ezstart-mrinhk/                  # git 仓库（属主 ec2-user）
├── .env                               # 生产环境变量，chmod 600，不入库
├── deploy/merchants/mrinhk/
│   ├── docker-compose.yml             # 实例编排
│   ├── Caddyfile                      # 域名与反代
│   ├── deploy.sh                      # 一键部署：备份→pull→build→migrate→健康→冒烟
│   ├── DEPLOY.md                      # 实例级部署说明
│   └── instance.example.yaml          # 实例配置样例
└── apps / packages / scripts          # 源码

/opt/ezstart-mrinhk.bak-20261117-041145   # 历史目录备份（可清理，确认无用后）
/home/ec2-user/ezstart-test               # 服务器侧测试工作区（DB 回归用）
```

---

## 4. 服务拓扑

| 容器 | 端口 | 暴露 | 说明 |
|---|---|---|---|
| `ezstart-mrinhk-caddy-1` | 80 / 443 | **公网** | 唯一公网入口，自动 HTTPS |
| `ezstart-mrinhk-api-1` | 3000 | 内网 | 带 healthcheck |
| `ezstart-mrinhk-admin-1` | 3000 | 内网 | 后台，走 `admin.mrinhk.com` |
| `ezstart-mrinhk-storefront-1` | 3000 | 内网 | 前台，走 `mrinhk.com` |
| `ezstart-mrinhk-postgres-1` | 5432 | 内网 | 数据卷持久化 |
| `ezstart-mrinhk-worker` | — | — | 按需启动（SMTP 配置后） |

域名分流（Caddy）：

```text
mrinhk.com, www.mrinhk.com  → storefront:3000
admin.mrinhk.com            → admin:3000
mrinhk.com/api/*            → api:3000
```

> 后台在**独立子域名** `admin.mrinhk.com`，不在 `mrinhk.com/admin/`（后者 404）。这是历史决策，排障时容易踩。

---

## 5. 当前状态快照（2026-11-20 支付版本发布后实测）

| 项 | 值 |
|---|---|
| 代码版本 | `61682e8`（`docs: 记录 staging 支付版本实测与迁移校验和坑`） |
| 上一版本 | `234c746`（镜像 tag `:prev` 已保留，可回滚） |
| 工作区 | 干净，无未提交改动 |
| 容器 | caddy / api / admin / storefront / postgres 全部 Up，api `healthy` |
| 运行时长 | 主机 uptime 4 天；caddy/postgres 3 天 |
| 磁盘 | 28 GB / 100 GB（28%） |
| 内存 | 已用 1090 MB / 3.9 GB，可用 2417 MB |
| `mrinhk.com` | 307 → `/zh-HK`，跟随 200 |
| `admin.mrinhk.com` | 307 → `/admin/login`，跟随 200 |
| `/api/v1/health/ready` | **200** |
| 数据库迁移 | **36 条**已应用（新增 `202611200400_refund_event_types`） |
| 主题发布 | 未发布（后台主题配置尚未走发布流程） |
| 线上支付 | 代码就绪，**渠道未启用**（仅 COD 可用；`mock` 为 sandbox 专用，生产 404） |

### 5.1 本次发布的复核结果（2026-11-20 15:13–15:17）

| 检查项 | 结果 |
|---|---|
| 快进合并 | `234c746 → 61682e8`，10 个提交，57 文件 |
| 部署前备份 | `/opt/ezstart-backups/ezstart-20261120-151337.sql.gz`，gzip 校验通过，95 张表 |
| 迁移 | `migrate` 一次性容器退出码 0，36 条；`RefundEvent_type_check` 已扩到 10 类 |
| 停机窗口 | 构建期间旧容器持续服务；重建在 15:16:32–15:17:00，约 30 秒 |
| 健康 | `live` / `ready` 均 200 |
| 前台 | `/zh-HK`、`products`、三语商品详情、`cart`、`checkout`、`categories`、`collections`、`login`、`sitemap.xml` 全 200 |
| 后台 | `admin.mrinhk.com/admin/login` 200，登录表单要素齐全 |
| 支付配置未被动 | `cod`（production，已启用）、`manual_bank_transfer`（停用），与发布前一致 |
| 新端点接线 | `GET /admin/payment-methods` 无凭证 401；`POST /payments/webhook/mock` 生产环境 404（渠道不注册） |
| API 日志 | 部署后无 error / fatal |
| staging 隔离 | 三个 staging 容器仍在跑，未受影响 |

> **2026-11-21 已处置**：首次发布后发现生产容器里既没有 `PAYMENTS_BASE_URL` 也没有
> `INTERNAL_JOB_TOKEN` —— 只写 `.env` 不生效，因为 `docker-compose.yml` 的 `api.environment`
> 没有透传。后果比 503 更严重：`PAYMENTS_BASE_URL` 缺失时 `app.ts` 直接把线上支付依赖置为
> `null`，webhook 路由根本不存在，客户配好渠道也收不了钱，且现象只是 404。
> 已在两处 compose（mrinhk 实例 + 实例交付模板）补齐并重启 API 验证：
> `PAYMENTS_BASE_URL` 由 `SITE_DOMAIN` 推导、`PAYMENTS_ENVIRONMENT=production`、
> 令牌 64 位随机；对账无令牌/错令牌 401、带令牌返回计数；systemd timer 每 10 分钟跑一次。

### 5.2 待清理项

| 项 | 说明 | 影响 |
|---|---|---|
| `ezstart-pg-test` 容器 | 测试残留，已运行 3 天，占内存 | 低；确认无测试在跑后可 `docker rm -f` |
| Docker 构建缓存 | 12.5 GB 可回收（`docker builder prune`） | 低；磁盘仍余 73 GB，暂不动 |
| `/opt/ezstart-mrinhk.bak-20261117-041145` | 历史目录备份 | 低；确认后清理释放磁盘 |

---

## 6. 常用操作

### 6.1 一键部署

```bash
ssh -i ~/.ssh/in.pem ec2-user@35.79.20.20
cd /opt/ezstart-mrinhk/deploy/merchants/mrinhk
./deploy.sh
```

`deploy.sh` 顺序：备份库 → `git pull --ff-only` → 构建镜像 → 应用迁移 → 健康检查 → 冒烟。**不要跳过备份步骤。**

### 6.2 状态与日志

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
docker logs --tail 100 ezstart-mrinhk-api-1
docker logs --tail 100 ezstart-mrinhk-caddy-1
```

### 6.3 公网冒烟

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://mrinhk.com/api/v1/health/ready
curl -s -o /dev/null -w "%{http_code}\n" https://mrinhk.com
curl -s -o /dev/null -w "%{http_code}\n" https://admin.mrinhk.com
```

预期：`200` / `307` / `307`。

### 6.3.1 备份恢复演练（2026-11-20 实测，可复现）

```bash
# 1) 生产库备份（容器内执行，不落主机明文）
docker exec ezstart-mrinhk-postgres-1 pg_dump -U ezstart -d ezstart -Fc -f /tmp/drill.dump
docker cp ezstart-mrinhk-postgres-1:/tmp/drill.dump /tmp/drill.dump

# 2) 恢复到 staging 的独立演练库（不与 staging 业务库混）
docker exec ezstart-staging-postgres-1 psql -U ezstart -d postgres \
  -c 'drop database if exists restore_drill' -c 'create database restore_drill'
docker cp /tmp/drill.dump ezstart-staging-postgres-1:/tmp/drill.dump
docker exec ezstart-staging-postgres-1 pg_restore -U ezstart -d restore_drill --no-owner --no-privileges /tmp/drill.dump

# 3) 比对行数与结构
docker exec ezstart-staging-postgres-1 psql -U ezstart -d restore_drill -tAc \
  'select (select count(*) from "ShopOrder"), (select count(*) from "Product"), (select count(*) from "_prisma_migrations")'

# 4) 在副本上试跑新迁移（升级演练）
docker run --rm --network ezstart-staging_default \
  -e DATABASE_URL='postgresql://ezstart:<pw>@ezstart-staging-postgres-1:5432/restore_drill' \
  ezstart-staging-api node node_modules/prisma/build/index.js migrate deploy \
  --config packages/database/prisma.config.ts
```

实测：318 KB / 备份 <1s / 恢复 2s / 95 表一致 / 新迁移应用成功（35 → 36）。

### 6.4 备份（2026-11-23 起每日自动）

**现状**：生产由 systemd timer 每天 03:10 自动备份，不再依赖"部署时才备份"。

| 项 | 值 |
|---|---|
| 脚本 | `/home/ec2-user/ezstart-backup.sh`（`chmod 750`） |
| 单元 | `/etc/systemd/system/ezstart-backup.{service,timer}`，`Persistent=true` |
| 输出 | `/opt/ezstart-backups/ezstart-<日期>-<时分>.dump`（`pg_dump -Fc`，`chmod 600`） |
| 校验 | 回读 `pg_restore -l`，列出 95 个 `TABLE DATA` 才算成功；截断的 dump 算失败 |
| 保留 | 默认 14 份，自动裁剪（`KEEP_BACKUPS` 可调） |
| 日志 | `/opt/ezstart-backups/backup.log` |

手动触发与核验：

```bash
sudo systemctl start ezstart-backup.service
tail -3 /opt/ezstart-backups/backup.log
systemctl list-timers ezstart-backup.timer
```

```bash
# 兜底：不走脚本，直接恢复成 SQL 文本看内容是否完整
gunzip -c /opt/ezstart-backups/ezstart-20261121-101945.sql.gz | head -20
```

**异机备份仍未完成（仍是同盘）**。脚本已支持对象存储，配好这两样即生效，无需改代码：

```bash
sudo tee /etc/ezstart-backup.env >/dev/null <<'EOF'
BACKUP_BUCKET=s3://<桶名>/ezstart-mrinhk
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=ap-northeast-1
EOF
sudo chmod 600 /etc/ezstart-backup.env
sudo systemctl start ezstart-backup.service && tail -2 /opt/ezstart-backups/backup.log
```

> 服务器上的 `aws` CLI 已安装但**没有凭据、也没有 IAM role**（`aws sts get-caller-identity` 返回 `NoCredentials`）。
> 最小权限：该 IAM 用户只需 `s3:PutObject`（恢复演练再加 `s3:GetObject`），桶开版本控制 + 生命周期。
> 另外建议在 Lightsail 控制台打开每日自动快照——那是控制台操作，CLI 同样需要凭据。

需记录：备份文件名、大小、`pg_restore -l` 表数、存放位置（本机 / 桶前缀）。

### 6.5 回滚

```bash
cd /opt/ezstart-mrinhk
git log --oneline -5
git checkout <上一个稳定 commit>
cd deploy/merchants/mrinhk && ./deploy.sh
```

迁移不回滚（Prisma 只前进）；回滚代码前必须确认新版本迁移**向后兼容**。

### 6.6 staging 实例（已验证可用）

```bash
# 状态
cd /opt/ezstart-staging && docker compose ps

# 重建镜像（源码在 /opt/ezstart-staging/src）
cd /opt/ezstart-staging/src && docker build -f deploy/shared/Dockerfile.node -t ezstart-staging-api .

# 重启
cd /opt/ezstart-staging && docker compose up -d --no-build

# 冒烟（从服务器本机执行；证书是内部 CA，需 -k）
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8443/api/v1/health/ready

# 对账任务（令牌在 /opt/ezstart-staging/.env）
curl -sk -X POST https://localhost:8443/api/v1/internal/jobs/reconcile \
  -H 'content-type: application/json' -H "x-job-token: $INTERNAL_JOB_TOKEN" -d '{"olderThanMinutes":5}'
```

**2026-11-20 第二轮实测**（支付版本 `c8c6760`，库从零重建）

| 检查项 | 结果 |
|---|---|
| 库重建 | 删除 staging 卷后从零应用 **36 条**迁移，`_prisma_migrations` 与代码清单逐条校验通过 |
| `/health/live` | 200 |
| `/health/ready` | 200（迁移清单、Postgres 版本、`AdminUser` 可查全部通过） |
| 支付渠道自助配置 | 后台播种行存在 → 填 `secret://env/` 引用 → 连接测试 `ok` |
| 端到端支付冒烟 | **25/25 通过**（见下） |
| 生产隔离 | 同期 `mrinhk.com/api/v1/health/ready` 200，5 个生产容器全部 Up |

冒烟脚本 `scripts/smoke-payments.mjs` 覆盖四段：

| 段 | 断言 |
|---|---|
| 初始化 | 店主引导与 MFA、市场审核启用、商品上架、运费、渠道播种与连接测试 |
| 收钱 | 下单 → 收银台跳转 → 错签名 400 → 过期时间戳 400 → 正确签名 202 `accepted` → 台账 `succeeded` → 重复回调 202 `duplicate` → 流水仍 1 条 |
| 退钱 | 发起 → 同一人批准被拒 403 `SELF_APPROVAL_FORBIDDEN` → 财务账号批准 → 执行收敛 `refunded`（含渠道退款号）→ 幂等重放 409 → 超额 409 `REFUND_EXCEEDS_BALANCE` |
| 对账 | 无令牌 401；带令牌 200 并返回计数 |

复用命令：

```bash
cd /opt/ezstart-staging
docker compose run --rm --no-deps -T \
  -v /opt/ezstart-staging/src:/repo:ro \
  -v /opt/ezstart-secrets:/secrets \
  api node /repo/scripts/smoke-payments.mjs
```

> 脚本只允许 `PAYMENTS_ENVIRONMENT=sandbox` 的实例运行，且会在开跑前清理 `ip:` 限流计数
> （15 分钟 60 次的阈值针对真实用户，不针对同一台机器上的验收脚本；账号级失败计数不动）。
> 财务账号由脚本自行创建（走真实 MFA 注册流程），凭据写入 `/opt/ezstart-secrets/admin.json`（600）。
> **mock 适配器的支付单存在进程内存里**：容器重启后历史 mock 单查不到，这不影响真渠道，但冒烟必须在同一次部署内连跑。

### 6.6.1 坑：迁移校验和与换行符（API 起不来先查这里）

API 启动时会把 `packages/database/migrations/*/migration.sql` 的 sha256 与库内 `_prisma_migrations.checksum` 逐条比对，不一致直接拒绝启动，日志只有一行 `api.start_failed / CONFIGURATION_OR_DATABASE_UNAVAILABLE`——**故意不打印细节**，因为真实错误可能带连接串。

本次踩到：staging 库早期是用**从 Windows 直接拷贝的 CRLF 源码**建的，库里记的是 CRLF 版本的校验和；后来改为 `git archive` 投递（`.gitattributes` 强制 LF），同一文件 LF 版 1286 字节、CRLF 版 1304 字节，checksum 全不一致 → 启动失败。

判别与处置：

```bash
# 1) 看两边字节数与 sha256（12 位足够比对）
sha256sum packages/database/migrations/202611160001_invitations/migration.sql
# 2) 看库里记的值
docker compose exec -T postgres psql -U ezstart -d ezstart -tAc \
  "select migration_name, left(checksum,12) from _prisma_migrations where migration_name like '202611160001%'"
```

- **生产**：库内是 LF 校验和（`11a3b6babd6b`），与 `git archive` 投递一致 → 安全。
- **staging**：库内是 CRLF（`b42423b27f08`），属历史包袱 → 删卷重建，不要改代码放宽校验。

**硬规则**：部署源码一律用 `git archive`（或服务器本地 `git pull`）投递，不要从 Windows 工作区直接 `scp`/`rsync` 整个目录；`migration.sql` 一旦应用就不能再改内容（包括换行），否则等于改了历史。


> staging 不发布 80/443（生产 Caddy 占用）。这也是已知缺口 4：同机多实例的端口尚未参数化。

### 6.7 对账定时任务（生产必配）

回调不会永远到。渠道重试耗尽、进程在落库前重启、网络单向不通，都会让一笔已成功的支付停在
`pending`——**钱收了，系统不知道**。所以对账不是"以后再说"的优化项，是上线门槛。

```bash
# 手动跑一次（在实例目录下）
cd deploy/merchants/mrinhk
docker compose exec -T api node scripts/reconcile.mjs

# 只处理 60 分钟前的，最多 200 条
docker compose exec -T api node scripts/reconcile.mjs --older-than=60 --limit=200
```

生产用 systemd timer（本机 crond 未启用，timer 更可靠、能开机自启、日志进 journal）：

```ini
# /etc/systemd/system/ezstart-reconcile.service
[Unit]
Description=EZStart 支付对账任务（mrinhk）
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=ec2-user
WorkingDirectory=/opt/ezstart-mrinhk/deploy/merchants/mrinhk
ExecStart=/usr/bin/docker compose exec -T api node scripts/reconcile.mjs
TimeoutStartSec=300

# /etc/systemd/system/ezstart-reconcile.timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
AccuracySec=30s
Unit=ezstart-reconcile.service
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ezstart-reconcile.timer
systemctl list-timers ezstart-reconcile.timer      # 看下次触发
sudo journalctl -u ezstart-reconcile.service -n 20 # 看每轮计数
```

若要改回 cron，等价的 crontab 行是：

```cron
*/15 * * * * cd /opt/ezstart-mrinhk/deploy/merchants/mrinhk && docker compose exec -T api node scripts/reconcile.mjs >> /var/log/ezstart-reconcile.log 2>&1
```

要点：

- 令牌从容器环境变量 `INTERNAL_JOB_TOKEN` 读，**不进命令行**（命令行会出现在 `ps` 与 history 里）。
- 未配置令牌时该端点整体 503，不会留下未受保护的运维入口。
- **变量必须在 `docker-compose.yml` 的 `api.environment` 里显式透传**——只写 `.env` 不生效，这是 2026-11-21 实际踩到的坑。
- 脚本只打印计数，不打印订单号：日志长期留存，没必要把客户订单散进去。
- 有失败项也返回 0 并打印明细——对账"跑完了但有几笔要人看"不等于作业失败，否则定时任务天天报警会被忽略。

### 6.8 清理 staging

```bash
cd /opt/ezstart-staging && docker compose down          # 停容器，保留卷
cd /opt/ezstart-staging && docker compose down -v       # 连卷一起删（仅 staging）
docker rmi ezstart-staging-api                          # 删镜像
```

---

## 7. 凭证与密钥管理

| 凭证 | 存放位置 | 轮换 |
|---|---|---|
| SSH 私钥 | `~/.ssh/in.pem`（本地）＋ `D:/Projects/OneNeXX/资料/AWS/IN.pem`（备份） | 泄露即换密钥对 |
| 应用 `.env` | 服务器 `/opt/ezstart-mrinhk/.env`，`chmod 600` | 按需；`instance:init` 可生成 |
| 数据库密码 | 同上 `.env` | 与 PG 卷同步修改 |
| 支付渠道密钥 | **AWS Secrets Manager**（W2 接入），DB 只存 `secret://` 引用 | 90 天 |
| AWS 访问 | 控制台 / IAM 用户，**不入库** | 按需 |

**硬规则：**
- `.pem`、`.env`、任何 `secret://` 指向的实际值，**永远不写进 md、不写进 Git、不发到聊天**。
- 文档里只允许出现"路径"和"引用名"。
- 日志检索密钥明文必须为 0 命中（对应测试用例 CFG-05）。

---

## 8. 已知问题（复制第二客户前必修）

| 编号 | 问题 | 影响 | 计划 |
|---|---|---|---|
| D1 | 新实例无 `apps/storefront-<id>` 目录 | 前台构建失败 | W9 |
| D2 | `migrate` 不自动构建镜像 | 手工 `up migrate` 拉不到镜像 | W9 |
| D3 | compose 模板头部硬编码 `35.79.20.20` | 新客户实例带出旧服务器信息 | W9 |
| D4 | Caddy 端口硬编码 80/443 | 同机多实例冲突 | W9 |
| D5 | 无独立 staging | 支付/迁移演练有生产风险 | W4 |
| D6 | 备份与数据同机 | 主机故障即同时丢失 | W4；2026-11-23 已加每日自动备份与校验，**异机部分仍待桶与凭据** |

---

## 9. 待建基础设施（方案 C 范围）

| 项 | 周次 | 说明 |
|---|---|---|
| staging 实例 | W4 | 独立主机或独立 compose project + 独立域名 |
| S3 媒体 Bucket | W4 | 私有 + 签名 URL + 生命周期，每实例独立前缀 |
| CloudWatch | W4 | 日志组、5xx、支付失败率、回调积压、证书到期 |
| ECR | W4 | CI 构建推送，服务器只拉取（消除 4 GB OOM） |
| Secrets Manager | W2 | `ezstart/<instanceId>/payment/*` 前缀，IAM 限本实例 |

---

## 10. 变更记录

| 日期 | 内容 | 执行人 |
|---|---|---|
| 2026-11-16 | 首次部署至 `35.79.20.20`，`ec2-user`，域名解析生效 | — |
| 2026-11-17 | 改为 git 部署；DB 回归 183/183；从零迁移 16 条通过 | — |
| 2026-11-18 | 生产部署 `7c1b569`（25 条迁移），报表模块上线 | — |
| 2026-11-20 | 本文档建立；实测连通与状态快照；代码 `234c746`（35 条迁移） | — |
| 2026-11-20 | staging 库重建并部署支付版本 `c8c6760`；36 条迁移从零应用；支付冒烟 25/25；记录迁移校验和换行符坑 | — |
| 2026-11-23 | 安全收口：超管密码轮换为一次性临时密码（`mustChangePassword=true`，28 个旧会话全部吊销）；`ADMIN_REQUIRE_MFA` 由 `false` 恢复为 `true` 并重建 api（正确密码应答 200→202）；操作程序写入 [ADMIN_RECOVERY_RUNBOOK.md](ADMIN_RECOVERY_RUNBOOK.md) | — |
| 2026-11-23 | 备份闭环：安装 `/home/ec2-user/ezstart-backup.sh` 与 `ezstart-backup.timer`（每日 03:10、`pg_restore -l` 校验、保留 14 份）；首跑 356,939 bytes / 95 张表；异机上传待 `BACKUP_BUCKET` 与凭据 | — |
| 2026-11-23 | 发布 `e2bc225`（**39 条迁移**）：M05 批量导入后端与后台页、CSRF 判定显式化；部署前备份 357,253 B / 95 表；migrate 退出 0；停机约 30 秒；冒烟 `ready/site/products/adminlogin/importpage=200`、导入端点无会话 401、伪造 Origin 403、登录 202。步骤与结果见 [RELEASE_M05_IMPORT.md](RELEASE_M05_IMPORT.md) | — |
| 2026-11-20 | **生产升级到 `61682e8`**（36 条迁移），线上支付编排/退款/对账代码上线；渠道仍未启用；停机约 30 秒；备份 `ezstart-20261120-151337.sql.gz` | — |

---

> 本文为运维接入基线。任何新增环境、凭证位置变更、拓扑调整，必须同步更新本文件——**不允许只改服务器不改文档**。
