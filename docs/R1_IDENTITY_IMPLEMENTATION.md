# R1 数据库与管理员身份实现

日期：2026-10-19；2026-11-16 补充员工邀请后端。R1 整体仍未完成。

邀请创建、摘要、重发、撤销与接受接口、持久模型和加密通知待投递记录已实现，详见 [完整上线实施记录](IMPLEMENTATION_PROGRESS.md)。SMTP Worker 与身份页面已补齐程序，真实 SMTP/HTTPS 全链路仍待验收，员工和角色管理 API/页面、密码重设 API/Worker/页面、默认岗位权限包已补齐；下文表数与未实现清单保留为 2026-10-19 历史基线。

## 已运行验证的接口

| 接口 | 实际行为 |
|---|---|
| POST `/admin/auth/bootstrap` | 单次部署凭据、首次开通窗口与数据库锁控制首店主创建；只返回 MFA 登记能力 |
| POST `/admin/auth/login` | Argon2id 校验；强制 MFA 未登记走登记，已登记走验证；密码本身不能取得店主会话 |
| POST `/admin/auth/mfa/enrollments` | 受限 setup cookie，创建加密待登记因子；重开使旧 enrollmentId 失效 |
| POST `/admin/auth/mfa/enrollments/confirm` | TOTP 确认后原子激活、消费挑战、生成恢复码、撤销旧会话并签发新会话 |
| POST `/admin/auth/mfa/verify` | TOTP 时间步和恢复码均单次使用；并发请求跨 API 实例只允许一次成功 |
| POST `/admin/auth/mfa/enrollment-authorizations` | 正式会话、精确 Origin、CSRF、当前密码及已存在的 MFA 再验证，授权本人重新绑定 |
| GET `/admin/auth/session` | 从数据库重读员工状态、角色权限、因子与会话到期；空闲截止滑动但不超过绝对截止 |
| GET `/admin/auth/sessions` | 本人有效会话分页；不返回原始会话凭据 |
| POST `/admin/auth/sessions/:id/revoke` | 校验本人归属、CSRF 和 Origin，撤销后下一请求立即无效；他人 ID 统一 404 |
| POST `/admin/auth/logout` | CSRF 与 Origin 校验，数据库撤销并清除同路径 cookie |

均挂在 `/api/v1` 下。写请求按 OpenAPI 请求 DTO 在运行时校验并拒绝未知字段；响应经真实测试按契约校验。无数据库配置时身份接口返回 503，未知路由仍返回 404。

## 数据与安全实现

- Prisma 7.10.1 + PostgreSQL 18；10 张身份表及标准 Prisma 迁移历史。迁移含首店主角色唯一索引、状态/版本/截止约束和审计 UPDATE/DELETE 拒绝触发器。
- 用户、MFA/恢复码/会话操作在数据库事务内取得该用户的 advisory lock；bootstrap 使用独立锁。跨进程共享数据库时同样生效，不依赖单进程内存锁。
- 密码 Argon2id 使用 64 MiB、3 次、单并行度；TOTP 使用标准 6 位/30 秒、允许前后各一步时钟偏差，并记录最后消费时间步。恢复码每组 10 个、每个 20 字符，只存摘要。
- TOTP secret 使用 AES-256-GCM 加密，认证数据绑定实例 ID、员工 ID 和用途；会话/挑战仅保存随机凭据摘要。CSRF token 通过实例密钥和当前会话凭据派生。
- MFA 失败先提交挑战计数和拒绝审计，再返回错误；不会因抛错回滚失败计数。账号冷却与 IP 请求计数持久化；目前身份写请求同 IP 每 15 分钟上限 60 次，未信任任意转发头。
- 所有应用数据库连接强制 `timezone=UTC`，不允许连接 URL 的 options 参数覆盖。真实测试发现 adapter-pg 会将非 UTC timestamptz 文本按 UTC 解码；该约束避免 8 小时偏差导致验证码、到期和流水时间错误。测试数据库故意以 Asia/Shanghai 为默认时区覆盖回归。
- 启动检查 PostgreSQL 主版本和已完成迁移的文件校验和；未完成/不匹配迁移拒绝启动。就绪检查核对迁移状态，不把进程存活视为依赖就绪。配置或数据库启动错误仅记录稳定错误码，不输出原始连接详情。

本轮的审计触发器保护应用层普通 SQL 更新/删除，不能替代独立运维权限、审计备份和批准的保留处置机制。数据库运行账号与迁移账号的权限分离仍须随部署交付。

## 安装、迁移与运行

1. 按 [工程说明](R1_ENGINEERING_PROGRESS.md) 安装精确锁定依赖及 Python 校验工具。
2. 为此项目准备独立的 PostgreSQL 18 空库。将连接信息写入根目录私有 `.env` 的 DATABASE_URL；不要在命令行参数或代码提交中放生产凭据。
3. `.env` 还须设置 APP_ORIGIN（精确、不带尾部路径）、INSTANCE_ID（UUID）、IDENTITY_ENCRYPTION_KEY（32 随机字节的标准 base64）。首次开通另配置 BOOTSTRAP_TOKEN（32 随机字节的 base64url）。这些值按实例生成并在秘密管理系统保管，不使用示例固定值。
4. `pnpm db:migrate` 从 `.env`/当前环境读取目标连接并应用版本化迁移；`pnpm dev:api` 生成客户端、编译并运行 API。
5. 浏览器操作需 HTTPS 入口代理到本机 API，并让 APP_ORIGIN 与前台来源一致；cookie 始终为 Secure。开发模式只允许显式 localhost/127.0.0.1 的 HTTP Origin，测试直接携带 cookie 以验证服务器行为，没有降低正式 cookie 属性。

首次启动在数据库持久记录 15 分钟 bootstrap 窗口；重启不延长。创建过店主后 bootstrap 保持关闭；完成交接后移除环境中的 BOOTSTRAP_TOKEN。已有因子和会话绑定实例/加密密钥，不能任意换 INSTANCE_ID 或密钥而期望历史身份继续有效，轮换需要另行迁移方案。

## 真实测试证据与边界

`pnpm check` 包含契约、生成漂移、Prisma schema 验证、编译以及全部 Node 测试。数据库测试自动启动只监听 127.0.0.1 的临时 PostgreSQL 18.4，应用标准迁移，并启动两套 API 共享该数据库验证并发。测试结束显式关闭 API/连接池/数据库，检查过的项目内临时目录随后删除；不会创建系统用户或连接现有数据库。Linux 测试须以非 root 用户运行。

已覆盖：迁移历史/UTC、Origin/额外字段、并发 bootstrap、待因子加密与旧登记失效、并发确认、CSRF、员工停用、TOTP 重放、跨实例恢复码竞态、有效 TOTP 登录与持久会话过期、因子替换/旧会话失效、本人会话越权、跨实例账号冷却、审计秘密检查及追加约束。

未实现：员工邀请及重发/撤销的 HTTP/通知联调、员工/角色管理、密码重设、市场审核与店铺配置的持久实现、过期清理 Worker、离线恢复工具、后台 UI、私有实例部署及备份/恢复演练。没有生产部署；本地通过不代表远端 CI 已运行或 R1 可签收。
