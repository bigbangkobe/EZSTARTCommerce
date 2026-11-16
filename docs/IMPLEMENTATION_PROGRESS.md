# 完整上线实施记录

日期：2026-11-16。

## 交付目标

完整实现既有 M00–M16 规格，交付可上线的通用电商核心、商家后台和三语参考前台，支持客户专属前台定制与独立部署。开发批次仅用于管理依赖，不缩减最终功能。不得把身份 API、交易演示、文档齐全或构建通过表述为产品上线完成。

## 开发顺序与完成证据

| 批次 | 必须完成的程序 | 验收证据 |
|---|---|---|
| 基础与管理 | M00 员工邀请/角色/找回/审计、M01 店铺配置/市场审核、M15 实例基础 | 权限和并发 API 测试、两套隔离实例 |
| 商品与内容 | M03 目录/媒体/三语、M04 内容/陈列/SEO、M05 导入导出 | 后台实操、导入失败恢复、预览发布、权限测试 |
| 交易与履约 | M06 购物/结账、M07 订单、M08 支付、M09 配送、M12 库存、M13 交易通知 | 并发不超卖、金额一致、回调幂等、异常恢复 |
| 完整运营 | M10 会员/积分/隐私、M11 优惠、M14 报表、M16 售后、M08 对账 | 退款/积分/库存/账本核对、营销同意及隐私验收 |
| 前后台交付 | 完整后台、M02 三语响应式参考前台、客户独立前台接入 | 浏览器 E2E、移动端/三语、页面所有状态与 API 联调 |
| 上线与复制 | Docker/Compose、TLS、密钥、监控、备份恢复、升级回滚、客户交接 | 空环境部署、恢复与回滚演练、第二实例隔离、生产清单签收 |

每批交付均包含数据库迁移、运行时输入验证、OpenAPI、权限、审计、错误处理和相应测试。仅创建接口定义不能视为实现。

## 当前实际状态

- 本地 Git 仓库已初始化，main 分支；未创建提交或远程仓库。
- 2026-11-16 开始实施前，pnpm check 通过：21 项 Python 契约测试、28 项 Node 测试。
- 本批修正：数据库就绪检查从固定一条身份迁移，改为校验全部已随代码交付的迁移名称与 SQL SHA-256；缺失、失败、重复、未知或被修改的迁移均拒绝就绪。已回滚的尝试不视为已应用，可在成功重试后就绪。
- 新增迁移匹配单元测试与真实 PostgreSQL HTTP 就绪回归。
- 未完成：其余身份功能、店铺和全部电商业务、前后台页面、Worker、生产部署与恢复验收。项目仍不可上线。

## 下一项实现

推进店铺配置与商品模块（M01/M04）。真实 SMTP 及 HTTPS 链路（含邀请与密码重设邮件）仍须在实例参数齐备后独立验收。

## 客户生产参数

市场/商品资格、支付和通知服务商、生产账户、域名、配送/售后政策、三语内容、备份与运维责任按 CLIENT_LAUNCH_INPUTS.md 配置。缺失参数不阻断独立的核心开发，但对应生产功能不能伪装为已验证。


## 2026-11-16：员工邀请后端

本批已实现：

- AdminInvitation 与 IdentityNotificationJob 模型及独立迁移；邀请和加密通知任务在同一事务提交。
- POST /api/v1/admin/users：创建邀请，服务端分配角色、强制 MFA，仅返回员工摘要及 ETag。
- GET /api/v1/admin/users/:id/invitation：staff.read、邀请摘要/ETag、动态过期状态。
- POST /api/v1/admin/users/:id/invitation/resend：staff.manage、CSRF、Origin、If-Match、Idempotency-Key；限频、凭据轮换、旧任务清密与幂等结果。
- POST /api/v1/admin/users/:id/invitation/revoke：staff.manage、CSRF、Origin、If-Match；撤销并清除通知密文。
- POST /api/v1/admin/auth/invitations/accept：单次消费、设置 Argon2id 密码、激活身份、签发 MFA 登记挑战。
- 接受时复核邀请者有效性/权限及员工状态/角色；禁止分配 owner 或超出邀请者权限的角色。
- 通知凭据 AES-GCM 加密，绑定实例/员工/用途/任务/版本；接受、撤销或旋转后清除旧任务密文。

验证：pnpm check 通过，21 项契约测试、33 项 Node 测试。真实 PostgreSQL HTTP 回归覆盖重复邮箱、CSRF、角色越权、受限会话越权、重发冷却、幂等重试/冲突、旧凭据失效、邀请者停用/撤权、目标停用、过期、并发接受、撤销、审计无凭据。

边界：通知目前只是加密待投递记录，尚无邮件 Worker、服务商或接受页面；不能宣称邀请邮件已发送、完整员工管理已完成或产品已可上线。新实例测试自动应用两条迁移；已有实例更新前须备份、演练并运行 pnpm db:migrate。

## 2026-11-16：邀请邮件 Worker 与身份页面

本批程序：

- 独立 apps/worker 进程和 SMTP 适配器，TLS/STARTTLS、证书校验、连接/握手/套接字超时，三语邀请邮件。
- 第三条数据库迁移新增任务尝试次数、可重试时间、租约/到期、稳定错误码和发送时间；原子 SKIP LOCKED 领取、120 秒租约、指数退避、五次失败终止、崩溃后恢复。
- 每次发送前复核员工、邀请者、权限、版本与期限；过期/失效取消并清密；发送中撤销不会恢复任务。过期 MFA 待登记密钥同步清理。
- apps/admin 为 Next.js 16 + React 管理端，新增 /admin/accept-invitation 与 /admin/login：密码设置/登录、MFA 登记/验证、恢复码一次性显示与隐藏、失效错误及重新登录恢复。
- 邀请凭据只放 URL 片段，页面读入内存后移除；页面无浏览器持久存储、no-store/noindex/no-referrer、nonce CSP。前后端通过同源 /api/v1 接入。
- 新增 pnpm dev:worker、pnpm dev:admin、pnpm build:admin、pnpm browser:install、pnpm test:browser；Git 忽略 Next.js 与浏览器产物。
- CI 文件新增前端生产构建和 Chromium 页面测试；仅本地执行有结果，尚未在远端运行。

本地验证：

- pnpm check 通过：21 项 Python 契约测试、40 项 Node 测试，含真实 PostgreSQL Worker 并发、退避、五次失败、租约恢复、过期/撤销/权限失效及清密；管理端类型检查通过。
- pnpm build:admin 生产构建通过。
- PLAYWRIGHT_CHANNEL=msedge 下 pnpm test:browser 通过 4 项桌面/手机测试：接受邀请到 MFA/恢复码、片段清除、无浏览器持久存储、安全头、失效提示和重新登录。预览截图已人工检查，无水平溢出。

边界：Worker 已具备 SMTP 投递程序，但未提供或连接真实 SMTP 账户；没有发送真实邮件。浏览器测试使用受控 API 响应，数据库集成测试独立运行，不能表述为真实邮箱 + HTTPS + 浏览器 + 数据库全链路验收。SMTP 至少一次交付，崩溃窗口可能重复邮件；稳定 Message-ID 不保证服务商去重。页面当前为中文，完整三语后台、员工/角色操作页、密码重设和电商模块仍未实现；项目仍不可上线。

运行与边界说明见 apps/worker/README.md。

## 2026-11-16：员工与角色管理

已实现的 API（均位于 /api/v1）：

- GET /admin/users 与 GET /admin/users/:id：staff.read、游标分页、员工摘要与详情。
- PATCH /admin/users/:id：staff.manage、Origin、CSRF、If-Match；姓名、角色分配、停用/已激活账号恢复；邀请中账号不得直接激活。
- GET /admin/users/:id/sessions：staff.read、限定目标员工的活跃会话分页，无会话凭据。
- POST /admin/users/:id/sessions/revoke：staff.manage、Origin、CSRF、原因、撤销全部会话并消费未完成挑战。
- GET/POST /admin/roles、GET/PATCH /admin/roles/:id：roles.manage；元数据、权限集合、分页、ETag、版本冲突、重复名称检查。
- 第四条迁移补齐角色说明、创建/更新时间，与现有角色响应契约一致。

授权与一致性：

- 新角色和修改后的角色只能包含调用者当前拥有且 OpenAPI 已登记的权限；禁止管理超出自身授权范围的员工或角色。
- 系统 owner 角色不可修改；现有店主绑定不可从普通员工 API 移除，店主不能被此接口停用；店主转让不通过角色编辑实现。
- 员工/角色管理、邀请管理与接受邀请先获取数据库共享授权锁，再按人员锁顺序处理；跨 API 实例的授权变更被串行化，防止授权检查后并发授予越权权限。
- 员工编辑及角色修改会递增受影响员工版本，撤销旧会话，消费挑战、清除待登记密钥，使目标员工或其发出的待接受邀请旧凭据失效。
- 待邀请保持可重新审批的 pending 状态但无可用旧 token；管理员须取得新邀请版本并使用新幂等键显式重发。通知旧任务取消清密。
- 所有管理写入与审计在同一事务提交；权限清空对非店主合法，不因无角色而获得额外权限。

页面：/admin/access 接入会话权限、员工分页、角色创建/编辑、员工邀请、姓名/角色编辑、停用、全部会话撤销及二次确认；只读角色不显示写控件。登录/MFA 成功后提供管理入口。修复了加载更多后被刷新回第一页的问题。

验证：pnpm check 包含 21 项契约测试、41 项 Node 测试及管理端类型检查。pnpm build:admin 生产构建通过；本地 Edge 的 pnpm test:browser 通过 10 项桌面/手机用例（含既有身份入口）。真实数据库用例覆盖授权范围、未知权限、CSRF、重复角色名、并发版本冲突、店主保护、邀请不可直接激活、邀请失效、停用/角色变更/全部会话撤销即时生效、分页及响应契约。手机预览已检查。

边界：页面仍为中文。staff.manage 可直接调用邀请 API，但当前可视化邀请表单还要求 roles.manage 读取角色选项。默认岗位权限包、密码重设和身份审计读取界面已在后续批次补齐，其余电商模块仍待实现；没有生产部署或真实 SMTP/HTTPS 全链路验收，项目仍不可上线。

## 2026-11-16：密码重设

本批程序：

- 第五条迁移新增 AdminPasswordReset（每员工一条、版本、状态、token 摘要、30 分钟截止、通知任务）与通知队列泛化：IdentityNotificationJob 增加 kind、targetVersion、passwordResetId，invitationId 改为可空，并用 CHECK 约束强制“每任务只对应一种目标”。原 invitationVersion 列更名为 targetVersion。
- POST /api/v1/admin/auth/password-reset 同时承载申请（email）与完成（resetToken + newPassword），两者均返回 202 `{requestAccepted:true}`；申请对未知、停用、冷却中和超限邮箱不做区分，也不写凭据或审计；完成返回 401 表示凭据无效。
- 领域层新增 issuePasswordReset / rotatePasswordReset / completePasswordReset 纯函数：摘要比对、精确截止、一次性状态机；重复申请原子轮换摘要、版本和截止，旧链接立即失效。
- 完成重设：撤销该员工全部会话与未完成挑战、清除待 MFA 登记密钥、递增员工版本；保留 TOTP 因子、恢复码和 MFA 要求，不建立登录会话。
- 员工停用、角色/权限变更与全部会话撤销通过既有 invalidateAuthority 同时作废待用重设凭据并取消其通知任务。
- Worker 改为 NotificationWorker：按 job.kind 复核邀请或重设的目标状态、版本、摘要与截止，再投递三语邮件；重设链接为 /admin/reset-password#凭据，片段不进入 HTTP 访问日志；每轮额外把过期未用重设标记为 revoked。
- apps/admin 新增 /admin/reset-password（申请/设置两态，凭据只读入内存后清除），登录页提供入口。

验证：pnpm check 通过，21 项 Python 契约测试、21 项顶层 Node 测试（含真实 PostgreSQL 的身份 HTTP 与 Worker 回归）、管理端类型检查通过。密码重设用例覆盖：未知邮箱不建凭据、冷却不重复发信、凭据不可跨用户解密、字段混用与弱密码 422、一次性消费、完成后旧会话与旧密码失效、MFA 因子保留且重登返回 MFA 挑战、停用后凭据作废、审计不含凭据与密码。Worker 用例覆盖：kind/target CHECK 拒绝错配任务、重设只投递一次、过期/轮换/已完成/停用任务不发送、摘要不符不发送。pnpm build:admin 生产构建通过；本地 Edge 的 pnpm test:browser 通过 16 项桌面/手机用例，其中 3 项为重设页面（统一接受响应、片段清除与凭据不落浏览器存储、失效提示不泄露内部信息），预览截图已人工检查。

边界：仍未连接真实 SMTP，也没有 HTTPS 与浏览器全链路验收；页面仍为中文；身份审计读取界面已在后续批次补齐，全部电商模块仍待实现，项目仍不可上线。已有实例升级前须备份、演练并运行 pnpm db:migrate。

## 2026-11-16：默认岗位权限包

本批程序：

- packages/config 新增 role-presets.ts 作为开发规格 7.1 权限矩阵在代码中的唯一投影，定义店主、管理员、商品运营、订单客服、财务、仓库、报表只读、隐私专员 8 个预设。owner 始终等于契约里的全部权限码，其余预设按岗位只给最小集：管理员不含员工/角色、付款配置、退款、隐私与实例级操作；商品运营不含订单与顾客资料；财务不含商品/库存写入；仓库不含退款与付款读取；报表只读只有 reports.view；隐私专员处理与审批分权。
- 预设权限码以 OpenAPI 的 x-permission 为闭集：任一预设引用契约里不存在的权限码（拼写错误或权限码改名），服务启动直接失败，不会静默少授权或错授权。
- 第六条迁移为 AdminRole 增加 presetKey（唯一、可空）并回填既有 owner 角色；自定义角色为 null。
- 服务启动幂等补齐缺失的预设角色，已存在的预设不覆盖——店主收窄过的默认授权不会被重启还原；owner 角色不可编辑，因此按契约单向补齐权限码，新增模块上线后店主不会失去新入口。
- 首次店主初始化改为复用 owner 预设（而非临时创建 'Owner' 角色），保证预设与实例初始化使用同一份定义。
- GET/POST/PATCH /admin/roles 响应新增 kind 与 presetKey（契约同步，kind 取 owner/admin/preset/custom）。管理员预设沿用 kind=admin，从而在既有登录逻辑里保持强制 MFA。
- /admin/access 改为按 kind 判断店主角色（原先按角色名 'Owner' 硬编码），预设角色显示“默认岗位包”徽标，创建角色可选择预设为模板自动勾选权限后再按需调整。

验证：pnpm check 通过（24 项顶层 Node 测试：3 项预设单元测试 + 真实 PostgreSQL 身份 HTTP 回归含预设用例、21 项 Python 契约测试）、管理端类型检查与生产构建通过、本地 Edge 的 pnpm test:browser 17 项桌面/手机用例通过（access 用例覆盖预设徽标与模板勾选）。预设用例覆盖：8 个预设齐全且互不重名、owner 等于契约全量、受限岗位不含越权码、预设引用未知权限码启动失败、重复初始化不重复建角色且不覆盖店主调整、被收窄的预设重启不回弹、owner 权限码自动补齐、低权限角色管理者不能改写更高权限的角色。

边界：预设只是初始授权，不是不可变策略，拥有 roles.manage 的角色管理者仍可增删（限于自己拥有的权限）；角色删除能力仍未提供；全部电商模块仍待实现，项目仍不可上线。升级已有实例须备份、演练并运行 pnpm db:migrate（本次为第 6 条迁移）。

## 2026-11-16：身份审计读取

本批程序：

- 契约补齐：/admin/audit-logs 原先只指向通用 Success，现在新增 AdminAuditLog 与 AdminAuditLogListEnvelope 并具名响应 AdminAuditLogListSuccess（Cache-Control: no-store），响应结构受契约校验约束，额外字段会被拒绝。
- GET /api/v1/admin/audit-logs 按 audit.read 授权，游标分页由 occurredAt DESC, id DESC 排序；不存在的游标与超限 limit 返回 422。该资源只有 GET：没有写入、修改或删除路由，应用层无法改写审计。
- 返回字段仅有 id、actorId、action、objectId、result、requestId、reason、occurredAt；不返回请求体、凭据摘要或任何密码类数据。
- apps/admin 新增 /admin/audit：列表、加载更多、刷新、无权限与空态提示，页面无任何编辑/删除控件；/admin/access 在拥有 audit.read 时显示入口。
- 审计角色仍只由 owner 全量权限包覆盖，未新增“审计员”预设——读取审计属于受限角色职责，需由店主按任务显式授权。

验证：pnpm check 通过（24 项顶层 Node 测试，其中身份 HTTP 回归新增审计用例：401/403/200 分页、非法游标 422、PATCH 与 DELETE 返回 404、写入后原记录不变、历史记录不含任何测试密码串）、21 项 Python 契约测试、管理端类型检查与生产构建通过（新增 /admin/audit 路由）；本地 Edge 的 pnpm test:browser 20 项桌面/手机用例通过（新增审计页 2 项：分页只读与无权限提示），截图人工检查无溢出。

边界：审计只做读取，没有导出与保留期处置；审计页仍为中文；店铺配置与商品模块仍未实现，项目仍不可上线。
