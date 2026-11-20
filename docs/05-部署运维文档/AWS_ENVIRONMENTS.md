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
| `staging` | 新版本验证、支付链路演练 | `https://localhost:8443`（仅本机，经 SSH 访问） | **运行中**（2026-11-20 建立） |
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

## 5. 当前状态快照（2026-11-20 实测）

| 项 | 值 |
|---|---|
| 代码版本 | `234c746`（`docs: 同步配置化前台落地状态与实施记录`） |
| 工作区 | 干净，无未提交改动 |
| 容器 | caddy / api / admin / storefront / postgres 全部 Up，api `healthy` |
| 运行时长 | 主机 uptime 4 天；caddy/postgres 3 天；api 33 分钟 |
| 磁盘 | 22 GB / 100 GB（22%） |
| 内存 | 已用 939 MB / 3.9 GB，可用 2627 MB |
| `mrinhk.com` | 307（locale 重定向，正常） |
| `admin.mrinhk.com` | 307（登录重定向，正常） |
| `/api/v1/health/ready` | **200** |
| 数据库迁移 | 35 条已应用 |
| 主题发布 | 未发布（后台主题配置尚未走发布流程） |
| 线上支付 | **未接入**（仅 COD / 人工转账） |

### 5.1 待清理项

| 项 | 说明 | 影响 |
|---|---|---|
| `ezstart-pg-test` 容器 | 测试残留，已运行 3 天，占内存 | 低；确认无测试在跑后可 `docker rm -f` |
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

### 6.4 备份

```bash
docker exec ezstart-mrinhk-postgres-1 pg_dump -U <user> <db> | gzip > /home/ec2-user/backup-$(date +%F).sql.gz
```

需记录：备份文件名、大小、行数抽查结果、存放位置（**建议异机/异桶，当前为同机，属风险**）。

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

**2026-11-20 实测结果**（新镜像首次部署）：

| 检查项 | 结果 |
|---|---|
| 迁移 | 36 条全部应用（含新增 `202611200400_refund_event_types`） |
| `/health/live` | 200 `alive` |
| `/health/ready` | 200（迁移清单与库内记录逐条比对通过） |
| 配置校验 | `http://` 来源被拒启动，改 `https://` 后正常——生产 HTTPS 约束有效 |
| 店主初始化 | `POST /admin/auth/bootstrap` 202，`nextAction=enroll_mfa`；用户 1、owner 角色 1、引导令牌已消费 |
| 对账端点 | 无令牌 401、错令牌 401、正确令牌 200 并返回计数报告 |
| 生产隔离 | 同期 `mrinhk.com/api/v1/health/ready` 仍 200，5 个生产容器全部 Up |

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

主机 cron（每 15 分钟）：

```cron
*/15 * * * * cd /opt/ezstart-mrinhk/deploy/merchants/mrinhk && docker compose exec -T api node scripts/reconcile.mjs >> /var/log/ezstart-reconcile.log 2>&1
```

要点：

- 令牌从容器环境变量 `INTERNAL_JOB_TOKEN` 读，**不进命令行**（命令行会出现在 `ps` 与 history 里）。
- 未配置令牌时该端点整体 503，不会留下未受保护的运维入口。
- 脚本只打印计数，不打印订单号：日志长期留存，没必要把客户订单散进去。
- 有失败项也返回 0 并打印明细——对账"跑完了但有几笔要人看"不等于作业失败，否则 cron 天天报警会被忽略。

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
| D6 | 备份与数据同机 | 主机故障即同时丢失 | W4 |

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

---

> 本文为运维接入基线。任何新增环境、凭证位置变更、拓扑调整，必须同步更新本文件——**不允许只改服务器不改文档**。
