# 发布 M05 批量导入到 mrinhk 生产（分步清单）

> 目标：把本地 4 个提交（`6260df3` → `d935453`）发到 `mrinhk.com`，其中包含**第 39 条迁移** `202611231200_import_jobs`。
> 线上当前版本：`3e26844`（2026-11-21，38 条迁移）。
> 预计停机：重建 api/admin/storefront 期间约 30–60 秒（构建期间旧容器继续服务）。

## 0. 前提与前置条件（缺一条就不要开始）

| 项 | 要求 | 检查方式 |
|---|---|---|
| 代码已推远端 | 服务器只 `git pull --ff-only`，本地提交必须先在 `origin/main` 上 | 本地 `git push origin main` 后 `git log --oneline origin/main -1` |
| 备份可用 | 最近一份 dump 校验通过且时间在本次发布之前 | `tail -3 /opt/ezstart-backups/backup.log` |
| 发布窗口 | 非营业高峰；店主在线可配合 MFA 登录 | — |
| 店主凭据 | 知道临时密码（或已自行改过）并能提供 TOTP | 见 [ADMIN_RECOVERY_RUNBOOK.md](ADMIN_RECOVERY_RUNBOOK.md) |

本地先确认要发的内容：

```powershell
git log --oneline origin/main..HEAD     # 应为 4 条（CSRF / 导入后端 / 导入页 / 测试）
git status --short                       # 应为空
```

## 1. 备份（不可跳过）

```bash
sudo systemctl start ezstart-backup.service
sleep 3
tail -2 /opt/ezstart-backups/backup.log      # 必须看到 "backup ok: ... 95 table data entries"
ls -1t /opt/ezstart-backups/ezstart-*.dump | head -1
```

把这两行记进工单：文件名 + 表数。**校验失败的 dump 不算备份**——脚本会在日志里写明文失败原因。

## 2. 记录回滚点

```bash
cd /opt/ezstart-mrinhk
git rev-parse --short HEAD                    # 记下，例如 3e26844
docker images --format '{{.Repository}}:{{.Tag}}' | grep ezstart-mrinhk
```

`deploy.sh` 会自己把当前 `api/admin/storefront` 镜像打上 `:prev`，无需手工打标签。

## 3. 发布

```bash
cd /opt/ezstart-mrinhk/deploy/merchants/mrinhk
./deploy.sh
```

脚本顺序：备份库 → `git pull --ff-only` → 重建镜像 → 迁移容器 → 健康检查 → 公网冒烟。任一步失败它会打印日志并非 0 退出。

**重点看迁移那一段**：`migrate` 一次性容器必须退出码 0，且迁移总数为 **39**。

```bash
docker compose ps                                   # 全部 Up，api 为 healthy
docker exec ezstart-mrinhk-postgres-1 psql -U ezstart -d ezstart -tAc \
  'select count(*) from "_prisma_migrations" where finished_at is not null'   # 期望 39
docker exec ezstart-mrinhk-postgres-1 psql -U ezstart -d ezstart -tAc \
  'select to_regclass(''"ImportJob"'')'                                        # 期望 ImportJob
```

## 4. 冒烟（脚本能做的部分）

```bash
# 公网健康
curl -s -o /dev/null -w 'ready=%{http_code}\n' https://mrinhk.com/api/v1/health/ready
curl -s -o /dev/null -w 'site=%{http_code}\n'  https://mrinhk.com/zh-HK
curl -s -o /dev/null -w 'admin=%{http_code}\n' https://admin.mrinhk.com/admin/login
curl -s -o /dev/null -w 'importpage=%{http_code}\n' https://admin.mrinhk.com/admin/catalog/import

# 权限边界：导入端点不带会话必须 401（契约里没有「列任务」的 GET，裸 GET 是 404，别当失败）
SHA=$(printf 'a%.0s' $(seq 1 64))
curl -s -o /dev/null -w 'create=%{http_code}\n' -X POST https://admin.mrinhk.com/api/v1/admin/import-jobs \
  -H 'Origin: https://admin.mrinhk.com' -H 'content-type: application/json' \
  -d "{\"fileObjectKey\":\"imports/2026/11/00000000-0000-0000-0000-000000000000.csv\",\"fileSha256\":\"$SHA\",\"format\":\"csv\",\"mode\":\"create_or_update_by_sku\",\"commitMode\":\"valid_rows\",\"columnMapping\":{\"product_key\":\"product_key\"},\"localeSet\":[\"zh-HK\"]}"
curl -s -o /dev/null -w 'getjob=%{http_code}\n' https://admin.mrinhk.com/api/v1/admin/import-jobs/00000000-0000-0000-0000-000000000000
curl -s -o /dev/null -w 'files=%{http_code}\n' -X POST https://admin.mrinhk.com/api/v1/admin/import-files \
  -H 'Origin: https://admin.mrinhk.com' -H 'content-type: application/json' -d '{}'

# 来源校验：缺 Origin 与伪造 Origin 都必须 403
curl -s -o /dev/null -w 'no-origin=%{http_code}\n' -X POST https://admin.mrinhk.com/api/v1/admin/import-files \
  -H 'content-type: application/json' -d '{}'
curl -s -o /dev/null -w 'bad-origin=%{http_code}\n' -X POST https://admin.mrinhk.com/api/v1/admin/import-files \
  -H 'Origin: https://evil.example.test' -H 'content-type: application/json' -d '{}'

# 登录仍需 TOTP：正确密码应 202（不要在这里试错密码，会触发限流）
curl -s -o /dev/null -w 'login=%{http_code}\n' -X POST https://admin.mrinhk.com/api/v1/admin/auth/login \
  -H 'Origin: https://admin.mrinhk.com' -H 'content-type: application/json' \
  -d '{"email":"admin","password":"<店主密码>"}'
```

期望：`200 / 200 / 200 / 200`，`create=getjob=files=401`，`no-origin=bad-origin=403`，`login=202`。

## 5. 真实验收（必须由店主在后台完成）

自动化冒烟无法验证导入本身——执行导入要过登录 + TOTP。请店主在 `https://admin.mrinhk.com/admin/catalog/import` 上传
[products-import-template.csv](../01-产品文档/templates/products-import-template.csv)，依次点「上传并创建任务 → 开始预检 → 确认执行」，然后核对：

- [ ] 预检显示 `总行数 3 / 有效 3 / 拒绝 0`，动作均为「新建」
- [ ] 执行后提示 `新建 2、更新 0、跳过 0、失败 0`（3 行合并为 **2 个商品 / 3 个规格**；`createdCount` 记的是商品数，不是行数）
- [ ] `/admin/catalog` 能看到「檜木香薰蠟燭」与「砥部燒茶杯」，前者为**已上架**（模板 `publish_now=Y`），后者草稿
- [ ] 前台 `/zh-HK/products` 出现已上架商品（缓存约 30 秒）
- [ ] 再点一次「开始预检」对同一文件：全部变「跳过」（SKU 已存在），执行后商品数不变

任一不符即视为发布失败，按第 6 节回滚。

## 6. 回滚

```bash
cd /opt/ezstart-mrinhk/deploy/merchants/mrinhk
./deploy.sh --rollback
```

- 回滚的是**镜像**（`:prev`），不是数据库；Prisma 迁移只前进。
- 第 39 条迁移**不需要撤销**：旧代码不读 `ImportJob` 表，多一张空表无害，避免手工 DROP 带来的风险。
- 只有数据被写坏时才走数据库恢复，且必须恢复到**新库**再切换，不要在线上库上 `pg_restore`：

```bash
# 示例：把备份恢复到 staging 的独立库，核对后再决定
docker exec ezstart-staging-postgres-1 psql -U ezstart -d postgres \
  -c 'drop database if exists restore_drill' -c 'create database restore_drill'
docker cp /opt/ezstart-backups/ezstart-2026-11-23-1342.dump ezstart-staging-postgres-1:/tmp/d.dump
docker exec ezstart-staging-postgres-1 pg_restore -U ezstart -d restore_drill --no-owner --no-privileges /tmp/d.dump
```

## 7. 收尾记录

- [ ] `AWS_ENVIRONMENTS.md` 第 10 节变更记录补一行（日期、提交号、迁移总数）
- [ ] `IMPLEMENTATION_PROGRESS.md` 的 M05 段补"已部署 + 冒烟结果"
- [ ] 工单记录：备份文件名、回滚点 commit、冒烟五项返回码、店主验收结论

### 7.1 2026-11-23 22:42 首次执行记录

| 项 | 实际值 |
|---|---|
| 发布前版本 | `3e26844`（38 条迁移） |
| 发布后版本 | `e2bc225`（**39 条迁移**） |
| 部署前备份 | `/opt/ezstart-backups/ezstart-2026-11-23-1439.dump`（357,253 B / 95 张表，`pg_restore -l` 通过） |
| deploy.sh 自备份 | `/opt/ezstart-backups/ezstart-20261123-143912.sql.gz` |
| 构建 | api / admin / storefront 三个镜像重建，约 3 分钟 |
| migrate 容器 | `Exited` 0，迁移 39 条 |
| 停机窗口 | admin/storefront/api 重建期间约 30 秒 |
| 冒烟 | `ready=200 / site=200 / products=200 / adminlogin=200 / importpage=200`；`create=getjob=files=401`；`no-origin=bad-origin=403`；`login=202` |
| API 错误日志 | 0 条 |
| 新表 | `ImportJob`：24 列 / 30 个约束 |
| 回滚点 | 三镜像 `:prev` 已打（迁移不撤销，多一张空表无害） |

## 8. 这批**不能**宣称的事

| 项 | 事实 |
|---|---|
| xlsx 导入 | 未实现，`format=xlsx` 返回 422 `IMPORT_FORMAT_UNSUPPORTED` |
| 库存与图片导入 | 未实现，只给 `STOCK_NOT_IMPORTED` / `IMAGE_URL_NOT_IMPORTED` 警告 |
| HTTP 回归是否在真库跑过 | 本地沙箱起不了 PostgreSQL，`tests/import-http.test.ts` 在 CI 或本机才能执行；发布前应先让 `pnpm check` 绿 |
| 异机备份 | 仍缺桶与凭据（见 AWS_ENVIRONMENTS 6.4） |
| 真实客户商品清单 | 需客户回传合规表与 CSV；模板验收只证明机制可用，不代表品类合规 |
