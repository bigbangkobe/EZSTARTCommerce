# 身份通知 Worker

## 运行

在根目录配置私有 .env 中的 DATABASE_URL、APP_ORIGIN、INSTANCE_ID、IDENTITY_ENCRYPTION_KEY，以及 SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_FROM。
APP_ORIGIN 是浏览器访问的同源 HTTPS 地址；邀请链接使用此地址的 /admin/accept-invitation#凭据，密码重设链接使用 /admin/reset-password#凭据。SMTP_FROM 仅接受单个邮箱地址。465 使用隐式 TLS，其他端口必须支持 STARTTLS；校验服务器证书，不能关闭 TLS。

先执行 pnpm db:migrate，再分别启动 pnpm dev:api、pnpm dev:worker、pnpm dev:admin。
生产前端构建：pnpm build:admin；启动：pnpm --filter @ezstart/admin start。
Next.js 的 API_INTERNAL_ORIGIN 是仅服务器使用的 API 地址，默认 http://127.0.0.1:3001；浏览器只调用当前站点的 /api/v1，不能把数据库或 SMTP 凭证放入 NEXT_PUBLIC 环境变量。
入口代理必须以 HTTPS 提供前端和 API，并保持浏览器 Origin，使其与 APP_ORIGIN 完全一致。开发 HTTP 页面不能代替真实 Secure Cookie/HTTPS 验收。

## 投递行为

- 独立进程轮询 PostgreSQL；单次原子 SKIP LOCKED 领取、120 秒租约、每次领取累加尝试次数。
- SMTP 连接/握手/套接字超时分别为 10/10/20 秒；失败按 30、60、120、240 秒退避，第五次失败进入 failed 并清除密文。
- 崩溃后租约到期可重新领取；最终尝试后崩溃的任务终止，不永久停留 processing。
- 每次发送前复核目标状态与版本：邀请复核邀请版本、目标员工、邀请者权限与截止；密码重设复核重设版本、目标员工状态与截止。过期、撤销、旋转和消费均使旧凭据不可使用。
- 同一队列按 kind 区分邀请与密码重设，数据库 CHECK 约束保证每个任务只对应一种目标；密文用途绑定任务 ID 与目标版本，不能跨任务或跨用户解密。
- SMTP 是至少一次投递：服务商收信后进程崩溃可能导致重复邮件；使用稳定 Message-ID，但不能宣称邮件服务保证去重。邀请消费仍是单次事务。
- 已经交给 SMTP 的邮件不能撤回；发送期间撤销的任务不会被更新回 sent，其链接也不能激活员工。
- 每轮清理过期任务密文、过期未用重设凭据（标记 revoked）及过期 MFA 待登记密钥。failed 无重试接口；需由有权限的管理员显式重发邀请或重新申请重设以重新授权。
- 普通日志仅记录稳定事件/错误码，不打印收件人、邮件内容、凭据或 SMTP 错误原文。

## 页面与验证边界

新增 Next.js 16 管理端身份入口：接受邀请、密码登录、MFA 登记/验证、一次性恢复码显示与手动隐藏、密码重设申请与完成。凭据不进入 localStorage/sessionStorage；邀请与重设片段读入内存后清除；页面 no-store/noindex/no-referrer，脚本 CSP 使用 nonce，不接入第三方统计。
当前页面为中文，完整三语后台和业务导航仍待开发。页面刷新或挑战失效后使用密码重新登录；恢复码响应丢失后按既有重新绑定流程处理，不能再次查询明文。

pnpm check 运行真实 PostgreSQL 的身份/Worker 回归与前端类型检查。
pnpm build:admin 执行生产构建。
pnpm browser:install 后运行 pnpm test:browser，执行桌面和移动端浏览器流程；本机已有 Edge 时可在 PowerShell 设置 $env:PLAYWRIGHT_CHANNEL='msedge' 后运行，以免下载 Chromium；当前浏览器用例使用受控 API 响应，不能替代真实邮箱、HTTPS、数据库与浏览器全链路验收。

SMTP 配置依据：https://nodemailer.com/smtp 。Next.js 框架依据：https://nextjs.org/docs/app/getting-started/installation 。精确版本见 pnpm-lock.yaml。
