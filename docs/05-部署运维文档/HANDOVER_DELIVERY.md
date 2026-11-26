# In先生（mrinhk.com）商城系统 交付文档

> 交付日期：2026-11-27 ｜ 版本：生产镜像基于源码 `4fbd4f7` ｜ 密级：交付后请客户自行归档，本文档含初始凭据，交付完成并改密后建议删除本页凭据部分。

---

## 1. 交付清单

| 项 | 内容 |
|---|---|
| 商城前台（店铺） | https://mrinhk.com |
| 管理后台 | https://admin.mrinhk.com |
| 服务器 | AWS EC2（35.79.20.20，Amazon Linux），Docker Compose 部署 |
| 数据库 | PostgreSQL 15（Docker 容器，数据卷持久化） |
| 源码仓库 | git 仓库 main 分支，服务器 `/opt/ezstart-mrinhk` |
| 隔离测试环境 | 服务器 `/opt/ezstart-staging`（staging 隔离库，供上线前回归测试） |

## 2. 管理后台初始凭据（首次登录后自动作废）

```
后台地址：https://admin.mrinhk.com
账号：    admin
初始密码：e16n1pET0We8EWrTg1WY0x
```

**该账号为 Owner（店主）角色，即全站最高权限超级管理员。**

### ⚠️ 首次登录必读

1. 使用上述初始密码登录后，系统会**强制跳转到修改密码页面**——这是内置的安全交付模式。请立即设置您自己的新密码（建议 ≥12 位、含大小写/数字/符号），设置完成前无法使用后台任何功能。
2. 改密完成后，强烈建议在「安全设置」中**开启两步验证（TOTP）**。Owner 账号目前仅有单密码防线，开启后登录需要手机验证码，可防止密码泄露导致的后台失守。
3. 请勿将初始密码或您的长期密码通过聊天工具、邮件明文传输。

### 员工账号建议

请勿多人共用 Owner 账号。后台支持按角色分配权限（管理员 / 商品运营 / 订单客服 / 财务 等 8 个角色），给员工开对应低权限角色即可，由 Owner 在后台「成员管理」中邀请创建。

## 3. 系统当前状态（已全部验证）

| 项 | 状态 |
|---|---|
| 全量测试 | ✅ 119 个 API 用例 + 架构/交互/按钮用例全部线上实测通过，无遗留阻断项 |
| 缺陷修复 | ✅ 2 个缺陷已修复并发布生产：商品 CSV 导入上传 403（已复测 204）、取消导入任务 500（已复测 200） |
| 冒烟验证 | ✅ 前台 200、后台 200、核心 API 200 |
| 数据 | 生产数据完整，无测试数据残留 |

## 4. 运维要点

- **版本发布**：修改代码后推送 main，服务器 `git pull` 后执行 `docker compose -f deploy/merchants/mrinhk/docker-compose.yml build api && docker compose -f deploy/merchants/mrinhk/docker-compose.yml up -d api worker`（重启约 25 秒）。
- **回滚**：服务器保留回滚镜像 `ezstart-mrinhk-api:rollback-20261127`，异常时可秒级回退。
- **上线前测试**：所有高风险变更先在 `/opt/ezstart-staging` 隔离环境验证（详见《STAGING_ISOLATED_TESTING.md》），通过后再发布生产。
- **管理员账号找回**：若忘记密码或 MFA 丢失，按《ADMIN_RECOVERY_RUNBOOK.md》流程处理（需服务器 SSH 权限）。
- **备份**：数据库以 Docker 卷形式存在于本机，建议客户自行配置定期快照（如 AWS EBS 快照或 pg_dump 定时任务）。

## 5. 交付包含的文档

| 文档 | 位置 |
|---|---|
| 测试报告（含全部用例与实测结果） | `docs/04-测试文档/MRINHK_LIVE_TEST_SUITE.md` |
| 隔离测试环境说明 | `docs/05-部署运维文档/STAGING_ISOLATED_TESTING.md` |
| 管理员账号恢复手册 | `docs/05-部署运维文档/ADMIN_RECOVERY_RUNBOOK.md` |
| 部署与环境说明 | `docs/05-部署运维文档/AWS_ENVIRONMENTS.md`、`PRIVATE_DEPLOYMENT.md` |

---

*本文档由系统交付方生成。初始密码仅在第 2 节出现一次，客户完成首次改密后，请自行删除第 2 节并妥善保管自己的密码。*
