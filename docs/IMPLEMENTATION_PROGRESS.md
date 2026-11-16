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

推进支付与收款（M08）：付款渠道配置（密钥只写入安全存储、GET 只回脱敏状态）、Webhook 原始 body 验签与事件去重、COD 收款登记。前台展示目前只有只读目录接口，三语参考前台（M02 前台部分）与页面内容（M04）尚未开始。真实 SMTP 及 HTTPS 链路（含邀请与密码重设邮件）仍须在实例参数齐备后独立验收。

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

边界：仍未连接真实 SMTP，也没有 HTTPS 与浏览器全链路验收；页面仍为中文；身份审计读取界面与店铺设置已在后续批次补齐，商品及交易链路仍待实现，项目仍不可上线。已有实例升级前须备份、演练并运行 pnpm db:migrate。

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

## 2026-11-16：店铺设置与市场交易门禁（M01）

本批程序：

- 第七条迁移新增 StoreConfig（单实例单店铺，`id=1` 由 CHECK 约束锁定）、MarketProfile 与 MarketReviewRecord。数据库层同时约束：默认语言必须属于启用语言、启用市场必须处于 approved、审核通过必须带未来或空有效期；审核记录为追加历史，不提供改写路径。
- `packages/domain/src/store.ts` 承载纯规则：三语闭集、ISO 4217 三位币种、真实 IANA 时区（`Intl` 校验而非字符串形状）、功能开关闭集、市场代码规范化与审核状态机。
- 过期在读取时即时计算：审核有效期已过的市场返回 `reviewStatus=expired` 且 `enabled=false`，不等待清理任务；再次启用返回 422。
- GET /api/v1/admin/store-config：`store.settings.manage` 授权，返回语言/默认语言/本位币/时区/功能开关/品牌媒体 ID/市场列表/版本，ETag 为配置版本，Cache-Control: no-store。
- PATCH /api/v1/admin/store-config：CSRF + If-Match 必填；跨字段校验（默认语言、时区、币种、开关闭集）；市场按 marketCode 增量写入，不能直接写审核状态；未审核或已过期市场设为启用返回 422；产生交易（`tradingStartedAt` 非空）后改本位币返回 409 CURRENCY_LOCKED。
- POST /api/v1/admin/store-config/markets/:marketCode/reviews：店主身份 + 已验证 MFA + CSRF + If-Match；`confirmedMarketCode` 必须与路径一致；有效期必须晚于当前时间；结论只写审核状态并强制 `enabled=false`（审核通过不自动开放交易）；拒绝/撤销立即生效；响应 ETag 为新配置版本，正文为追加的审核记录。
- apps/admin 新增 /admin/settings：店铺名称、启用语言、默认语言、币种、时区、功能开关；市场建档、开关交易与审核记录表单；未授权账号只看到权限提示。/admin/access 在有权时给出入口。

验证：pnpm check 通过（29 项顶层 Node 测试：5 项店铺领域单测 + 真实 PostgreSQL 店铺 HTTP 用例 + 既有身份/预设/审计回归，21 项 Python 契约测试），管理端类型检查与生产构建通过（新增 /admin/settings 路由）；本地 Edge 的 pnpm test:browser 26 项桌面/手机用例通过（新增设置页 3 项：If-Match 保存、审核提交、无权限提示）。

关键对抗用例：默认语言不在启用语言内 422、伪造时区 422、未知功能开关 422、无 If-Match 422、并发修改 409、无权限读写 403、未审核即启用 422、审核人与确认市场不符 422、过去有效期 422、审核通过后市场仍为关闭、撤销后立即不可交易、数据库层强制改写过期时间后读取即 expired、有交易后改本位币 409、审计含配置与审核动作且不含审核依据以外的凭据。

边界：市场只是业务参数，不构成法律判断；商品可售清单（eligibleProductIds）当前只校验 UUID 格式，商品存在性与发布时的市场资格校验随 M03 落地。品牌媒体 ID 未有媒体模块（M02/M03 媒体）时无法上传，仅能写入引用。项目仍不可上线；升级已有实例须备份、演练并运行 pnpm db:migrate（本次为第 7 条迁移）。

## 2026-11-16：商品分类、品牌与商品目录（M03）

本批程序：

- 第八条迁移新增 Category/CategoryTranslation、Brand/BrandTranslation、Product/ProductTranslation/ProductVariant/ProductMedia/ProductAttribute/ProductCategory 与 InventoryItem。约束覆盖：状态枚举、价格非负整数、SKU 形状与全店唯一、slug 按语言唯一、分类父子不得自指、库存 reserved ≤ onHand。
- `packages/domain/src/catalog.ts`：翻译集规范化（启用语言外拒绝、同一语言重复拒绝、slug 无空白/斜杠）、规格校验（SKU 形状、提交内唯一、价格整数最小单位、币种必须等于店铺本位币）、发布门禁（每种启用语言必须有名称与 slug，至少一个 active 规格）、市场资格（市场必须已审核启用，配置了可售清单时商品必须在清单内）、分类成环检查。
- 分类：GET /admin/categories（catalog.read）、POST（catalog.write）、GET/PATCH /admin/categories/:id（版本校验，父链改动做成环检查）。翻译整组替换；slug 冲突由数据库唯一约束映射为 409。
- 品牌：GET/POST /admin/brands、GET/PATCH /admin/brands/:id，含 logoMediaId（媒体模块未上线，仅保存引用）。
- 商品：GET /admin/products（catalog.read，游标分页 + 名称/基础 SKU/规格 SKU 搜索）、POST（catalog.write，建草稿）、GET/PATCH /admin/products/:id（catalog.write + If-Match）；PATCH 按 SKU 增量维护规格，删除有库存的规格返回 422；翻译/图片/属性/分类整组替换；响应不包含属性字段（契约未定义，避免额外字段破坏校验）。
- 发布：POST /admin/products/:id/publish（catalog.publish），校验版本、三语完整性与市场资格；未来 publishedAt 返回 scheduled 且商品保持 draft；POST /admin/products/:id/unpublish 记录原因、立即下架。
- 契约：分类与品牌原先只指向通用 Success/Created，现改为具名 CategoryEnvelope/CategoryListEnvelope/BrandEnvelope/BrandListEnvelope，响应字段受 additionalProperties: false 约束。
- apps/admin 新增 /admin/catalog：商品搜索、草稿创建（三语名称/slug、分类、市场代码、规格）、编辑基础资料、发布/下架，以及分类与品牌的快速建档。

验证：pnpm check 通过（36 项顶层 Node 测试：7 项目录领域单测 + 真实 PostgreSQL 目录 HTTP 用例 + 既有身份/店铺回归，21 项 Python 契约测试），管理端类型检查与生产构建通过（新增 /admin/catalog 路由）；本地 Edge 的 pnpm test:browser 30 项桌面/手机用例通过（新增目录页 2 项）。

关键对抗用例：重复 slug 409、分类成环 422、版本过期 409、跨商品重复 SKU 409、非本位币 422、未知分类/市场 422、缺语言发布 422、未审核市场发布 422、过期版本发布 409、下架后重新发布、搜索命中、无权限 403、审计记录 catalog.* 操作。

边界：媒体上传、库存调整、前台展示与导入（M02/M05/M12）尚未实现，商品图片仅有媒体引用；规格编辑 UI 只读，规格增删需经 API；商品状态只用到 draft/active（archived 留给后续归档流程）；`attributes` 目前只写不读。项目仍不可上线；升级已有实例须备份、演练并运行 pnpm db:migrate（本次为第 8 条迁移）。

## 2026-11-16：媒体上传与前台只读目录（M02）

本批程序：

- 第九条迁移新增 `MediaAsset`：`objectKey` 唯一、只允许 `image/jpeg|png|webp`、单文件 1 B–10 MiB、摘要必须 64 位小写十六进制、尺寸 1–12000；`status='ready'` 的行必须同时具备摘要与宽高（CHECK 约束），pending 行不能伪装成可展示对象。`ProductMedia.mediaId`、`Brand.logoMediaId`、`StoreConfig.logoMediaId/faviconMediaId` 加上外键（`ON DELETE RESTRICT`），“只能引用本实例媒体”由数据库兜底。
- `packages/domain/src/media.ts`：上传申请校验（MIME 闭集、扩展名同族、文件名不含路径分隔符与控制字符、字节数上限）、服务端生成对象 key（`media/yyyy/mm/<uuid>.<ext>`）、图片头解析（PNG IHDR / JPEG SOF / WebP VP8·VP8L·VP8X，含 12000 边长与 8000 万像素上限）、真实类型判定、摘要与大小比对。
- 存储抽象 `apps/api/src/media/storage.ts`：本地目录驱动（HMAC 签名 URL、临时文件改名落盘、路径越界双重校验）与 S3 兼容驱动（SigV4 预签名，已用 AWS 官方测试向量校验签名结果）。`MEDIA_DRIVER`/`S3_*`/`MEDIA_LOCAL_ROOT` 决定驱动；上传签名密钥由实例加密密钥派生，轮换实例密钥即作废旧上传链接。
- `POST /admin/media/upload-target`：`media.manage` + CSRF + Origin；落一条 pending 记录并返回 `mediaId`、`objectKey`、短时 `uploadUrl`（15 分钟，PUT + Content-Type 绑定）与上限。
- `POST /admin/media/complete`：`media.manage` + CSRF；服务端回读对象、自己算 SHA-256、自己从文件头判断类型与尺寸，任一项与申请不符即 422；`status='pending'` 条件更新保证重复确认返回 409；成功写审计 `media.uploaded`。
- `GET /admin/media`（游标分页）、`GET /admin/media/:id`：返回元数据与 10 分钟读取链接；pending 行 `url=null`，不给无法兑现的链接。
- 存储端点 `PUT/GET /api/v1/media/objects?key&expires&signature`：不读会话、不校验 CSRF，只认单对象单方法签名；GET 只服务已确认媒体，响应带 `nosniff`、`private, max-age=300` 与摘要 ETag。它不属于 OpenAPI 业务契约，已在 API_SPEC.md 说明。
- 前台只读目录：`GET /storefront/config`、`/products`、`/products/:slug`、`/categories`。可售条件全部写成查询条件——`status='active'`、`publishedAt` 为空或已到、`marketCodes` 含当前市场、市场已审核且未过期、市场配置了可售清单时必须在清单内；未指定市场取字典序第一个可售市场，指定了不可售市场则列表为空/详情 404，不静默换市场。语言只允许店铺已启用语言，缺失翻译回退默认语言。
- apps/admin 新增 /admin/media：上传（浏览器算摘要 → 申请目标 → 直传字节 → 确认）、缩略图列表、复制媒体 ID；商品与店铺设置页给出入口。

验证：pnpm check 通过（43 项顶层 Node 测试：5 项媒体域单测 + S3 签名向量 + 真实 PostgreSQL 媒体 HTTP 用例 + 前台过滤用例 + 既有身份/店铺/目录回归，21 项 Python 契约测试），管理端类型检查与生产构建通过（新增 /admin/media 路由）；本地 Edge 的 pnpm test:browser 34 项桌面/手机用例通过（新增媒体页 2 项×2 项目）。

关键对抗用例：SVG/GIF 与扩展名不同族 422、超过 10 MiB 422、无扩展名按 MIME 放宽、对象 key 不能越出 media 前缀、伪造/过期/无签名 PUT 与 GET 一律 403、错误摘要 422 且记录保持 pending、未知对象 422、重复确认 409、确认后 pending 才转 ready、pending 对象不提供字节、品牌引用不存在的媒体 422、`catalog.read` 不能读媒体库、未审核市场前台为空、未来发布时间与草稿不可见、英文 slug 用中文前台访问按当前语言回退。

边界：本地驱动把字节写在 API 主机磁盘上，多副本部署必须改 S3 驱动；S3 驱动的确认步骤会整对象回读算摘要（单文件 ≤10 MiB），未做分片与 CDN；无媒体删除/替换/裁剪接口，pending 行不会自动清理；前台只输出媒体引用不输出图片地址（契约未定义），三语参考前台与页面内容（M04）未开始；购物车与结账未实现。项目仍不可上线；升级已有实例须备份、演练并运行 pnpm db:migrate（本次为第 9 条迁移）。

## 2026-11-16：购物车、配送配置与结账（M06）

本批程序：

- 第十条迁移新增 `GuestCart`（token 只存 SHA-256）、`CartItem`、`ShippingZone`/`ShippingRate`/`ShippingRateZone`、`CheckoutQuote`/`CheckoutQuoteLine`、`ShopOrder`/`OrderItem`、`InventoryReservation`、`OrderStatusEvent`。金额表与行表都用 CHECK 约束锁住“总额 = 小计 - 折扣 + 运费 + 税”“行小计 = 单价 × 数量”；算错的服务端同样写不进去。订单号、幂等键、报价 ID 各自唯一。
- `packages/domain/src/checkout.ts`：数量 1–99、联系方式至少一个有效渠道、地址长度与国家码、优惠码 trim+uppercase、政策同意去重且必须显式 true、运费免邮门槛、报价金额不变量、报价版本/有效期、订单号与幂等指纹。
- `packages/domain/src/shipping.ts`：编码/名称/国家/区域/金额/天数的规范化，启用区之间拒绝重叠口径（同国家全境、或区域集合相交）。
- 游客购物袋：`POST/GET /storefront/cart`、`POST /storefront/cart/items`、`PATCH/DELETE /storefront/cart/items/:id`。身份只来自 `ez_guest_cart`（HttpOnly、Secure、SameSite=Lax、path=/api/v1、30 天）；写操作要求 `ez_cart_csrf` 与 `X-CSRF-Token` 双提交一致，缺失或不匹配一律 403。未发布、已下架、跨币种、超出可售库存的变体拒收；购物袋不保存价格，每次读取按当前变体重算，并标记 `available`/`availableQuantity`。小计只汇总当前可售行。
- 配送配置（M09 最小切片）：`/admin/shipping/zones`、`/admin/shipping/rates` 的列表/创建/详情/更新（`shipping.manage` + CSRF + Origin + If-Match），`POST /admin/shipping/quote-preview` 试算。费率币种必须等于店铺基础币种；名称只能使用店铺已启用语言；引用不存在的区返回 422。
- 报价 `POST /storefront/checkout/quote`：市场必须已启用且审核未过期（否则 409 `MARKET_NOT_AVAILABLE`），重新校验商品在该市场的可售性、变体状态与库存，运费按配送区覆盖与免邮门槛计算，生成不可变快照（15 分钟），并把该购物袋此前的 active 报价置为 `superseded`。报价响应不回显联系方式。优惠引擎未实现，提交优惠码时返回 `COUPON_NOT_APPLIED` 警告而不是静默打折。
- 下单 `POST /storefront/checkout/orders`：`Idempotency-Key` 16–128 字符，指纹只覆盖报价 ID、确认版本、支付方式与备注；同键同指纹返回原订单，同键不同指纹 409 `IDEMPOTENCY_CONFLICT`。事务内校验报价归属/状态/有效期/版本、当前价格与市场可售性，用 `UPDATE ... WHERE onHand - reserved >= qty` 原子预留库存（扣不到即整体回滚并返回 409 `OUT_OF_STOCK`），随后写入订单行、预留记录与状态事件，并把报价置为 `consumed`、购物袋置为 `converted`。首期无支付网关：只接受配送方式显式开启的货到付款（`paymentMethodCode=cod`），其余方式 422 `PAYMENT_METHOD_UNAVAILABLE`。
- apps/admin 新增 /admin/shipping：配送区与费率列表、创建、启用/停用（带 If-Match）、金额按分提交、运费试算；商品目录、店铺设置、媒体库页给出入口。

验证：pnpm check 通过（Node 测试新增结账域 13 项与真实 PostgreSQL 结账 HTTP 用例；契约测试 22 项含新增购物车响应类型断言），管理端类型检查与生产构建通过（新增 /admin/shipping 路由）；本地 Edge 的 pnpm test:browser 40 项桌面/手机用例通过（新增配送页 3 项×2 项目）。

关键对抗用例：无 cookie 读购物袋 401、缺 CSRF 或令牌不符 403、CSRF cookie 可读而会话 cookie 不可读、数量 0/100/非整数 422、客户端价格字段 422、草稿商品变体 422、超库存 409、跨购物袋删行 404、未审核市场 409、非本袋 cartId 422、优惠码只产生警告、报价不回显联系方式、同键重放返回同订单且不重复预留、同键不同备注 409、已消费报价不能再下单、改价后下单 409 `PRICE_CHANGED`、过期报价 409 `QUOTE_EXPIRED`、库存不足回滚且不留半张订单、超过 IP 阈值 429。

边界：没有优惠引擎（折扣恒为 0）、没有税费配置（`ruleVersions.tax = null`）、没有顾客/会员档案与订单查询接口（M07/M10）；预留 30 分钟到期后由 M07 释放任务处理，本批没有后台释放任务；订单只有 `awaiting_confirmation`/`cod_due` 两个初始状态，取消、发货、退款均未实现；配送只支持固定运费与金额门槛免邮，没有重量/体积/阶梯计费；本地实例升级需运行 pnpm db:migrate（第 10 条迁移）。

## 2026-11-16：订单管理与预留释放（M07）

本批程序：

- 第十一条迁移新增 `OrderNote`、`OrderAction`、`Shipment`/`ShipmentItem`、`OrderAddressChange`，并给 `ShopOrder` 增加 `cancelledAt`/`cancelReasonCode`/`cancelReason`/`customerNotified`。同时把第 10 条迁移里只允许两个初始状态的三条 CHECK 放宽到契约枚举全集；`Shipment` 用 CHECK 锁死“状态与时间必须同时成立”（已发货必须有 dispatchedAt、已签收必须有 deliveredAt），`ShopOrder` 锁死“已取消 ⇔ cancelledAt 非空”。
- `packages/domain/src/orders.ts`：取消/改址/建包裹/发货/签收的状态机、包裹数量累计（含已分配未发货）、联系方式遮蔽（邮箱、电话、姓名）、备注与取消原因规范化、改址金额不变量、顾客确认依据。
- 后台订单：`GET /admin/orders`（游标分页 + 订单号/顾客备注搜索）、`GET /admin/orders/:id`（行、包裹、状态历史、备注、取消信息）。没有 `customers.read_pii` 的账号看到的是遮蔽后的联系人；列表恒为遮蔽值。
- `POST /admin/orders/:id/cancel`：`orders.cancel` + CSRF + Idempotency-Key；版本核对后释放全部 active 预留，写取消时间/原因/是否通知顾客与状态事件。已收款订单返回 409 `PAID_ORDER_REQUIRES_REFUND`，已发货/已取消分别拒绝。
- `POST /admin/orders/:id/address-change`：`orders.address_change` + 幂等；复用配送配置重算运费（沿用原配送方式，不静默换方法），运费变化必须带 `customerConfirmationRef`，否则 422 `CUSTOMER_CONFIRMATION_REQUIRED`；新地址无可用配送方式返回 409 `SHIPPING_UNAVAILABLE`；已有任何包裹离开仓库后拒绝。
- `POST /admin/orders/:id/notes`：`orders.update`，1–1000 字符、拒绝控制字符；备注只进内部记录。
- `POST /admin/orders/:id/shipments`：`shipments.manage` + 幂等；同一订单行可拆多个包裹，未取消包裹累计数量不得超过订购量（超出发 409 `SHIPMENT_QUANTITY_EXCEEDED`）。
- `POST /admin/shipments/:id/dispatch`：`shipments.manage` + If-Match + 幂等；事务内校验该订单的预留仍为 active 且数量足够，`UPDATE ... WHERE onHand >= qty AND reserved >= qty` 同时扣减 `onHand` 与 `reserved`，剩余预留数量归零才标 `committed`；按累计发出来推进订单到 `shipped`/`partially_shipped` 与 `fulfilled`/`partially_fulfilled`。
- `POST /admin/shipments/:id/deliver`：只能签收已发货包裹；全部行签收后订单转 `completed`/`delivered`。签收不改 `paymentStatus`——COD 仍是 `cod_due`，收款登记属于 M08。
- 过期预留清理：`OrdersService.releaseExpiredReservations()` 按订单加锁、只释放过期 active 预留；仍停留在 `awaiting_confirmation` 的订单自动取消（`cancelReasonCode=reservation_expired`、`actorType=system`）。`ReservationSweeper` 在 API 进程每 60 秒跑一次（`unref`，不阻塞退出），启动时先跑一轮；已确认/处理中的订单不在自动清理范围内。
- apps/admin 新增 /admin/orders：列表与搜索、详情、取消、改址、内部备注、拆包裹、发货、登记签收；商品目录、媒体库、配送页给出入口。

验证：pnpm check 通过（Node 测试新增订单域 9 项与真实 PostgreSQL 订单 HTTP 用例；契约测试 24 项含订单权限矩阵与 AdminOrder 版本字段断言），管理端类型检查与生产构建通过（新增 /admin/orders 路由）；本地 Edge 的 pnpm test:browser 46 项桌面/手机用例通过（新增订单页 3 项×2 项目）。

关键对抗用例：无会话 401、只有 orders.read 不能取消/发货/写备注 403、列表与详情在无 PII 权限时遮蔽联系方式、owner 可见完整联系方式、版本过期 409、同幂等键不同原因 409、同键重放不重复释放预留/不重复写事件、已取消订单再取消 409、运费变化无确认依据 422、地址不在配送区 409、包裹数量超订购量 409、未发货直接签收 409、重复发货 409、发货只释放本包裹预留、拆两包裹发货后订单才转 shipped、全部签收后 completed 且 paymentStatus 仍为 cod_due、过期预留释放且订单被系统取消、清理任务重复执行无副作用。

边界：没有支付渠道与 Webhook（M08）、没有 COD 收款登记、退款与售后；没有订单确认/暂停/恢复等中间动作的独立接口，确认与处理中状态目前只由发货推进；已确认但未发货的订单若预留过期不会被自动取消（会保留原状态，需人工处理）；包裹不可取消/合并/改址，发货后地址只能人工记录；多副本部署时清理任务会在每个副本各跑一次（按行条件更新与订单锁保证不重复扣减）；本地实例升级需运行 pnpm db:migrate（第 11 条迁移）。
