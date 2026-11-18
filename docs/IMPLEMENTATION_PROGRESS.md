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

会员 OTP 与积分（M10）已完成并上线；M11 会员解锁（会员专属券、会员身份限额、批量发放）亦已完成；M14 经营报表首批（服务端权威数据聚合与受控导出）已完成并上线；M14 第二批「访问漏斗」（第一方匿名事件采集 + 漏斗报表）已完成。剩余：陈列效果分析（M14 P1，依赖发布版本埋点与 section 归因，另行估算）、结算文件对账（M08 剩余，依赖客户提供沙箱/生产凭证与文件格式）、三语参考前台（M02 前台部分）与页面内容（M04）。承运商签名状态回传（M09 剩余）已于本批完成。批量发放的真实通知投递、真实 SMTP 及 HTTPS 链路（含邀请与密码重设邮件）仍须在实例参数齐备后独立验收。

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

## 2026-11-16：付款方式配置、收款登记与交易台账（M08）

本批程序：

- 第十二条迁移新增 `PaymentMethodConfig`、`Payment`、`PaymentEvent`。数据库不是“尽力而为”，而是把三条规则写成约束：启用的方式必须有批准依据（`approvalReference` 与 `approvedAt` 同时存在，或 `enabled=false`）；`secretRef` 必须是 `scheme://...` 形状的引用，指纹必须是 16 位小写十六进制；台账状态与时间必须同时成立（`collected|succeeded|returned` 必须有 `paidAt`，`returned` 与 `returnedAt` 同真同假），`("providerCode","providerTransactionId")` 在非空时唯一，同一服务商交易号无法入账两次。
- `packages/domain/src/payments.ts`：已接入渠道白名单（`cod` 与 `manual_bank_transfer`，各带渠道类型与凭证要求）、按渠道收口的结果集（COD 没有“授权成功”，人工转账没有“拒收”）、只进不退的状态机（`unknown` 没有人工出口，必须由渠道查询结论推进）、订单付款状态投影、收款入参规范化（金额为正整数、时间不得晚于当前 1 分钟以上、拒收/退回必须写原因）、金额三向校验（台账=订单=请求且币种一致）、COD 必须已发货、凭证引用形状校验、`publicConfig` 白名单、台账号 `PAY-YYYYMMDD-XXXXXX`。
- 后台配置：`GET /admin/payment-methods`（`payment.config`）返回渠道、环境、启用状态、批准状态与依据、`publicConfig`、`secretConfigured`、`secretFingerprint`、连接状态与版本——响应模型里没有 `secretRef` 字段，凭证引用写进去就再也读不出来。`PATCH /admin/payment-methods`（`payment.config` + CSRF + Origin + If-Match）按 `providerCode`+`environment` 定点更新；启用必须有批准依据，直接粘密钥本体 422 `SECRET_REFERENCE_INVALID`，渠道仍有 `pending|authorized|unknown` 流水时停用 409 `PAYMENT_METHOD_IN_USE`；凭证更换只更新指纹，写审计 `payments.method.enabled|payments.method.updated`。
- 结账接入：`CheckoutService` 不再硬编码 `cod`。可售方式 = 已接入 + 已批准 + 生产环境已启用，COD 另需配送方式开启货到付款；否则 422 `PAYMENT_METHOD_UNAVAILABLE`。下单与台账同事务：COD 订单 `paymentStatus=cod_due`、人工转账 `created`，同时开一条 `pending` 流水（金额只来自订单快照），人工转账的顾客付款说明取自 `publicConfig.accountSummary`，未配置就不编造银行信息。
- 收款登记：`POST /admin/orders/:id/payment-result`（`payments.collect` + CSRF + Origin + `Idempotency-Key` + If-Match）。事务内按订单加锁、核对版本、复核金额与时间窗、按渠道推进台账状态，并把订单 `paymentStatus` 投影为 `collected|rejected|returned|succeeded|cancelled`（订单版本 +1，后续动作必须用新版本）。重放同键返回同一笔流水，同键不同内容 409 `IDEMPOTENCY_CONFLICT`，再收一次 409 `PAYMENT_STATE_CONFLICT`。签到收不改付款状态的旧规则保留：登记收款是独立动作。
- 台账读取：`GET /admin/payments`（`payments.read`，游标分页 + `status`/`orderId`/`providerCode` 筛选）与 `GET /admin/payments/:id`（含追加写事件流）。
- 权限：新增 `payments.collect`，授予 owner、admin 与财务预设；`payment.config` 仍只给 owner 与管理员的显式授权，财务不能改生产凭证。`docs/DEVELOPMENT_SPEC.md` 7.1 与 `docs/API_SPEC.md` 3.4/3.6.6 同步。
- apps/admin 新增 /admin/payments：渠道配置（批准依据、凭证引用、收款说明、启停，带 If-Match）、台账列表与筛选、单笔流水与事件；订单详情新增「登记收款」（结果、金额、参考号、原因，带订单版本）。各页面补充付款入口。

验证：pnpm check 通过（Node 77 项：付款域 9 项 + 真实 PostgreSQL 付款 HTTP 用例 + 结账/订单/目录/身份回归；Python 契约 27 项含支付权限矩阵、台账状态闭集、配置响应不含凭证），管理端类型检查与生产构建通过（新增 /admin/payments 路由）；本地 Edge 的 pnpm test:browser 50 项桌面/手机用例通过（新增付款页 2 项×2 项目）。

关键对抗用例：凭证引用传 `sk_live_...` 422、启用无批准依据 422、缺 If-Match 422、旧版本改配置 409、响应体不含 `secretRef`、仍有待收流水时停用 409、未发货登记 COD 收款 409 `ORDER_NOT_SHIPPED`、少收 1 分 422 `PAYMENT_AMOUNT_MISMATCH`、跨币种 422、收款时间早于下单时间 422、拒收/退回无原因 422、已收款订单取消 409 `PAID_ORDER_REQUIRES_REFUND`、同键重放不产生第二条流水、同键不同内容 409、拒收后再退回 409、退回保留 `paidAt`、停用 COD 后结账 422、人工转账未配置说明时不给伪造指令、回调式“人工改判未知状态”没有入口。

边界：本批只做了线下渠道（COD、人工转账）与登记式台账，没有线上支付适配器、Webhook 原始 body 验签、事件重放窗口、`unknown` 自动重查（1/5/15/30 分钟）、退款（M16）与服务商结算文件对账，`connectionStatus`/`lastCheckedAt` 只有字段没有探活任务；订单付款状态投影只覆盖 `collected/succeeded/rejected/returned/cancelled/failed`，`authorized` 目前无处产生。项目仍不可上线；升级已有实例须备份、演练并运行 pnpm db:migrate（本次为第 12 条迁移）。

## 2026-11-16：售后案件、退货质检与退款分权（M16）

本批程序：

- 第十三条迁移新增 `AfterSalesCase`/`AfterSalesItem`/`AfterSalesEvent`、`Refund`/`RefundEvent`、`ReturnShipment`/`ReturnReceipt`/`ReturnReceiptItem`、`InspectionRecord`、`InventoryMovement`。数据库继续承担业务不变量：`AfterSalesCase_approval_pair_check`（`approvedAt` 与 `approvedBy` 同真同假）、`AfterSalesCase_approved_amount_requires_approval_check`、`AfterSalesCase_status_requires_approval_check`（进入 `approved` 之后的状态必须已有批准记录，不能靠改字段跳过审核）、`AfterSalesCase_completed_closed_check`、`Refund_status_requires_approval_check`、`Refund_refunded_requires_execution_check`（`refunded` 必须有执行人与执行时间）、`InventoryMovement_restock_delta_check`（`("type"='return_restock') = ("stockDelta"="quantity")`）与 `InventoryMovement_onhand_only_on_restock_check`。台账号格式 `AS-YYYYMMDD-XXXXXX` / `REF-YYYYMMDD-XXXXXX`；`Refund.idempotencyKey` 与各事件表 `dedupeKey` 唯一，重放写不进第二行。
- `packages/domain/src/aftersales.ts`（纯判定，不含 IO）：案件动作与结果的前向状态机（`CASE_ACTIONS`/`CASE_RESULT`）、`nextRefundStatus`（只进不退）、`refundableBalance`/`assertRefundWithinBalance`、`assertRefundablePayment`（只有 `collected|succeeded` 可退，`returned` 返回 `PAYMENT_ALREADY_RETURNED`）、`assertCancelCaseOrder`、`assertCaseRefundable`、`allocateLineAmount`（按行金额比例向下取整，余数不补，避免多退）、`approvedAmount`（申请额/行分摊额/订单总额三者取最小）、`assertInspectionQuantity`、`restocksStock`（只有 `sellable` 入库）、`caseNumber`/`refundNumber`。
- `apps/api/src/orders/reservations.ts`：把 `releaseOrderReservations(tx, orderId, onlyExpired)` 从 `OrdersService` 抽出，订单取消与售后取消类案件复用同一段释放逻辑，避免两处各写一遍预留回收。
- 售后案件：`GET/POST /admin/after-sales`（`after-sales.read`/`after-sales.manage`，游标分页 + `status`/`caseType`/`orderId` 筛选）、`GET /admin/after-sales/:id`。建案时不接受客户端传来的价格与总计：行必须属于该订单，数量按同一案件内累计（`requestedQuantity`），超可退量 422，`requestedRefundMinor` 只是申请额、不是承诺额。
- 审核：`POST /admin/after-sales/:id/approve`（`aftersales.approve` + CSRF + Origin + `If-Match` + `Idempotency-Key`）——批准金额取三者最小值，逐行写 `approvedQuantity`/`amountMinor`；`cancel` 类案件在同一事务内取消订单、释放全部 active 预留、直接置 `completed`+`closedAt`，已收款 409 `PAID_ORDER_REQUIRES_REFUND`、已发货 409 `ORDER_ALREADY_SHIPPED`。`POST .../reject` 只写驳回原因，案件不可再前进。
- 退货链路：`POST .../return-shipment`（承运商/追踪号/寄回时间，进入 `return_in_transit`）→ `POST .../receive-return`（收件时间、参考号、逐行数量，累计不得超过批准量）→ `POST .../inspect`（`aftersales.inspect`，逐行数量与处置 `sellable|damaged|quarantine|scrap`）。只有 `sellable` 在事务内 `UPDATE ... inventoryItem onHand + qty` 并写 `InventoryMovement(type=return_restock)`；损坏/冻结/报废只写质检记录，不动库存——「退货即入库」这条路走不通。超量质检 422 `INSPECTION_QUANTITY_EXCEEDED`。
- 退款台账（与支付台账分开的独立记录）：`GET /admin/refunds`（`refunds.read`，可按 `status`/`orderId`/`paymentId` 筛选）、`GET /admin/refunds/:id`（含追加写 `events[]`）、`POST /admin/refunds`、`POST /admin/after-sales/:id/refund`。余额双维度校验：订单级「实收 − 已退 − 在途」与流水级余额都要过，案件内退款另受批准金额上限约束，超出一律 422 `REFUND_EXCEEDS_BALANCE`。
- 分权：`POST /admin/refunds/:id/approve`（`refund.approve`）里 `requestedBy === actor.id` 直接 403 `SELF_APPROVAL_FORBIDDEN`；`POST /admin/refunds/:id/execute`（`refund.execute`）要求线下渠道必须留 `reference`（水单/现金凭据），线上渠道在没有真实适配器时返回 503 `PAYMENT_ADAPTER_UNAVAILABLE`——不伪造退款成功。执行写 `RefundEvent` 并把 `Payment`/订单付款状态按投影规则同步，不原地改历史金额。
- 结案与在途：在途退款（`requested|approved|processing|unknown`）计入 `pendingRefundMinor`，`POST .../close` 此时 409 `REFUND_IN_PROGRESS`，不存在「结案了钱还在飞」的状态。
- 权限：`aftersales` 预设组扩为 `read`+`manage`+`approve`+`inspect`；`order_support` 显式拿 `read`/`manage`/`inspect`（不含 `approve`）；`warehouse` 只拿 `aftersales.inspect`；退款三项仍只给 Owner 与 Finance。`docs/DEVELOPMENT_SPEC.md` 7.1 与 `docs/API_SPEC.md` 3.4/3.6.6 同步。
- apps/admin 新增 /admin/aftersales：列表与筛选、从订单建案（`?orderId=` 预填并自动载入订单行）、审核/驳回、寄回物流、收件、质检处置、申请退款、批准退款、登记已退款（凭据）、结案与时间线；订单详情新增「为该订单建立售后案件」入口，商品目录、媒体库、配送、付款、店铺设置页给出入口。

验证：pnpm check 通过（Node 88 项：售后域 10 项 + 真实 PostgreSQL 售后 HTTP 用例 + 订单/付款/结账/目录/身份回归；Python 契约 30 项，新增售后快照字段、退款与支付分离、售后写权限与幂等三项断言），管理端类型检查与生产构建通过（新增 /admin/aftersales 路由）；本地 Edge 的 pnpm test:browser 54 项桌面/手机用例通过（新增售后页 2 项×2 项目）。

关键对抗用例：无 `aftersales.approve` 不能批准案件 403、批准无 If-Match/版本过期 409、行不属于该订单 422、同一案件累计申请量超额 422、取消类批准同时取消订单并释放预留、已收款订单走取消类 409 `PAID_ORDER_REQUIRES_REFUND`、申请人自己批退款 403 `SELF_APPROVAL_FORBIDDEN`、超过可退余额 422 `REFUND_EXCEEDS_BALANCE`、案件内退款超批准额 422、同幂等键重放不产生第二笔退款、同键不同金额 409 `IDEMPOTENCY_CONFLICT`、在途退款时结案 409 `REFUND_IN_PROGRESS`、COD 未收款无款可退 422 `NOTHING_TO_REFUND`、线上渠道无适配器 503、线下渠道无凭据 422、质检数量超收件量 422 `INSPECTION_QUANTITY_EXCEEDED`、只有 `sellable` 让 `onHand` +1（损坏处置后账面不变）、案件响应改写订单总额字段被 schema 拒绝、`refunded` 无执行人写不进数据库。

边界：本批没有线上支付/退款适配器（`online` 渠道只到 `503 PAYMENT_ADAPTER_UNAVAILABLE`）、没有换货发货（`exchange` 案件可建案与批准，但没有补发包裹接口）、没有顾客自助售后入口（只有后台建案）、没有退货物流回传与逆向运费、没有退款重试/自动对账与 `unknown` 重查任务、没有部分质检后自动拆分处置；`InventoryMovement` 本批只由退货入库产生，库存调整与调拨仍在 M12 未做。项目仍不可上线；升级已有实例须备份、演练并运行 pnpm db:migrate（本次为第 13 条迁移）。

## 2026-11-16：库存调整、流水与低库存阈值（M12）

本批程序：

- 第十四条迁移：`InventoryItem` 增加 `version` 与 `updatedAt`（并发调整的凭据）；`InventoryMovement` 增加 `reasonCode`/`reference`/`requestFingerprint`，并放开类型闭集。数据库继续兜底形状：退货入库的 `stockDelta` 必须等于 `quantity` 且为正，人工调整的 `abs(stockDelta)` 必须等于 `quantity` 且不为 0，两种类型都必须写 `onHandAfter`；`onHand`/`reserved` 不得为负，`version` 不得小于 1，调整流水的请求指纹只能是 64 位小写十六进制。新增 `InventoryThreshold`（按变体唯一，0–1,000,000）。
- `packages/domain/src/inventory.ts`：`normalizeAdjustment`（非零整数、绝对值 ≤100,000、原因/编码/凭据规范化、拒绝控制字符）、`assertAdjustmentAllowed`（`onHand + delta ≥ 0` 且 `available ≥ 0`，即不能吃掉已预留）、`adjustmentMovement`（带符号 delta + 绝对值 quantity）、`adjustmentDedupeKey`、`assertInventoryVersion`（0 表示“尚无库存行”）、`lowStockState`（按可售数判定 `ok|low|out_of_stock`，阈值为 0 时只关心售罄）。
- 读接口：`GET /admin/inventory`（`inventory.read`）用一条显式 SQL 从变体出发左连库存与阈值，把从未入库的 SKU 也列出来（onHand 0、version 0），`available = onHand − reserved` 由服务端算，游标是上一页最后一个 `sku`；支持 `q`（SKU 或商品名）、`variantId`、`lowStock`。`GET /admin/inventory/movements` 支持 `variantId`/`type`/`orderId`/`caseId`/时间区间筛选，按 `createdAt desc, id desc` 游标分页。
- 写接口：`POST /admin/inventory/adjustments`（`inventory.adjust` + CSRF + Origin + `Idempotency-Key`）。事务内按变体加 advisory lock、核对期望版本、校验可售下限、写流水并推进库存版本；没有库存行时 `expectedVersion=0` 才允许创建。同键重放返回原流水（`replay: true`）且不重复记账，同键换内容 409 `IDEMPOTENCY_CONFLICT`，旧版本 409 `VERSION_CONFLICT`，调减吃掉预留 409 `INSUFFICIENT_ON_HAND`。`PATCH /admin/inventory/thresholds`（`inventory.manage` + CSRF）用 body 里的 `expectedVersion`（0 = 新建），阈值版本与库存版本互不干扰。
- 库存流水从此有两个来源：退货质检的 `return_restock`（只有 `sellable` 才动 `onHand`）与人工 `adjustment`；两者的形状约束写在同一张表上，可售数的任何变化都能追到一条流水。
- 权限：`inventory` 预设组为 `read`+`adjust`+`manage`；ProductOps 只有 `read`；Warehouse 拿 `read`+`adjust`（能盘点、不能改阈值）。`docs/DEVELOPMENT_SPEC.md` 7.1 与 `docs/API_SPEC.md` 3.5/3.6.7 同步。
- apps/admin 新增 /admin/inventory：库存列表（搜索、只看低库存、点选 SKU）、调整表单（带当前版本）、阈值表单（带阈值版本）、按 SKU 的流水表与类型筛选；商品目录、订单、付款、配送、售后、店铺设置页补入口。

验证：pnpm check 通过（Node 96 项：库存域 7 项 + 真实 PostgreSQL 库存 HTTP 用例 + 售后/订单/付款/结账/目录/身份回归；Python 契约 32 项，新增库存调整形状与流水/阈值闭集两项断言），管理端类型检查与生产构建通过（新增 /admin/inventory 路由）；本地 Edge 的 pnpm test:browser 58 项桌面/手机用例通过（新增库存页 2 项×2 项目）。

关键对抗用例：无 `inventory.read` 看不到列表 403、只有 `inventory.adjust` 改不了阈值 403、`delta=0`/字符串/小数/超上限 422、未建库存行的 SKU 以 version 0 出现且可首次入库、旧版本 409 `VERSION_CONFLICT` 且库存不变、同键重放 `replay:true` 且不产生第二条流水、同键换内容 409、现存 8 预留 4 时减 5 被拒（`INSUFFICIENT_ON_HAND`）、减 4 后 `available=0`、形状不符的调整流水被数据库拒绝、阈值旧版本 409、阈值不影响 `available`、`lowStock=1` 同时命中低库存与售罄、`type=purchase` 422、`from` 晚于 `to` 422、退货入库与人工调整共用同一张流水表。

边界：库存调整只覆盖单 SKU 增量，没有批量盘点单、导入盘点表或按仓库/库位分账；`InventoryMovement` 仍不记录发货出库（发货的扣减写在订单履约事务里，未生成流水），因此「所有库存变化都有流水」这件事还差发货与预留两条；低库存阈值只存数值，没有告警任务、通知订阅或阈值变更历史（只有审计记录）；没有库存预留的可视化与手工释放接口（只能等清理任务）。项目仍不可上线；升级已有实例须备份、演练并运行 pnpm db:migrate（本次为第 14 条迁移）。

## 2026-11-16：优惠码引擎与额度生命周期（M11）

本批程序：

- 第十五条迁移 `202611160014_promotions`：`Coupon`（券码唯一、格式 `^[A-Z0-9][A-Z0-9_-]{0,79}$`、百分比 1–10000 bps / 固定额 1–100,000,000、`validUntil > validFrom`、范围数组上限、退款策略闭集）、`CouponRedemption`（每单一行 `orderId` 唯一、`dedupeKey` 唯一、状态闭集 `reserved|redeemed|released|expired`、`redeemedAt`/`releasedAt` 与状态互锁、核销行不得再带 `expiresAt`、访客限额键必须是 64 位小写十六进制 HMAC）、`CouponRedemptionEvent`（追加写审计）、`CouponQuotaReturn`（`redemptionId` 唯一：一次核销最多返还一次）；`CheckoutQuote` 增加 `couponId`+`couponSnapshot`，`ShopOrder` 增加 `couponId`+`couponSnapshot`。
- `packages/domain/src/promotions.ts`（纯规则，不含 IO）：券码归一化与打码、规则整体校验与补丁合并后重校验（避免只改类型留下巨额面值）、有效区间（`valid_from <= now < valid_until`）、币种与最低消费校验、范围适用性（商品或分类为「或」，空 = 全场）、折扣计算（BigInt half-up 舍入到最小货币单位，固定额与百分比都不超过符合条件金额）、按行金额比例分摊且余数按行序 +1（各行折扣和恒等于总折扣）、限额断言（`usedCount = 预占+已核销−已返还`）、额度状态机只进不退、规则快照（含 `ruleVersion`）。
- `apps/api/src/promotions/redeem.ts` 是三个事务内钩子，供订单/支付/售后复用：收款成功 `redeemCouponInTx`、取消/售后取消批准 `releaseCouponInTx`、过期清理 `expireCouponInTx`；整单退款且 `refundPolicy=restore` 时 `restoreCouponQuotaInTx` 新建返还记录并写一条 `redeemed→redeemed` 审计事件，不改写原核销行。
- 报价与下单：报价只做只读试算（`priceQuote`），金额里真实计入折扣与行级 `lineDiscountMinor/lineTotalMinor`，快照与 `ruleVersions.promotion` 一起冻结；下单前复核券版本与可用性（旧报价遇到改券 409 `COUPON_CHANGED`），下单事务内 `pg_advisory_xact_lock` + 限额复核后预占，券版本与库存版本、阈值版本各自独立。未知/过期/未开始/停用/币种不符/未达最低消费/不适用/限额用尽都返回 409 与稳定原因码，不再静默按原价结算。
- 访客顾客限额键为 `HMAC-SHA256(instanceId:coupon:规范化邮箱或电话)`（实例 `encryptionKey` 作密钥），不落原联系方式；管理端核销记录只给摘要前 8 位（`customerRef`）。
- 后台 API：`GET/POST /admin/coupons`（`coupons.read/manage`，`q`/`status` 筛选与游标分页）、`GET/PATCH /admin/coupons/:id`（PATCH 须 `If-Match`）、`GET /admin/coupons/:id/redemptions`、`POST /admin/coupons/:id/disable`（原因 + `Idempotency-Key`）；`POST /admin/coupon-batches` 与 `POST /admin/coupon-batches/:id/issue`（`coupons.issue`）在会员目录落地前一律 422 `MEMBER_AUDIENCE_UNAVAILABLE`，会员专属规则同理 422 `MEMBER_TIERS_UNAVAILABLE`——不建一张永远用不了的券或空批次。
- 契约：`CouponFields`/`CouponWriteRequest`/`CouponPatchRequest`（百分比 1–10000 bps 的 if/then 约束对写入与补丁同时生效）、`AdminCoupon`（含 `usage` 与 `codeMasked`，不含快照）、`AdminCouponRedemption`（只有 `customerRef`）、批次请求/确认；Python 契约测试新增 5 项（权限与幂等形状、闭集与上限、快照不进入规则响应、核销记录脱敏、批次确认数）。
- apps/admin 新增 /admin/coupons：券列表（搜索/状态筛选）、创建（百分比按 % 输入、内部换算 bps）、用量六口径（预占/已核销/已释放/已过期/已返还/占额度）、核销记录表（脱敏顾客摘要）、带原因的停用表单；商品目录、订单、付款、售后、库存、配送、媒体、店铺设置页补入口。
- 测试脚手架修正：`tests/helpers/postgres.ts` 此前在 Windows 提权 shell 下会让整个 Node 进程静默以退出码 0 结束（`pg.start()` 悬挂后事件排空 + 失败后 `pg.stop()` 永不返回），`pnpm test` 会把数据库回归报告为通过。现在启动有 60 秒超时、失败路径的清理有 5 秒护栏，并明确报错提示「用非提权终端运行，或设置 `TEST_DATABASE_URL` 指向既有 PostgreSQL 18」；`TEST_DATABASE_URL` 模式下每次运行在该服务器上创建一次性数据库并在结束后 DROP。

验证：契约 37 项全绿（含优惠 5 项）且生成物与 OpenAPI 一致；Node 域测试 10 项（优惠纯规则）全绿；管理端类型检查与生产构建通过（新增 /admin/coupons 路由）；本地 Edge 的浏览器测试新增优惠页 2 项×2 项目全绿（建券归一化大写与 bps 换算、用量口径、脱敏摘要、停用只带原因）。**本机当前 shell 为提权令牌，PostgreSQL 18 拒绝在管理员权限下启动，沙箱又不允许降权派生进程，因此真实 PostgreSQL HTTP 回归（含优惠 9 个子测试与全部存量回归）本机未运行**：脚手架已改为诚实失败，须在非提权终端运行 `pnpm check` 完成最终验收，或提供 `TEST_DATABASE_URL`。

边界：会员专属券与批量发放要等 M10；部分退款不返还额度（只有整单退款且 `refundPolicy=restore` 才返还）；优惠只支持单品/分类范围与单券每单，不支持阶梯满减、买赠、叠加券或定时启停（停用是手动的）；核销记录页没有导出。项目仍不可上线；升级已有实例须备份、演练并运行 pnpm db:migrate（本次为第 15 条迁移）。

## 2026-11-17：数据库回归首次全量真机验收（183/183）与约束/契约修正

背景：此前的 Node 数据库回归在开发者机器上从未真正执行（提权令牌下 `postgres.exe` 无法启动，脚手架失败路径静默退出并报绿）。本批把测试跑在既有部署服务器（mrinhk）的临时 PostgreSQL 18 容器上，逐条修掉被掩盖的真实缺陷。

修正的真实缺陷：
- 第十五条之后新增第 16 条迁移 `202611170015_constraint_fixes`：`InventoryMovement.stockDelta` 原约束禁止 0，导致 `damaged/quarantine/scrap` 质检入库必然 500——货确实收到但未进可售库存，delta 必须为 0；改为按类型分档。`InventoryReservation.quantity` 原要求 ≥1，导致最后一件发货把剩余置 0 时 500，改为 0–99。
- 全局异常过滤器此前不记录 5xx：客户端只看到 `INTERNAL_ERROR`，服务端没有任何证据。现在 5xx 输出请求方法与路径 + 异常对象。
- 契约校验失败时只报「不匹配」：现在附带前 5 条字段路径与规则名（仅进服务端异常，响应文案不变）。
- `payments/controller` 的 `POST /admin/orders/:id/payment-result` 契约同时声明 `If-Match` 与 body `expectedVersion`，服务端只读 body，导致过期的 `If-Match` 被忽略。现以头部为权威、body 兜底。
- `shipping/service` 把所有领域规则错误映射 422：`ZONE_OVERLAP` 是业务冲突，改为 409。
- 退款创建响应的事件列表恒为空：`include` 在 `refundEvent.create` 之前取快照。改为写完后重读。
- 关案时先判状态机再判在途退款，导致「退款处理中」返回笼统的 `CASE_STATE_CONFLICT`。调换顺序，先报 `REFUND_IN_PROGRESS`。
- 契约把 `countryCodes`、`AddressInput.countryCode` 限定大写，而服务端约定 trim+uppercase 归一化；放宽为大小写不敏感并注明存储值大写。

测试侧修正（此前从未运行，本身有错或相互污染）：
- 204 响应被拿去校验 `SuccessEnvelope`，每个 DELETE 都报契约错误。
- 售后审批角色缺 `aftersales.approve`（规格要求案件批准走该权限，不是 `refund.approve`）。
- 自批测试用同一订单建了一笔 1,000 在途退款，把后续「可退余额」断言压低 1,000；改用独立订单。
- 关案前未跟进退款申请带来的版本 +1；补一次读取。
- 库存阈值子测试注释写「阈值 5」而代码改成 2，断言与数据自相矛盾。
- 购物车超库存期望 422，与 PATCH 的 409 `OUT_OF_STOCK` 口径不一致。
- 发货测试的会话缺 `orders.update`，导致「已完成订单不能改址」拿到 403 而非 409。
- 收款只读账号断言漏 `await`，实际比较的是 Promise。
- 迁移计数断言、`MarketProfile` 种子（CHECK 禁止 `enabled+pending`）、`Shipment` 创建方式（状态与发货时间必须同时成立）等按现行约束修正。

验证：真实 PostgreSQL 18.7 上 `node --test` 183 项全过（含优惠 9 项、结账 11 项、售后 6 项、订单 10 项）；契约 37 项、生成物一致、Prisma schema 有效、管理端 typecheck 通过；Edge 浏览器测试 60 项通过。

边界：本批只修「测试从未运行」暴露的问题，未新增业务能力。仍不可上线；升级已有实例须备份、演练并运行 `pnpm db:migrate`（本次为第 16 条迁移）。

## 2026-11-17：M10 批次一（顾客/会员档案、邮箱 OTP 登录与会员中心）

范围：把「谁是顾客」与「谁是会员」分开建模，并打通一条不依赖密码的会员身份链路；访客结账完全不受影响。

- 第 17 条迁移 `202611170016_members`：新增 `Customer`（规范化邮箱全店唯一，可无会员档案）、`MemberProfile`（一人一会员、会员号 `MB-日期-6位`、closed 终态）、`MemberOtpChallenge`（只存邮箱 HMAC 与验证码 HMAC，邮箱原文只以 AES-GCM 密文存在，且 AAD 绑定挑战行）、`MemberSession`（cookie 只带随机 token，库里只有 SHA-256 摘要，撤销状态与撤销时间必须同时成立）、`OrderMemberLink`（追加事实，主键 `(orderId, memberId)`，不级联删除）。`IdentityNotificationJob` 增加 `otpChallengeId`，并把 `kind` 与目标列的配对约束收紧到三选一。
- 域规则 `packages/domain/src/members.ts`：邮箱规范化（小写去空白）、OTP 策略（10 分钟有效、60 秒冷却、每小时 5 次、5 次错误作废、会话 12 小时）、挑战响应统一形状、会员号、顾客写入「清空 vs 不修改」语义、会员状态机。
- API：`POST /storefront/member/otp/{request,verify}`、`POST /storefront/member/logout`、`GET /storefront/member/{profile,orders}`；后台 `GET/POST /admin/customers`、`GET/PATCH /admin/customers/:id`、`GET/POST /admin/members`、`PATCH /admin/members/:id`。后台读需 `customers.read_masked` / `members.manage`，写加 CSRF + Origin + If-Match；完整邮箱、电话与内部备注只在 `customers.read_pii` 下可见，其余账号只看遮蔽值。
- 会员身份只来自已验证邮箱：挑战通过后按已验证邮箱 find-or-create 顾客与会员，并把同一邮箱的既有访客订单写入 `OrderMemberLink`（`source=email_match`，重复登录不重复链接）；停用会员即撤销其全部会员会话，closed 不可回退。
- Worker 支持 `member_otp`：验证码与收件人同在一段密文里，发送前用挑战行的 `codeDigest` 校验，绑定不符即不发送；过期未用的挑战随任务清扫一并置为 `expired`。

修正的真实缺陷：验证码校验最初在事务内直接抛 401/429，导致「错误次数 +1」和「第 5 次作废」被一起回滚——等价于允许无限次试错。改为事务内先写结果状态、提交后再按结果返回错误码；消耗挑战与建会话仍在同一事务里，重复提交同一挑战拿不到第二个会话。

验证：真实 PostgreSQL 18.7 上 `node --test` 212 项全过（新增会员纯规则 15 项 + 会员 HTTP 端到端 13 项，后者覆盖游客下单→OTP 登录→订单归集、枚举防护、限速/冷却、重放、越权与遮蔽、版本冲突、审计）；契约 37 项、生成物一致、Prisma schema 有效。已部署到 mrinhk（第 17 条迁移，5 张新表就位；生产冒烟：OTP 申请 202、匿名读会员档案 401）。

边界：会员等级与积分台账（`admin/members/:id/points-adjustments`、`tierId`）尚未落地，带 `tierId` 的写入一律 422 `MEMBER_TIERS_UNAVAILABLE`；会员订单只有摘要没有详情页；前台尚无登录/会员中心页面；worker 与 SMTP 仍未启动，因此验证码邮件目前在队列里等投递。

## 2026-11-17：M10 批次二（会员等级与积分台账）

范围：把「会员值多少钱」变成可配置、可审计、可对账的账，而不是散落在订单上的一个数字。

- 第 18 条迁移 `202611170017_loyalty`：`LoyaltySetting`（店铺级单例：开关、多少分换 1 点、积分有效期）、`MembershipTier`（`rank` 与 `code` 各自唯一、按累计消费分档、可覆盖换算率、`retired` 不再参与解析）、`PointAccount`（余额 `CHECK >= 0`）、`PointLedger`（`deltaPoints <> 0`、`balanceAfter >= 0`、`idempotencyKey` 全表唯一，触发器拒绝 UPDATE/DELETE）。`MemberProfile` 增 `tierId` 与 `lifetimeSpendMinor`。
- 域规则 `packages/domain/src/loyalty.ts`：积分**只用整数**（金额分 ÷ 换算率，向下取整，零头不预支）；等级按 `rank` 解析而不是按金额排序（门槛相同时结果仍然确定）；余额不可为负；调整单必须带原因码与原因文本；等级名按语言回退。
- API：后台 `GET /admin/loyalty`、`PATCH /admin/loyalty/settings`、`POST/PATCH /admin/loyalty/tiers`（均 `members.manage`，写入要 CSRF + Origin + If-Match）；`POST /admin/members/:id/points-adjustments`（`points.adjust` + `Idempotency-Key` + 审计）。前台 `GET /storefront/member/points`（本人余额 + 流水分页），`GET /storefront/member/profile` 增等级与积分摘要。
- 发放规则：订单**全部签收完成**时按「当时等级」的换算率发放，只按商品金额（小计减折扣）计算，运费税费不积分；累计消费与等级归属同事务推进，等级升级只影响之后的订单。幂等键 `order:{id}:earn`。
- 等级写入：`tierId` 只认 `active` 等级，未知 422 `MEMBER_TIER_UNKNOWN`、退役 422 `MEMBER_TIER_RETIRED`、显式 `null` 表示清空归属；退役等级不主动清空既有会员归属。

修正的真实缺陷：**登录后下的单不会归到会员**。批次一只在 OTP 验证成功时按邮箱回填历史订单，结账链路完全不看会员 cookie，于是「先登录再下单」的订单在会员中心看不到、也不积分。现在结账读取可选会员 cookie 并写入 `OrderMemberLink`（`source=checkout`）；会员会话过期或被撤销时静默降级为访客订单，不阻断结账。

验证：真实 PostgreSQL 上 `node --test` **235/235 全绿**（新增等级/积分纯规则 13 项 + HTTP 端到端 9 子测：口径版本冲突、rank/code 冲突、未知等级拒绝、调整幂等与键复用冲突、扣成负数被拒、流水不可改删、缺 `points.adjust` 403、会员只读自己的账、下单→发货→签收→发放→自动升级等级、退役等级不再接受新分配）；契约 37 项、生成物一致、Prisma schema 有效。已部署 mrinhk（第 18 条迁移，4 张新表 + 追加式触发器就位；生产冒烟：`admin/loyalty` 匿名 401、`storefront/member/points` 匿名 401、首页 200）。

边界：积分兑换与优惠券抵扣尚未接入（`entryType` 已留 `redeem`/`expire`/`reversal`，但没有产生它们的业务动作）；退款/取消的按比例扣回要等 M08 退款事件；积分有效期只有配置字段没有到期清扫任务；后台尚无等级与积分页面（接口已就绪）；前台仍无登录/会员中心页面；worker 与 SMTP 未启动，验证码邮件仍在队列里等投递。

## 2026-11-17：M10 批次三（前台会员登录与会员中心）

范围：把已经存在的会员接口变成顾客真的能用的页面。前两批只到接口层，前台既没有登入口，也没有任何地方能看到自己的订单与积分。

- 前台新增 `/login`：邮箱 → 6 位验证码两步。第一步只收邮箱，第二步显示掩码邮箱、验证码剩余时间与重发倒计时；`已登录` 访问直接给入口提示而不是再显示表单。
- 前台新增 `/member`：会员号、等级、积分余额、累计消费、积分流水、订单摘要（订单号/日期/状态/付款/金额）与登出；未登录显示登入引导。三个数据源分开取（profile / orders / points），任何一块失败不影响其余展示。
- 页头新增会员入口（未登录「登入」、已登录「會員中心」），结账摘要加一行提示：登录后订单会归入会员账户（不登录也能结账）。
- `lib/member-client.ts`：会员 CSRF 与购物袋 CSRF 完全分离（前者的令牌来自响应体并派生自会话 token，后者是双提交 cookie）；令牌存 `sessionStorage`，且每次 `profile` 成功都会刷新一次，所以刷新页面、开新标签都不会丢登出能力。
- 顺带修掉 `globals.css` 里两处 `box-shadow: var(--shadow)` —— 变量从未定义，浏览器会把整条声明作废，购物袋表格与结账侧栏一直没有阴影（静默失效，很难在代码评审里看出来）。

两个由这次前端工作暴露出来的接口缺陷（都已修）：

1. **刷新后无法登出**。会话 CSRF 原本只在 `verify` 响应里下发一次，页面一刷新就丢，登出按钮变成永远 403。`GET /storefront/member/profile` 现在也返回 `csrfToken`（会话派生，同源才读得到），前端每次读档案即恢复。
2. **重发验证码后旧码仍然有效**。同一邮箱可以同时存在多个 pending 挑战，用户重发一次，上一封邮件里的验证码还能用 10 分钟，等于把一份有效凭据多留在外面。现在申请新码时会把该邮箱此前未用的挑战置为 `expired`；worker 只投递 pending 挑战，被取代的旧码连同它的通知任务一起失效。

验证：真实 PostgreSQL 上 `node --test` **236/236 全绿**（会员 HTTP 端到端 15 子测，新增「profile 下发的 CSRF 与会话一致」「重发使旧码失效、新码仍可用」两项）；契约 37 项、生成物一致；前台 `next build` 通过并生成 `/login`、`/member`；已部署 mrinhk（`ad69456`），生产冒烟：`/login`、`/member`、`/cart`、`/products` 均 200，匿名 `storefront/member/profile` 401，页头会员入口指向 `/login`。

边界：worker 与 SMTP 仍未启动，验证码邮件目前只在队列里等投递，所以**线上登录闭环还差最后一步**（页面与接口都已就绪，补上 SMTP 凭据并起 worker 即可）；登录页没有图形验证码，防刷依赖 IP 限速 + 邮箱 60 秒冷却 + 每小时 5 次；会员中心只读，尚无地址簿、改资料、积分兑换。

## 2026-11-17：M10 批次四（后台会员与积分页面）

范围：把批次二已经在跑的后台接口变成店铺真的能用的页面，并补上「看账」这个动作。此前等级与积分只有接口，店主改口径、分等级、查会员积分都得靠手写请求。

- 新增 `GET /admin/members/{id}/points`（`members.manage`，`/admin/members/{id}/points-adjustments` 之前一直缺读侧）：返回会员摘要（会员号、状态、等级、累计消费、顾客姓名与邮箱）、余额、账户状态、当前换算率与最近流水（`limit`/`cursor` 分页）。邮箱与顾客模块同口径——有 `customers.read_pii` 才是原文，否则是掩码。**读只要 `members.manage`，改才要 `points.adjust`**：能看见账不等于能改账，反过来也一样。
- 后台新增 `/admin/members`（`members-console.tsx`）：积分口径（开关、换算率、有效期，带 `If-Match` 版本控制）、等级阶梯（列表 + 新建 + 选中编辑，`rank`/`code` 冲突分码提示，退役不清空既有归属）、会员列表（分页「加载更多」）、选中会员的余额与流水，以及人工调整（必须带原因码与原因说明）。
- 人工调整的幂等键跟着「这次意图」走：换会员或提交成功才换新键，网络失败后重试沿用同一个键，所以重试不会变成两次加减；`IDEMPOTENCY_KEY_REUSED` 单独提示「同一个键被用于不同请求」。
- 各后台页页头补「会员与积分」入口（员工与角色、店铺设置两页按 `members.manage` 条件显示），否则新页面没有入口。
- 契约：新增 `/admin/members/{id}/points`（`operationId: getAdminMemberPoints`；最初写成 `getMemberPoints` 与前台会员积分操作重名，契约测试的 operationId 唯一性检查当场拦下），重新生成 `generated/api.d.ts`，37 项契约测试全绿。

验证：真实 PostgreSQL 18.7 上 `node --test` **237/237 全绿**，新增子测覆盖「`members.manage` 可读账且无 PII 时邮箱为掩码」「只有 `points.adjust` 读账 403」「未知会员 404」「非法 id 422」；契约 37 项、生成物一致、根 `tsc` 与后台 `tsc --noEmit` 通过、后台 `next build` 产出 `/admin/members`；新增 `e2e/members.spec.ts` 3 例 × 桌面/移动两个项目，后台端到端 **66/66 通过**（断言提交的是「读到的版本」`If-Match: "4"`、调整带幂等键、无 `points.adjust` 只读不给表单、无 `members.manage` 只见提示）。已部署 mrinhk（`2b744e6`），生产冒烟：`admin.mrinhk.com/admin/members` 200 且页头出现新入口，匿名 `admin/loyalty`、`admin/members`、`admin/members/:id/points`、`storefront/member/points` 均 401。

写 e2e 时踩到的一个测试环境问题（不是产品缺陷）：Edge 的移动模拟在超长页面底部的元素上会把点击坐标算偏——`document.elementFromPoint` 命中的确实是按钮本身，但 CDP 派发的点击落到上方某个 `<small>` 上，于是 `click()` 一直报「被 small 拦截」。调整表单在页面最下方正好触发，桌面项目正常。移动项目改为「聚焦按钮 + 回车」（真人可用路径），并在用例里写明原因，避免以后有人用 `force: true` 把它掩盖过去。

边界：页面只做单店口径，没有等级「删除」（只有退役）；积分兑换、优惠券抵扣、退款按比例扣回与到期清扫仍未接入；会员中心仍只读；worker 与 SMTP 仍未启动。

## 2026-11-17：M10 批次五（积分到期）

范围：把「积分有效期」从一列配置变成会真的发生的事。此前 `pointsExpiryMonths` 只是个数字，没有任何代码让它生效——积分一旦入账就永远可用。

- 第 19 条迁移 `202611170018_point_expiry`：`PointLedger` 增 `expiresAt`，CHECK 限定**只有 `earn` 行能带到期时间**（人工补发是补偿，不随配置过期），并按到期时间建部分索引。
- 口径：到期是**发放时的快照**，不是读取时的配置——入账时按当时的有效期写死 `expiresAt`，之后改配置只影响新发的积分（与「规则变更只影响未来计算」一致）。有效期为空时入账的积分永不过期。
- 到期不是删除：清扫为每笔到期的发放追加一条 `entryType='expire'` 流水（`deltaPoints` 为负、`sourceRef` 指回原发放、`reasonCode='points_expired'`、幂等键 `expire:{原发放 id}`），余额从不清零重记，账面全程可对。
- **懒清扫**而不是定时任务：凡是读余额（会员档案、会员流水、后台看账）或改余额（订单发放、人工调整）的地方，都先在同一个事务里跑一遍 `sweepExpiredPointsInTx`。原因是生产的 worker 还没起——「账上还有多少点能用」任何时候被读到都必须是对的，不能依赖一个可能没在跑的任务。
- 先进先出：扣减永远先消耗最早的积分，所以到期也只作用于「最早的、还没被扣掉的那部分」；`dueExpiry` 是纯函数，逐条可断言。

修正的真实缺陷：**第一版把 expire 流水当成普通扣减参与先进先出**。清扫一次之后，下一轮读取时那条 expire 会先去吃更早的人工补发，于是同一笔发放被再次判定为到期，插入时撞上幂等键唯一约束——会员中心的积分页直接 500（测试里就是这么炸出来的）。现在 expire 只冲销 `sourceRef` 指向的那一笔，找不到就不动别人的积分；新增的纯规则用例把这个场景钉住了。

验证：真实 PostgreSQL 18.7 上 `node --test` **242/242 全绿**（新增 4 项到期纯规则：快照语义、FIFO 跨笔溢出、expire 冲销自身、孤儿 expire 不误伤；1 项 HTTP 子测：新会员按旧时间入账 → 会员端读到余额 300 且流水首条是 -200 的 expire、档案摘要与流水页一致、重复读不再产生新流水、余额已扣减后扣 400 被 409 拒绝、后台读同一笔账数字一致）；契约 37 项、Prisma schema 有效、根与后台 `tsc` 通过、前台与后台 `next build` 通过。

边界：没有独立的定时清扫任务（懒执行已覆盖所有读/写路径，但「没人访问就不清扫」——余额在库里暂时偏高，下次读取即纠正）；积分兑换、退款按比例扣回仍未接入（要等 M08 退款事件）；worker 与 SMTP 仍未启动。前台会员中心补了一句有效期的中文说明。

## 2026-11-17：M10 批次六（顾客资料请求工作台）

范围：M10 首期范围第 11 条「顾客资料请求处理」此前只有契约、没有任何实现——`/admin/privacy-requests` 四个接口一律 404。这一批把受理与审批的骨架建起来：谁能受理、谁必须核验、什么时候不许处置、超期了怎么看见。

- 第 20 条迁移 `202611170019_privacy_requests`：`CustomerPrivacyRequest` + `PrivacySetting` 单例。四条边界写进数据库 CHECK：核验状态与「方法/时间/核验人」互为充要；`approved`/`completed` 必须已核验；`completed` 与 `completedAt` 互为充要；进入决定状态必须有决定时间与原因。`idempotencyKey` 全表唯一。
- 状态机（`packages/domain/src/privacy.ts`）：`received` → `verified` → `approved` → `completed`，另有 `needs_information`（等顾客补材料，补完直接决定，**不重新核验**——人还是那个人）与 `rejected`。未核验也能拒绝（明显骚扰件），但拒绝不接触任何资料；终态不回退、不跳级。
- 到期是**受理时的快照**：`receivedAt + PrivacySetting.dueDays`（默认 30 天）。改口径只影响新受理的请求；逾期只影响排序与提醒，不会自动变成已完成或自动拒绝。
- 接口（7 个）：队列 `GET /admin/privacy-requests`（`status`/`overdue` 过滤、按到期排序、给出未结案与逾期数、附当前口径）、受理 `POST`、详情 `GET`（含处理历史）、改负责人/延期 `PATCH`（`If-Match` + 理由）、核验 `POST /verify`（`privacy.verify` + 幂等键 + 可选 `customerId`）、决定 `POST /complete`（`privacy.process` + 幂等键）、口径 `PATCH /admin/privacy-settings`。
- 权限刻意拆成四段互不包含：`privacy.manage`（受理/延期/口径）、`privacy.read`（队列与详情）、`privacy.verify`（核验）、`privacy.process`（决定）。`privacy_specialist` 预设只有前三段——所以隐私专员核验完的请求必须由另一角色批准，这是角色层面的分离。
- 处理历史不另存一份：详情页读的是 `AuditLog` 里 `privacy.*` 的行，与「审计记录」页是同一份事实，避免两份记录对不上。
- 删除/匿名化标记完成时必须填 `retentionExceptionRef`：订单、支付、售后是交易事实，不随请求消失；没有依据的「已完成」只是一句话。
- 后台新增 `/admin/privacy`（`privacy-console.tsx`）：口径、筛选（状态/只看逾期）、队列、受理表单、详情、核验、决定、延期、处理历史；店铺设置、员工与角色、会员与积分三页按 `privacy.read` 条件补入口。

验证：真实 PostgreSQL 18.7 上 `node --test` **264/264 全绿**（新增 12 项纯规则 + 9 个 HTTP 子测：未核验批准/完成 409、拒绝无需核验、核验幂等重放不推高版本、重复核验 409、幂等键跨请求复用 409、删除完成缺保留依据 422、批准与完成分两步且分别记录审批人、口径快照与延期版本控制、逾期排序与计数、详情只给有 `customers.read_masked` 的账号顾客姓名）；契约 37 项、生成物一致、根与后台 `tsc`、后台 `next build` 产出 `/admin/privacy`、后台端到端 **70/70**（新增 `e2e/privacy.spec.ts` 2 例 × 桌面/移动）。

边界：本批只做受理与审批，**数据处置本身仍是人工**——导出文件生成（`ExportJob`）、会员资料更正、删除/匿名化改写都还没接；营销退订也没有结构化同意模型可改（现在只有 `MemberProfile.consentRef` 一个自由文本）。`PrivacyRequest.sourceChannel` 没有 `storefront` 自助入口，前台顾客尚不能自己提交请求（首期只承诺后台受理）。

## 2026-11-18：M10 批次七 C（邮件投递自检通道）

范围：真实 SMTP 凭据仍未提供，Worker 已具备投递程序却无法端到端验证。本批给后台一个**不需要真实邮箱、也不发送真实营销邮件**的自检通道：发起一封指定类型的测试任务，走同一条加密入队 → Worker 领取 → SMTP 投递链路，结果掩码留痕。

- 第 21 条迁移 `202611170020_mail_test`：`IdentityNotificationJob` 的 `kind` 配对约束放宽以容纳 `admin_mail_test`，新增 `maskedTarget`（只存掩码收件人，明文只在一次性密文载荷里）。
- Worker 新增 `admin_mail_test` 投递分支：`apps/worker/src/mail.ts` 的 `MailKind` 扩出该类型与三语文案/tag，`notifications.ts` 解密载荷后投递。自检与目标类型共用同一套 AES-GCM + AAD 绑定，密钥不外泄。
- API 新增 `NotificationService.sendTest()/listTests()` 与 `GET/POST /admin/mail/test`：发起（`notifications.manage`）与看结果（`notifications.read`）分开；`targetVersion` 固定为 1 以满足旧任务版本约束。controller 内 `service()` 因与基类重名改为 `mailService()`。
- 后台 `/admin/settings` 增邮件自检卡片（`notifications.read` 可见），可按类型发起并查看掩码目标与投递状态。

修正的真实缺陷：自检任务最初写 `targetVersion: 0`，被旧 CHECK 约束（`targetVersion >= 1`）拒绝，接口 500；改为 1。远程测试环境旧 Prisma Client 不认识 `maskedTarget`，容器内重新 `prisma generate` 后解决。

验证：真实 PostgreSQL 18.7 上邮件自检定向 **13/13**、全量回归全绿；契约 38 项、生成物一致、Prisma schema 有效、后台 typecheck 通过。已部署 mrinhk（第 21 条迁移），生产冒烟 `admin/mail/test` 匿名 401。

边界：**仍无真实 SMTP 凭据，未发送任何真实邮件**；自检通道验证的是队列与 Worker 链路，不是外部服务商可达性。凭据填入实例参数并启动 worker 后才算真实投递闭环。

## 2026-11-18：M10 批次七 A（隐私请求数据处置执行）

范围：批次六把受理与审批建成了骨架，但「标记完成」只是改状态——导出文件、匿名化改写、营销退订都没发生。本批让完成动作在**同一事务内真实改写数据**，且交易事实与审计不可抹除。

- 第 22 条迁移 `202611170021_privacy_disposition`：新增 `CustomerDataExportJob`（加密快照入队、限时下载、下载留审计）与 `CustomerConsent`（按 `customerId + channel + purpose` 唯一的结构化同意状态）；`Customer` 增 `anonymized` 终态。
- 导出：`POST /admin/privacy-requests/{id}/export` 生成顾客/会员/同意的结构化快照，用 AES-GCM 加密（AAD 绑定任务 id）存库，明文不落盘；`GET .../{jobId}` 解密下载并写 `privacy.export.downloaded` 审计。快照挪到另一行即无法解密。
- 匿名化：删除/匿名化请求标记完成时，`anonymizeCustomerInTx` 把顾客姓名改为不可逆掩码、清空邮箱/电话/标签/内部备注、状态转 `anonymized`，会员转 `closed` 且 `consentRef` 记为撤回；订单/支付/售后的交易事实保留，靠必填的 `retentionExceptionRef` 说明依据。
- 营销退订：`withdraw_marketing` 请求完成时，对每个渠道 upsert `CustomerConsent(status=withdrawn)` 并更新会员 `consentRef`，退订变成**可被下游消费**的结构化状态，不再是一句自由文本。
- 权限沿用四段分离；处置动作与 `privacy.request.completed` 一起记审计（审计对象归属到顾客，而非请求，避免处置记录与顾客资料对不上）。

修正的真实缺陷：匿名化事务里对顾客状态写入用了 `Customer` CHECK 不允许的枚举值，改为 `anonymized`；处置审计最初挂在请求 id 上，改为挂在顾客 id，保证「处置了谁」在对账时可追溯。

验证：真实 PostgreSQL 18.7 上隐私定向 **26/26**、全量 **270/270** 全绿；契约 38 项、生成物一致、Prisma schema 有效、后台 typecheck 通过。已部署 mrinhk（第 22 条迁移，两张新表就位），生产冒烟新接口匿名 401。

边界：导出是加密快照下载，不是任意格式的合规文件包；匿名化不可逆、无恢复路径（设计如此）；前台顾客仍不能自助提交资料请求（首期只承诺后台受理）。

## 2026-11-18：M10 批次七 B（积分兑换结账抵扣）

范围：积分此前只能发放、调整、到期，没有「花出去」的业务动作。本批把积分抵扣接入报价与下单，让账面积分真正能结账用。

- 第 23 条迁移 `202611170022_points_redemption`：报价表冻结 `pointsRequested/pointsRedeemed/pointsValueMinor/pointsMemberId/pointsRuleVersion`，订单表快照 `pointsRedeemed/pointsValueMinor/pointsMemberId/pointsRuleVersion`；换掉旧的总额恒等式 CHECK 为含积分项的版本（`total = subtotal - discount - pointsValue + shipping + tax`），新增列全部 `DEFAULT 0`，既有订单的等式与新约束等价——**旧数据可直接升级，无需回填**。
- 域规则：`packages/domain/src/loyalty.ts` 新增 `redeemPoints`（按余额与商品金额双重封顶，请求超额收敛到可抵扣上限并标记 `cappedByAmount`，余额不足是明确拒绝而非静默少扣）；`checkout.ts` 的 `assertQuoteMath` 纳入积分抵扣项。固定 `LOYALTY_REDEEM_RULE_VERSION`，账面可解释。
- 报价：`POST /storefront/checkout/quote` 接受可选 `pointsToUse`，登录会员按余额与商品金额封顶冻结实扣点数与换算金额，未登录携带该参数 401；下单读报价快照、同事务扣减（会员级 advisory lock + 先扫到期 + 幂等键 `order:{id}:redeem`），过期的点不能拿来抵扣。
- 返还：取消订单与整单退款在同一事务补回实扣点数（追加 `entryType='reversal'` 流水，不改写原扣减行，幂等键 `order:{id}:points_refund`）。补偿积分不设到期。
- 前台结账页新增积分抵扣输入，展示请求点数、实扣与折算金额；报价与下单响应带积分快照字段。契约与 `test_contract.py` 同步新增字段与校验。

修正的真实缺陷：返还流水最初写 `entryType='refund'`，被 `PointLedger_entryType_check`（仅允许 earn/adjust/redeem/expire/reversal）拒绝导致取消订单 500；改为 `reversal`（冲销语义、正数流水可再次消费且不带到期日）。总额恒等式迁移第一次漏掉重建两条旧 CHECK，抵扣订单会被旧约束拒绝；补齐后再跑全绿。

验证：真实 PostgreSQL 18.7 上结账与积分定向 **55/55**、全量 **272/272** 全绿；契约 38 项、生成物一致、Prisma schema 有效、前台与后台 typecheck 通过。已部署 mrinhk（第 23 条迁移），生产冒烟：前台 `/checkout` 200、新 API 匿名受保护。

边界：部分退款按比例扣回积分未接（当前仅整单退款/取消返还）；积分兑换不找零（超额部分收敛为少扣，不产生现金找补）；worker 与 SMTP 仍未启动，验证码邮件仍在队列里等投递。

## 2026-11-18：批次七收尾（全量回归、部署与冒烟）

- 全量真实 PostgreSQL 18.7 回归 **272/272** 全绿；契约 38 项、生成物一致、Prisma schema 有效、前台/后台 typecheck 通过。
- C/A/B 三个提交（`67a3264`/`7935f15`/`ad69133`）已推送 origin/main，生产服务器快进合并到 `ad69133` 并一键部署：备份库 → 重建 api/admin/storefront 镜像 → migrate 容器依次应用第 21/22/23 条迁移 → 健康检查通过。
- 生产冒烟：`mrinhk.com` 首页、`/cart`、`/login`、`/member`、`/checkout` 均 200；`admin.mrinhk.com/admin/privacy`、`/admin/members`、`/admin/settings`、`/admin/login` 均 200；`admin/mail/test`、`admin/privacy-requests` 匿名访问 401；`health/live` 200。生产库确认 `CustomerConsent`、`CustomerDataExportJob` 两张新表就位。
- 部署回滚点已由脚本打上 `:prev` 镜像标签；数据库迁移只前进，回滚不还原数据结构。

## 2026-11-18：M11 会员解锁（会员专属券、会员身份限额、批量发放）

范围：M11 首期把三件事挂起等 M10 会员目录落地——顾客限额只能走 HMAC(联系方式)、会员专属券一律 422、批量发放一律 422。M10 现已完成，本批把这三处占位换成真实实现。

- 第 24 条迁移 `202611170023_coupon_member_audience`：新增 `CouponBatch`（批次券、渠道、冻结收件人数、名单/筛选二选一、pending/issued 状态与确认数互锁、批次级幂等键）；`CheckoutQuote` 增 `couponCustomerKey`——报价时冻结「用哪个主体算限额」，否则报价按会员试算、下单按访客联系方式核销会把同一人算成两个。
- 会员专属券：`assertTiers` 从「一律 422 MEMBER_TIERS_UNAVAILABLE」改为校验等级真实存在且 active（未知 422 `MEMBER_TIER_UNKNOWN`、退役 422 `MEMBER_TIER_RETIRED`）；报价时 `assertMemberTierEligible` 要求会员当前等级命中券的 `memberTierIds`（访客/等级不符 409 `COUPON_MEMBER_ONLY`）；下单再复核一次，防止报价后会话失效或等级被改仍沿用专属折扣。
- 会员侧限额：`customerKey(contact, memberId)` 在登录会员场景走 `memberHmac(instanceId, memberLimitMaterial(instanceId, memberId))`（64 位十六进制，与访客联系方式摘要同形、共存一列），同一会员跨邮箱/改电话仍是同一限额主体。报价算一次冻结到 `couponCustomerKey`，下单原样沿用，换人登录或改联系方式都不能转移额度归属。
- 批量发放：建批 `POST /admin/coupon-batches`（`coupons.issue`）把名单/筛选解析成具体会员 id 并冻结人数；发放 `POST /admin/coupon-batches/{id}/issue` 必须回传与冻结人数一致的 `confirmedRecipientCount`（不符 409 `BATCH_RECIPIENT_COUNT_CHANGED`），批次级锁 + issued 状态幂等，重复确认不二次写入与审计。名单含不存在会员 422 `BATCH_MEMBER_UNKNOWN`。
- 契约：新增 `CouponBatch`/`CouponBatchEnvelope`/`CouponBatchSuccess`，两个批次端点从通用 Created/Accepted 改为具体响应；`memberTierIds` 描述从「无目录时拒绝」改为等级校验语义；新增契约测试校验批次状态互锁与「报价请求不能伪造 couponCustomerKey」。契约 39 项。
- 后台 `/admin/coupons`：创建券可勾选会员等级（读 `admin/loyalty` 的 tiers，无 `members.manage` 时留空不阻断）；新增批量发放区（选券、渠道、会员 ID 列表 → 建批冻结人数 → 按人数复核确认发放）；错误码提示同步为新语义。

修正的真实缺陷：建批时把 `recipientFilter: null` 显式写库，Prisma 落成 jsonb `null` 而非 SQL NULL，撞上「名单与筛选二选一」CHECK（500）——改为只在有筛选时写该列。测试侧修正：等级码受 `^[A-Z0-9][A-Z0-9-]{0,39}$` 约束（旧的随机 UUID 小写片段非法）、等级 rank 必须在 1–100 且唯一（原随机大整数非法）、旧的 `MEMBER_TIERS_UNAVAILABLE` 断言改为 `MEMBER_TIER_UNKNOWN`、会员限额测试购物车金额要满足券的最低消费。

验证：真实 PostgreSQL 18.7 上优惠定向 **26/26**、全量 **278/278** 全绿；契约 39 项、生成物一致、Prisma schema 有效、前台/后台 typecheck、后台生产构建通过；浏览器端到端 **72/72**（新增会员等级勾选与批量发放确认 2 例 × 桌面/移动）。已部署 mrinhk（第 24 条迁移），生产冒烟见下。

边界：批量发放目前冻结的是「发给谁、多少位」，渠道 account_only/email/sms 已记录但未接真实通知投递（worker 与 SMTP 仍未起，与邀请/OTP 邮件同等待投递）；筛选发放支持按会员等级，不支持更细的消费/地域分群；专属券只按「当前等级」判定，等级是发放时的动态状态而非下单快照（券折扣金额本身仍由报价快照冻结）；部分退款按比例扣回积分仍未接。

## 2026-11-18：M14 经营报表（服务端权威数据聚合 + 受控导出，第一批）

范围：M14 分两批。本批先落地不依赖前台埋点的「交易经营报表」——只从 Order/OrderItem/Payment/Refund/CouponRedemption/Inventory/Member/PointLedger 做服务端只读聚合；网站访问漏斗与陈列效果分析（第二方事件、曝光/点击/加购归因）需先建第一方采集与埋点 SDK，留待第二批。

- 契约：`ReportKey` 参数与 `ReportExportRequest.reportKey` 改为 8 项闭集（`sales_summary`/`orders_by_status`/`orders_by_payment`/`orders_by_method`/`product_sales`/`inventory`/`coupons`/`members`）；新增 `ReportResult`/`ReportRow`/`ReportCoverage`/`ReportEnvelope`/`ReportExport`/`ReportExportEnvelope` schema，三个报表端点改用具体响应；新增 `GET /admin/report-exports/{id}/download`（text/csv，`reports.export`）。`ReportRow.dimensions` 用 `propertyNames` 闭集在契约层阻断联系方式等 PII 维度键。契约测试 +3 项，共 42 项。
- 领域规则 `packages/domain/src/reports.ts`：指标口径版本、`localDay`（Intl 按时区归属本地日）、半开区间 `within`、整数分求和、`ratio`（经营聚合）与 `smallSampleRatio`（P1 陈列/漏斗小样本保护，样本 < 20 返回 null）、`RowAccumulator`、CSV 转义（RFC 4180 + 对 `=+-@` 起始单元格前置单引号防公式注入）、导出前导注释（筛选/时区/币种/口径版本/数据覆盖）。
- 服务端 `apps/api/src/reports/{service,controller}.ts`：八类报表聚合；权威时间各取所需（下单 `placedAt`、收款 `paidAt`、退款 `executedAt`、注册 `joinedAt`、积分 `createdAt`）；金额按币种分行、绝不跨币种相加；销售汇总附按店铺日的趋势行。导出受 `reports.export` + CSRF + Idempotency-Key 保护，同步生成 CSV 落库并记审计；下载校验任务状态与 30 分钟过期。xlsx 首期明确 422 拒绝，不静默生成伪装文件。
- 第 25 条迁移 `202611170024_report_exports`：`ReportExport` 表（幂等键唯一、状态与完成时间互锁 CHECK、结果无 PII 故以明文存储聚合 CSV）。
- 后台 `/admin/reports`：报表选择、时间/时区/市场/付款方式筛选、合计与分组表格、CSV 导出与短时下载；按 `reports.view`/`reports.export` 控制可见性；六个运营页导航加「报表」入口。

口径要点：订单数按成功创建计（含之后取消），取消/退款额另列；已收金额只计 `succeeded`/`collected` 与 COD `collected`，待收 COD/unknown/failed 不计；净销售额 = 已收 - 成功退款，配送费/税/积分抵扣分别展示不与商品额混加；报表与导出共用同一筛选规范化与口径版本，导出文件写明筛选、时区、币种、口径版本与覆盖率。

验证：契约 42 项、生成物一致、Prisma schema 有效、前后台 typecheck 与后台生产构建通过；真实 PostgreSQL 18 顺序全量 **287/287** 全绿（新增报表纯规则 8 项 + HTTP 集成 1 项）；浏览器端到端 **76/76**（新增报表生成/导出与权限提示 2 例 × 桌面/移动）。

边界：本批不含访问漏斗（PV/会话/商品浏览/加购/结账事件）与陈列曝光归因（P1）；积分发放/兑换与会员订单占比为聚合快照，会员级明细不在报表内；导出为同步生成（数据量受单次最大跨度 366 天约束），异步分块与 Excel 原生格式留待后续；worker/SMTP 仍未启动，与既有边界一致。

部署：提交 7c1b569 已推送 origin/main 并部署 mrinhk。`deploy.sh` 备份数据库→快进拉取→重建镜像→`prisma migrate deploy` 应用第 25 条迁移（共 25 条全部成功）→ API 健康→ Caddy/公网 health/live 200。生产冒烟：health/ready 200、前台 / 200、后台 `https://admin.mrinhk.com/admin/reports` 200、报表与导出接口匿名访问 401/403（权限边界正确）。

## 2026-11-18：M14 第二批 访问漏斗（第一方匿名事件采集 + 漏斗报表）

范围：按规格「经营报表先做服务端聚合，访问漏斗随后接入」，本批落地不依赖发布版本埋点的访问漏斗——第一方事件采集 + 五步漏斗报表。P1 陈列效果分析（section 曝光/点击/区块归因、发布版本筛选）明确另行估算，不在本批。

- 事件采集：`POST /storefront/analytics/events`（公开端点 + 双提交 CSRF + IP 限流 + 契约 assert + 店铺开关门控）。事件名闭集 `page_view/view_item/add_to_cart/begin_checkout`，**不含 purchase**（浏览器成交在契约与领域两层拒绝，成交只认服务端订单）。sessionId 是浏览器随机 UUID（不来自购物袋 token/手机号/邮箱）；`AnalyticsEventInput` 在契约层禁 `additionalProperties`，拦住 email/phone/url/customerId 等 PII 字段；source 只收匿名 UTM 桶、拒完整 URL。同意状态必填，未 granted 的事件可落库（可审计）但不进指标。eventId 唯一实现幂等，重复上报忽略。
- 会话与归因：服务端读 HttpOnly `ez_guest_cart` 后由 CartService.locate 解析 cartId 写入 AnalyticsSession（坏/过期 cookie 当无购物袋，不阻断采集）；没有 cookie 的页面浏览也能记，cartId 留空后续回填。成功下单用 `ShopOrder.cartId` join `AnalyticsSession.cartId` 归因到会话，去重计一次——不采信浏览器 purchase。
- 漏斗报表 `funnel`（复用 reports.view）：访问→商品浏览→加购→开始结账→成功下单五步，每步按 sessionId 去重；阶段转化率/总转化率用小样本保护（分母 < 20 显示数据不足）。分组闭集 step/device/source/locale/day（day 按店铺时区归属会话首见日）。筛选 locale/deviceClass/source/marketCode + groupBy；报表与导出共用同一筛选规范化与口径版本 FUNNEL_METRIC_VERSION=1.0。
- 同意与开关：`analyticsEnabled` 加入 FEATURE_FLAGS（默认 false）、PUBLIC_FLAGS 与后台设置页开关；未经批准的追踪不默认启用，服务端独立判断开关（前端判断只是 UX，不是安全边界）。前台 SDK `lib/analytics-client.ts`：随机 sessionId 存 localStorage、告知同意标记 `ez_analytics_consent=granted` 才采集、fire-and-forget（keepalive）不阻塞加购/结账；首页/商品列表/商品详情挂页面浏览，加购成功后再计数、创建报价前上报开始结账。
- 第 26 条迁移 `202611180026_analytics_events`：`AnalyticsSession`（sessionId 唯一、cartId 外键 SET NULL、seen 时间互锁 CHECK）与 `AnalyticsEvent`（eventId 唯一、eventName/consent/device 闭集 CHECK、schemaVersion 格式 CHECK）两表，schema 层无姓名/电话/邮箱/地址/完整 URL/支付凭证列。

验证：契约 44 项、生成物一致、Prisma schema 有效、前后台 typecheck 与后台生产构建通过；分析纯规则 6/6、分析 HTTP 集成（真实 PG）全绿；浏览器端到端报表 6/6（新增漏斗查看用例 × 桌面/移动）；全量真实 PostgreSQL 顺序回归 36 文件 294/294 全绿（历史 287 + 新增分析纯规则 6 + 分析 HTTP 1）。

部署：提交 d50c7dd 已推送 origin/main 并部署 mrinhk。deploy.sh 备份→快进拉取→重建镜像→第 26 条迁移 202611180026_analytics_events 应用成功（共 26 条）→ API 健康→ Caddy/公网 health/live 200。生产冒烟：health/ready 200、漏斗报表匿名 401（权限正确）、采集端点未开开关 403 FORBIDDEN（安全默认：未经批准不采集）、后台 /admin/reports 200 且含「访问漏斗」选项。

边界：首期漏斗为「各步骤独立去重会话数」的近似口径，不做严格有序漏斗（不要求先访问再浏览）；不采集 purchase 浏览器事件；不含 P1 陈列（曝光 50%/1 秒判定、section_click/placement_add_to_cart、稳定 section_key 与发布版本筛选、24h 最后交互归因）；不做跨设备/跨店归因、A/B 实验与因果增量。分析开关默认关闭，需店主显式开启并配合同意告知；预览/员工/沙箱/测试流量过滤与已知爬虫排除留待 P1 一并实现。

## 2026-11-18：M09 承运商状态回传（签名 webhook + 幂等台账 + 服务端履约）

范围：M09 原来只覆盖人工建包裹、授权发货与人工签收；本批补上承运商侧主动回传，让在途/派送/签收状态能回到系统。仍不含自动下单、承运商 API 轨迹聚合与多承运商路由。

- 契约：`POST /webhooks/carriers/{carrierCode}` 为公开端点（`x-authentication: public`），`x-webhook-signature-validation: hmac-sha256`、`x-idempotency: carrier-event-id`。请求体闭集 `eventId/shipmentId/status/occurredAt/trackingNumber/note`，`additionalProperties: false` 阻断邮箱、电话、URL、客户 ID 与内部订单/付款状态；`CarrierWebhookAck` 明确 `received/duplicate/shipmentStatus`。契约测试 +1 项，共 45 项。
- 领域规则 `packages/domain/src/carrier.ts`：状态闭集 `in_transit/out_for_delivery/delivered/exception/returned`；签名覆盖 Unix 秒 + 规范化 JSON（键排序、无空格），五分钟时间窗防重放，签名格式 `v1=<64 hex>`；密钥从实例 `CARRIER_WEBHOOK_SECRETS` JSON 读取，格式异常或未登记一律拒绝，不降级放行；落库只保留 16 位签名前缀。
- 服务端 `apps/api/src/carrier-webhooks/{service,controller}.ts`：先验签再查库（未登记承运商、过期时间戳、错签名分别 404/401）；`carrierCode` 取路径且与包裹已有承运商一致，追踪号双向校验不一致返回 409；事件 ID 唯一 + 行锁串行化，重放返回 `duplicate=true` 且不二次推进；IP 限流与系统审计沿用现有基础设施。
- 履约边界：`delivered` 只对已经由授权员工 `dispatch` 的包裹生效，复用 `OrdersService.applyCarrierDelivery`（与人工签收同一套履约与积分发放逻辑），状态事件记 `actorType=system`；不碰 `paymentStatus`，COD 仍须单独收款。未发货包裹收到 delivered 回调返回 409，不能越过库存授权动作。
- 第 27 条迁移 `202611180027_carrier_status_webhooks`：`CarrierStatusEvent` 台账（eventId 唯一、状态/承运商代码闭集 CHECK、无 PII 列）与 `Shipment.carrierStatus/lastCarrierEventAt`；后台订单详情在包裹列表展示当前回传状态与事件时间线，沿用 `orders.read`。

验证：契约 45 项、生成物一致、Prisma schema 有效、前后台 typecheck 与后台生产构建通过；承运商纯规则 3 项、真实 PostgreSQL HTTP 集成覆盖验签重放/PII/幂等/追踪号冲突/未发货拒绝/delivered 推进/后台读取全绿；全量真实 PostgreSQL 顺序回归 **298/298**（历史 294 + 新增领域 3 + HTTP 1）；浏览器端到端 **78/78**（订单包裹用例桌面/移动各补一条回传展示断言）。

边界：签名回传只证明承运商说过什么，不替代员工的库存扣减与授权；不做自动下单、承运商 API 主动查询/轨迹聚合、路由器由或异常件自动售后（exception/returned 只入台账，需人工处理）；未登记承运商没有 webhook 密钥，配置变化需重启 API；批量发放真实通知投递、SMTP/worker 与 HTTPS 链路仍未启动/验收，与此前边界一致。

部署：提交 5bd72d9（功能）与 3cf69ca（配置透传与部署记录）已推送 origin/main 并部署 mrinhk。deploy.sh 备份数据库→快进拉取→重建镜像→第 27 条迁移 202611180027_carrier_status_webhooks 应用成功（共 27 条）→ API 健康→ Caddy/公网 health/live 200。生产冒烟：health/ready 200、`https://admin.mrinhk.com/admin/orders` 200、承运商回调在未登记密钥时返回 404（安全默认，未配置来源不入库）。另补 `.env.example`/compose 的 `CARRIER_WEBHOOK_SECRETS` 传递项：店主与具体承运商约定共享密钥后写入该变量并重建 API，端点才会验签放行；密钥未配齐前不伪装为已对接。
