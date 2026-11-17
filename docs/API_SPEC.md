# EZSTARTCommerce API 接口契约

> 版本：1.7（开发基线）  
> 状态：路由和主要请求 DTO 已登记到 OpenAPI 3.1 初稿；需在 R1 完成逐操作响应 DTO、权限审查、OpenAPI 语义校验和生成客户端试编译后，才视为接口契约冻结。  
> 关联：[开发执行规格](DEVELOPMENT_SPEC.md)、[数据模型](DATA_MODEL.md)、[模块索引](modules/README.md)。

本文定义前台、商家后台、支付回调和异步任务之间的边界。若新增、删除或改变接口行为，必须同步更新 OpenAPI、权限清单、测试用例及变更记录。API 不允许前端直连数据库。

## 1. 传输与通用约定

| 项目 | 约定 |
|---|---|
| 根路径 | `/api/v1`；商家后台 `/admin/*`、顾客前台 `/storefront/*`、服务回调 `/webhooks/*` |
| 协议 | HTTPS；JSON 使用 UTF-8；上传走短时授权的对象存储地址 |
| 时间 | 请求/响应使用 ISO 8601 UTC 时间；店铺本地时区只用于输入解释及展示 |
| 金额 | 整数最小货币单位与 ISO 4217 币种代码；禁止 JSON 浮点金额 |
| 标识 | UUID；业务单号与内部 ID 分离 |
| 语言 | 后台错误文案由 `Accept-Language` 选择；业务内容显式传 `locale` |
| 请求追踪 | 服务端接收/生成 `X-Request-Id` 并在响应回传；不得包含个人资料或密钥 |
| 并发编辑 | 支持的编辑资源返回 `ETag` 或 `version`；更新时带 `If-Match`/`expectedVersion` |
| 幂等 | 下单、支付/退款、库存调整、导入执行、结算确认、批量发券等写操作必须带 `Idempotency-Key` |

### 1.1 成功响应

单对象：

```json
{
  "data": { "id": "uuid", "version": 3 },
  "meta": { "requestId": "req_..." }
}
```

列表：

```json
{
  "data": { "items": [], "nextCursor": null, "hasMore": false },
  "meta": { "requestId": "req_..." }
}
```

分页默认 25 条、最大 100 条；过滤、字段排序均须在每个操作的 OpenAPI 参数中列白名单。不得把用户提供的排序字段拼接进 SQL。

### 1.2 错误响应与 HTTP 状态

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "商品库存不足，请调整数量。",
    "fieldErrors": [],
    "requestId": "req_..."
  }
}
```

| HTTP | 使用情形 | 客户端处理 |
|---|---|---|
| 400 | JSON/参数格式错误 | 修正请求格式 |
| 401 | 无效、过期或已撤销的会话 | 后台重新认证；顾客按流程验证 |
| 403 | 已认证但权限不足 | 展示无权限，不重试写操作 |
| 404 | 对象不存在或不可见 | 不泄露敏感对象是否存在 |
| 409 | 状态冲突、版本冲突、重复键冲突 | 重新读取并由用户确认后再提交 |
| 422 | 字段或业务规则不满足 | 展示字段错误或可操作业务原因 |
| 429 | 限流 | 使用 `Retry-After`；不得自动无限重试 |
| 500 | 未预期内部错误 | 只显示 requestId，不展示堆栈/内部信息 |
| 503 | 外部服务/系统暂不可用 | 按操作幂等策略有限重试或转人工处理 |

稳定错误码包括：`VALIDATION_ERROR`、`UNAUTHENTICATED`、`FORBIDDEN`、`NOT_FOUND`、`VERSION_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`MARKET_NOT_AVAILABLE`、`PRODUCT_UNAVAILABLE`、`INSUFFICIENT_STOCK`、`QUOTE_EXPIRED`、`PRICE_CHANGED`、`COUPON_INVALID`、`SHIPPING_UNAVAILABLE`、`ORDER_STATE_CONFLICT`、`ORDER_ALREADY_SHIPPED`、`PAYMENT_PENDING`、`PAYMENT_UNKNOWN`、`PAYMENT_AMOUNT_MISMATCH`、`PROVIDER_UNAVAILABLE`、`IMPORT_PREVIEW_STALE`、`OTP_EXPIRED`、`OTP_RATE_LIMITED`、`RATE_LIMITED`。错误文案不是程序判断依据。

## 2. 身份、权限和数据边界

- `/admin/*` 使用安全后台会话；写请求实施 CSRF 防护；高风险行为再次校验 MFA/二次确认策略。
- `/storefront/*` 只读已发布、当前市场可售数据；购物车会话 token 不能授权读取订单或顾客档案。
- 会员接口只访问当前已验证会员本人数据；顾客资料查询/导出/删除另需隐私请求流程。
- 每个后台操作必须同时在 OpenAPI operation、权限码表和测试用例中标明角色/权限；隐藏菜单不构成授权。
- 支付回调使用独立的 provider adapter 路由、签名验真、事件去重和幂等处理；不得使用后台 cookie 认证。
- 订单、支付、退款、库存流水和审计历史为追加记录；API 不提供绕开领域服务任意改状态的通用接口。
- PII 响应按权限遮蔽；日志、错误、分析事件和 webhook 摘要禁止输出 OTP、密码、支付密钥、卡资料及完整银行资料。

## 3. 首期接口目录

下表是 R1 必须实现并逐 operation 写入 `packages/contracts/openapi.yaml` 的路由基线。`:id` 表示 UUID；复合动作采用显式子资源，不能通过 PATCH 任意改状态。

### 3.1 后台身份与店铺配置（M00–M01）

| 方法与路径 | 用途 / 关键输入 | 权限与关键规则 |
|---|---|---|
| `POST /admin/auth/login` | email、password | 限速；校验后创建受保护会话 |
| `POST /admin/auth/mfa/verify` | challenge、TOTP/恢复码 | 一次性 challenge；恢复码只用一次 |
| `GET /admin/auth/session` | 当前会话 | 返回当前员工、权限摘要、MFA 状态 |
| `POST /admin/auth/logout` | 当前会话 | 撤销当前会话 |
| `POST /admin/auth/password-reset` | 邮箱申请，或一次性重设 token + 新密码 | 两种请求都返回统一 202 `requestAccepted`；30 分钟一次性；完成后撤销旧会话并保留 MFA 要求 |
| `GET /admin/users` / `POST /admin/users` | 筛选 / 邀请员工 | `staff.read` / `staff.manage` |
| `GET /admin/users/:id` / `PATCH /admin/users/:id` | 资料、状态、角色；需版本号 | `staff.read` / `staff.manage`；停用同时撤销会话 |
| `GET /admin/roles` / `POST /admin/roles` / `PATCH /admin/roles/:id` | 角色和权限点 | `roles.manage`；不能移除最后一个店主 |
| `POST /admin/users/:id/sessions/revoke` | 撤销员工会话 | `staff.manage`；写审计 |
| `GET /admin/store-config` / `PATCH /admin/store-config` | 品牌、语言、币种、时区、市场和功能开关 | `store.settings.manage`；发布前校验必填配置 |

### 3.1.1 R1 成功响应与身份边界

本批次补齐现有 M00/M01 路由的响应草稿，不表示后台身份生命周期及服务端实现已完成。所有响应仍包在 `{data, meta:{requestId}}` 中。

| 操作 | 响应 data / 行为 |
|---|---|
| `adminLogin` | 200 返回 `AdminSessionData`；需要已登记 MFA 时返回 202 `AdminMfaChallenge`（nextAction=verify_mfa）；强制 MFA 但未登记时返回 202 `AdminMfaSetupChallenge`（nextAction=enroll_mfa）。两者均不产生普通会话 |
| `verifyAdminMfa` | 必须同时具备浏览器的 `ez_admin_challenge` cookie 和 body 中的 `challengeId/code`；消费一次性挑战后返回 200 `AdminSessionData` 并轮换正式会话，清除挑战 cookie |
| `getAdminSession` | 返回实时有效的 `user`、`permissionCodes`、`mfaVerified`、`idleExpiresAt`、`absoluteExpiresAt`、会话绑定的 `csrfToken`；只允许 active 员工，强制 MFA 员工须已登记且已验证 |
| `requestAdminPasswordReset` | 申请和完成均返回 202 `{requestAccepted:true}`；合法申请不暴露邮箱存在性。无效/过期完成 token 返回 422 通用错误；完成后撤销所有会话，不自动登录 |
| 员工列表/详情/邀请/修改 | `AdminUser` 包含 id/email/displayName/locale/status/roleIds/mfaRequired/mfaEnabled/version/lastLoginAt/createdAt/updatedAt；状态为 invited/active/suspended；不返回密码摘要、邀请 token 或 MFA 秘密 |
| `revokeAdminUserSessions` | `{userId, revokedCount, revokedAt}`；撤销当前操作者自己的会话时本响应送达后下一次受保护请求须重新登录 |
| 角色列表/详情/新建/修改 | `AdminRole` 包含 id/name/description/permissionCodes/version/createdAt/updatedAt；列表与员工列表均返回 items/nextCursor/hasMore，并接受 cursor/limit |
| 店铺读取/修改 | `StoreConfiguration` 包含 displayName/locales/defaultLocale/baseCurrency/timezone/marketProfiles/featureFlags/brandAssets/version/updatedAt；品牌媒体 ID 可空；不暴露第三方密钥 |

`AdminMfaChallenge` 必含 `challengeId`、`nextAction:verify_mfa`、`allowedMethods`（totp/recovery_code）及 `expiresAt`。登录 202 按 nextAction 设置短时、HttpOnly/Secure/SameSite=Strict 的 `ez_admin_challenge`（验证）或 `ez_admin_setup`（登记），作用路径 `/api/v1/admin/auth/mfa`，不设置正式后台会话。挑战和浏览器绑定、有效期、一次性消费、重放拒绝由服务端实现；挑战 ID 本身不授予后台权限。密码/MFA 验证入口还须检查精确来源、限速及统一错误，防止登录 CSRF。正式 `ez_admin_session` 为 HttpOnly/Secure/SameSite=Lax，作用路径 `/api/v1/admin`；会话凭据不放入 JSON。响应中 CSRF token 只用于当前会话的受保护写请求，不进入日志/统计。

员工、角色和店铺单对象响应返回 `ETag: "<version>"`；PATCH 带原始 If-Match。版本为正整数，冲突返回 409，不自动覆盖。当前权限而非会话内过期快照决定授权；授予/收紧角色仍受调用者可授权范围、最后一个店主及审计规则约束。

市场响应包含 `reviewStatus:pending|approved|rejected|expired` 和可空 `reviewValidUntil`；`enabled:true` 必须对应 approved。配置写入只接受既有 `MarketProfileInput`，不能直接写审核结论。是否过期、审核依据、交易时再次校验由服务端处理；defaultLocale 必须属于 locales，timezone 必须是有效 IANA 区域，有交易后禁止改基础币种。这些跨字段/时间/数据库约束不能仅靠静态 schema 保证。

### 3.1.2 初始化、邀请、MFA 登记与会话路由

| 方法与路径 | operationId / 请求 | 认证与响应 |
|---|---|---|
| `POST /admin/auth/bootstrap` | `bootstrapAdminOwner`；email/displayName/password/locale | 仅显式开启的首次部署窗口；X-Bootstrap-Token；202 MFA 登记挑战，不返回正式会话 |
| `POST /admin/auth/invitations/accept` | `acceptAdminInvitation`；invitationToken/newPassword | 一次性邀请凭据；非强制 MFA 可返回 200 会话，强制 MFA 返回 202 登记挑战；不允许客户端指定邮箱、角色或用户 ID |
| `POST /admin/auth/mfa/enrollment-authorizations` | `authorizeAdminMfaEnrollment`；currentPassword/currentMfaCode | 正式会话+CSRF；已启用 MFA 时 currentMfaCode 必需且验证有效；202 新登记/重新绑定挑战 |
| `POST /admin/auth/mfa/enrollments` | `startAdminMfaEnrollment`；challengeId | 仅 ez_admin_setup cookie；201 enrollmentId/expiresAt/totpSecret/provisioningUri，不激活因子、不返回会话 |
| `POST /admin/auth/mfa/enrollments/confirm` | `confirmAdminMfaEnrollment`；challengeId/enrollmentId/code | 仅 ez_admin_setup cookie；TOTP 确认后 200 `{session, recoveryCodes}`，消费挑战并轮换正式会话；恢复码只显示一次 |
| `GET /admin/auth/sessions` | `listOwnAdminSessions`；cursor/limit | 本人正式会话；仅返回本人的活跃会话分页 |
| `POST /admin/auth/sessions/:id/revoke` | `revokeOwnAdminSession`；reason | 本人正式会话+CSRF；仅撤销本人会话；跨用户 ID 统一 404；200 sessionId/revokedAt |
| `GET /admin/users/:id/sessions` | `listAdminUserSessions`；cursor/limit | staff.read；读取指定员工活跃会话分页；全量撤销仍使用既有 sessions/revoke 接口 |

会话列表字段为 id/createdAt/lastSeenAt/idleExpiresAt/absoluteExpiresAt/current，不返回原始会话凭据。登记相关 cookie、原子操作、邀请失效、恢复路径及上线前必须执行的攻击/并发用例见 [后台身份生命周期契约](ADMIN_IDENTITY_LIFECYCLE.md)。认证自助操作由当前身份/受限凭据决定资源归属，不新增可授给普通员工的全局身份管理权限。

### 3.1.3 邀请管理与市场审核

| 方法与路径 | operationId | 权限与请求 |
|---|---|---|
| `GET /admin/users/:id/invitation` | getAdminInvitation | staff.read；返回邀请摘要及其 ETag，无邀请时 404 |
| `POST /admin/users/:id/invitation/resend` | resendAdminInvitation | staff.manage + CSRF；reason + 邀请 If-Match + Idempotency-Key |
| `POST /admin/users/:id/invitation/revoke` | revokeAdminInvitation | staff.manage + CSRF；reason + 邀请 If-Match |
| `POST /admin/store-config/markets/:marketCode/reviews` | recordMarketReview | store.settings.manage + 店主身份 + 已验证 MFA + CSRF；If-Match 为店铺配置版本 |

邀请摘要为 id/userId/status/version/expiresAt/lastSentAt/notificationJobId，status 为 pending/accepted/revoked/expired。到期是读取时计算的不可接受状态；过期的未消费邀请可由重发产生新版本/新截止时间。accepted/revoked 不允许重发，需显式重新授权生命周期。重发原子旋转 token 摘要、版本和截止，旧 token 立即失效，并建立带加密短时秘密的通知任务；同幂等键重试返回同一摘要，不再旋转。通知失败重试原任务，不能为了重试发信不断旋转 token。撤销使尚未消费的 token 和未发送任务失效；已经投递的旧链接仍会被服务端拒绝。调用者授权、被邀员工当前角色范围及最后店主约束须在事务中重验。

审核请求为 decision（approved/rejected/revoked）、evidenceReference、reason、validUntil（UTC 或 null）和 confirmedMarketCode。目标码须与路径一致；审核人 reviewedBy 和 reviewedAt 由服务端赋值，不接受客户端伪造；validUntil 非空时必须晚于当前时间。记录是追加历史，响应包含 id/marketCode/decision/evidenceReference/reason/reviewedBy/reviewedAt/validUntil/storeConfigVersion，ETag 为新配置版本。审核通过不自动启用市场；拒绝/撤销/过期立即使交易资格失效，报价和建单时重验，不能等待清理任务。配置响应新增 revoked 状态。此接口记录客户批准的依据，不自行作市场法规判断。

重设申请为 email，完成重设为 resetToken + newPassword，两者共用同一路径并按字段选择校验。申请对存在、停用、冷却中和超限的邮箱一律返回 `{requestAccepted:true}`，不发送即不写重置凭据，响应也不能区分账号是否存在；每次有效申请原子轮换 token 摘要、版本和 30 分钟截止，旧链接立即失效。完成时校验一次性凭据、撤销该员工全部会话与未完成挑战、递增员工版本，但保留 TOTP 因子、恢复码和 MFA 要求；成功不建立登录会话。无效、过期、已消费或已被停用/撤权作废的 token 返回 401。重设通知与邀请共用通知队列，任务在发送前复核目标状态与版本。

安全参数以 [identity-v1](IDENTITY_SECURITY_POLICY.md) 为准，全部 MFA 因子遗失的处理见 [恢复流程](ADMIN_RECOVERY_RUNBOOK.md)。M15 运维与商品之后的电商模块仍待完成（默认岗位权限包随服务启动预置；审计读取、商店设置、市场审核、分类/品牌/商品目录接口已实现）。首店主初始化、MFA 登记/替换/验证、邀请、员工/角色管理、密码重设和本人会话接口已接入 PostgreSQL 18/Prisma 7，并通过真实 HTTP 集成测试，详见 [身份实现说明](R1_IDENTITY_IMPLEMENTATION.md)。TypeScript 客户端仍只封装登录操作。

### 3.2 商品、媒体、内容和陈列（M02–M04）

| 方法与路径 | 用途 / 关键输入 | 权限与关键规则 |
|---|---|---|
| `GET /admin/products` / `POST /admin/products` | 分页筛选 / 建草稿 | `catalog.read/manage`；SKU 本实例唯一 |
| `GET /admin/products/:id` / `PATCH /admin/products/:id` | 多语言、分类、规格、价格、图片；版本校验 | `catalog.manage`；不能覆盖订单历史快照 |
| `POST /admin/products/:id/publish` | 目标市场/发布时间 | `catalog.publish`；三语必填及可售校验 |
| `POST /admin/products/:id/unpublish` | 撤下原因 | `catalog.publish`；前台立即不可购买 |
| `GET/POST /admin/categories`；`GET/PATCH /admin/categories/:id` | 分类树和翻译 | `catalog.manage`；阻止循环父子关系 |
| `GET/POST /admin/brands`；`GET/PATCH /admin/brands/:id` | 品牌信息和翻译 | `catalog.manage` |
| `POST /admin/media/upload-target` | 文件名、MIME、字节数 | `media.manage`；短时上传目标及类型/尺寸限制 |
| `POST /admin/media/complete` | 上传对象 key、校验摘要 | `media.manage`；服务端确认对象后入库 |
| `GET /admin/media` / `GET /admin/media/:id` | 媒体库分页与详情 | `media.manage`；只返回本实例媒体与短时读取链接 |
| `GET /admin/pages` / `POST /admin/pages` | 页面列表/创建草稿 | `content.read/manage` |
| `GET/PATCH /admin/pages/:id` | 页面区块、内容、SEO、版本 | `content.manage`；仅接受主题注册的区块类型 |
| `POST /admin/pages/:id/preview-token` | 语言/设备预览参数 | `content.preview`；短时且不可索引 |
| `POST /admin/pages/:id/publish` | 当前版本、即时/定时发布 | `content.publish`；所有启用语言原子发布 |
| `POST /admin/pages/:id/unpublish` / `POST /admin/pages/:id/rollback` | 撤下/回滚到版本 | `content.publish`；回滚创建新发布版本 |
| `GET/PUT /admin/merchandising/:pageKey` | 获取/保存页面陈列区块、商品选择、排序规则 | `content.manage`；手动优先级限区块作用域 |
| `GET /storefront/config`、`GET /storefront/products`、`GET /storefront/products/:slug` | 公开已发布配置/目录 | 无登录；市场、语言、可售状态过滤 |
| `GET /storefront/categories`、`GET /storefront/pages/:slug`、`GET /storefront/collections/:slug` | 公开目录和陈列 | 仅发布版本；不得返回草稿/预览字段 |

媒体字节的收发不经过业务契约：`upload-target` 返回的短时 URL 指向对象存储，或（本地驱动时）指向 `/api/v1/media/objects?key=&expires=&signature=` 这一存储端点。该端点只认 URL 上的单对象、单方法签名，不读后台会话，也不要求 CSRF；签名过期即失效，且只有已确认（`ready`）的媒体才可读取。因此它不属于 OpenAPI 业务接口，也不承担权限判断。

游客购物袋的身份只来自 `ez_guest_cart` cookie（HttpOnly、Secure、SameSite=Lax、作用域 `/api/v1`）；写接口同时要求 `ez_cart_csrf` cookie 与 `X-CSRF-Token` 头一致（双提交）。该 cookie 只代表一个购物袋，不能读取订单、顾客或后台资源；这些接口不做 Origin 校验，因为前台与 API 可能不同源。

`/storefront/checkout/orders` 的 `paymentMethodCode` 首期只接受配送方式显式开启的 `cod`（货到付款）。没有支付网关时不得接受其他方式，也不得在未收到交易通知前把订单标为已付款。

### 3.3 导入、购物车与结账（M05–M06）

| 方法与路径 | 用途 / 关键输入 | 权限与关键规则 |
|---|---|---|
| `POST /admin/import-jobs` | 文件上传引用、列映射、执行模式 | `catalog.import`；限制格式、行数、文件大小 |
| `GET /admin/import-jobs/:id` | 状态、计数、摘要 | `catalog.import`；长任务异步处理 |
| `POST /admin/import-jobs/:id/validate` | 解析并预览 | 行级错误；校验不改正式商品 |
| `POST /admin/import-jobs/:id/execute` | 确认校验版本 | `Idempotency-Key`；按明确模式全部回滚或有效行部分提交 |
| `POST /admin/import-jobs/:id/cancel` / `GET /admin/import-jobs/:id/error-report` | 取消/下载错误报告 | 权限检查；报告短时有效 |
| `POST /admin/export-jobs` / `GET /admin/export-jobs/:id` | 范围、字段和筛选 / 任务状态 | `data.export`；PII 单独授权、脱敏、限时下载 |
| `GET/POST /storefront/cart` | 取得/创建访客购物袋 | session token；不能包含未发布或不可售商品 |
| `POST /storefront/cart/items` | SKU、数量 | 服务端重新校验数量、市场和库存 |
| `PATCH /storefront/cart/items/:id` / `DELETE /storefront/cart/items/:id` | 调整/移除购物袋行 | 所属购物袋校验；数量变化重新报价 |
| `POST /storefront/checkout/quote` | cart、联系资料、地址、配送、优惠码、语言 | 服务端计算报价；不信任客户端金额；报价默认 15 分钟有效 |
| `POST /storefront/checkout/orders` | quoteId、顾客确认、付款方式 | 幂等；原子复核价格/库存/优惠；返回订单号及付款下一步 |

报价核心结构：

```json
{
  "quoteId": "uuid",
  "expiresAt": "2026-10-17T10:15:00Z",
  "currency": "HKD",
  "lines": [{ "variantId": "uuid", "quantity": 1, "unitPriceMinor": 10000, "lineTotalMinor": 10000 }],
  "subtotalMinor": 10000,
  "discountMinor": 0,
  "shippingMinor": 0,
  "taxMinor": 0,
  "totalMinor": 10000,
  "ruleVersion": "quote-rules-v1"
}
```

创建订单请求不能传入权威的 `totalMinor`。订单创建响应同时返回 `orderId`、公开订单号、订单状态、支付状态和允许展示给顾客的 `paymentAction`，不回传服务商密钥或卡资料。

### 3.4 订单、支付、履约与售后（M07–M09、M16）

| 方法与路径 | 用途 / 关键输入 | 权限与关键规则 |
|---|---|---|
| `GET /admin/orders` / `GET /admin/orders/:id` | 分页筛选/详情 | `orders.read`；联系人按字段权限遮蔽 |
| `POST /admin/orders/:id/cancel` | 原因、expectedVersion | `orders.cancel`；已付款需走退款流程 |
| `POST /admin/orders/:id/address-change` | 新地址、顾客确认依据 | `orders.address.change`；重算配送/差价，发货后禁止直接改 |
| `POST /admin/orders/:id/notes` | 内部备注 | `orders.manage`；只允许内部内容 |
| `POST /admin/orders/:id/shipments` | 包裹行项目数量、承运商/追踪号 | `shipments.manage`；累计不超订单数量 |
| `POST /admin/shipments/:id/dispatch` / `POST /admin/shipments/:id/deliver` | 发货/签收时间与凭据 | 状态合法；发货时写库存流水 |
| `GET /admin/payments` / `GET /admin/payments/:id` | 交易台账/明细（可按 status/orderId/providerCode 筛选） | `payments.read`；状态与金额只由账本与登记动作变更 |
| `GET/PATCH /admin/payment-methods` | 渠道开关、环境及凭证引用 | `payment.config` + If-Match；秘密只存引用，响应仅回 `secretConfigured` 与指纹 |
| `POST /admin/orders/:id/payment-result` | COD 收款/拒收/退回、人工转账到账 | `payments.collect` + CSRF + `Idempotency-Key` + If-Match；金额必须等于订单总额 |
| `POST /admin/refunds` | paymentId、金额、币种、原因 | `refunds.create` + 幂等；不能超过已收可退余额 |
| `POST /admin/refunds/:id/approve` / `POST /admin/refunds/:id/execute` | 审批/执行 | 对应分离权限；阈值审批和二次确认 |
| `GET /admin/settlements` / `POST /admin/settlements/import` | 结算批次/文件摘要 | `settlements.manage`；幂等识别重复文件 |
| `POST /admin/settlements/:id/preview` / `POST /admin/settlements/:id/confirm` | 匹配预览/确认 | 先预览再确认；保存差异和原始行 |
| `POST /admin/settlements/:id/lines/:lineId/resolve` | 差异类型、理由、匹配对象 | `settlements.resolve`；不可覆盖原金额 |
| `POST /webhooks/payments/:provider` | 服务商原始回调 | 仅签名验证、持久化去重、排队处理；快速返回接收结果 |
| `GET/POST /admin/shipping/zones`；`GET/PATCH /admin/shipping/zones/:id` | 配送区域 | `shipping.manage`；阻止非法/冲突区域规则 |
| `GET/POST /admin/shipping/rates`；`GET/PATCH /admin/shipping/rates/:id` | 固定运费/门槛费率 | `shipping.manage`；发布配置版本 |
| `POST /admin/shipping/quote-preview` | 地址/购物袋测试条件 | `shipping.manage`；只预览，不创建订单 |
| `GET/POST /admin/after-sales`、`GET /admin/after-sales/:id` | 案件列表（可按 status/caseType/orderId 筛选）/登记/详情 | `aftersales.read` / `aftersales.manage`；行数量与金额均由服务端复核 |
| `POST /admin/after-sales/:id/approve` / `POST /admin/after-sales/:id/reject` | 审核理由、expectedVersion（`If-Match`） | `aftersales.approve`；批准金额取申请额、行分摊额与订单总额的最小值；取消类批准即取消订单并释放预留后结案 |
| `POST /admin/after-sales/:id/return-shipment` | 承运商、追踪号、寄回时间 | `aftersales.manage`；案件进入 `return_in_transit` |
| `POST /admin/after-sales/:id/receive-return` | 收件时间、参考号、逐行数量 | `aftersales.manage`；累计收件量不得超过批准量 |
| `POST /admin/after-sales/:id/inspect` | 逐行数量与处置（`sellable|damaged|quarantine|scrap`） | `aftersales.inspect`；只有 `sellable` 才写 `onHand` 与库存流水，其余处置只记账不动库存 |
| `POST /admin/after-sales/:id/refund` | 金额、币种、原因（落在案件批准额内） | 建 refund 记录（`requested`），不直接改付款状态 |
| `POST /admin/after-sales/:id/close` | 结案理由 | `aftersales.manage`；尚有在途退款时 409 `REFUND_IN_PROGRESS` |
| `GET /admin/refunds` / `GET /admin/refunds/:id` | 退款台账（可按 status/orderId/paymentId 筛选） | `refunds.read`；退款是与支付分开的记录 |
| `POST /admin/refunds/:id/approve` / `POST /admin/refunds/:id/reject` | 审批理由 | `refund.approve`；申请人不得自批（`403 SELF_APPROVAL_FORBIDDEN`） |
| `POST /admin/refunds/:id/execute` | 凭据、时间、原因 | `refund.execute`；线下渠道必须有 `reference`，线上渠道无适配器时 503 `PAYMENT_ADAPTER_UNAVAILABLE` |

订单读取与订单动作是分开的权限：`GET /admin/orders`、`GET /admin/orders/:id` 只要求 `orders.read`，响应里的联系人按 `customers.read_pii` 决定是否遮蔽（列表恒为遮蔽值）；取消、改址、备注、包裹、发货、签收各自使用 `orders.cancel`、`orders.address_change`、`orders.update`、`shipments.manage`，且都要求 CSRF 与 `Idempotency-Key`（发货另需 `If-Match`）。

取消只释放该订单的库存预留，不改 `onHand`；已收款订单必须走售后退款，接口返回 `409 PAID_ORDER_REQUIRES_REFUND`。改址沿用原配送方式重算运费，费用变化必须带 `customerConfirmationRef`（否则 `422 CUSTOMER_CONFIRMATION_REQUIRED`），任何包裹发出后拒绝（`409 ORDER_ALREADY_SHIPPED`）。发货才扣减 `onHand` 并同步释放 `reserved`；签收只推进履约，不改变付款状态——货到付款订单在收款登记前始终是 `cod_due`。订单预留过期后由清理任务释放，仍处于 `awaiting_confirmation` 的订单会被系统取消（`actorType=system`）。

售后案件不改写订单与付款快照：申请、批准、收件、质检、处置各写本模块自己的表，订单金额与支付台账保持原样，可追溯性由 `AfterSalesEvent` 追加写事件提供。案件状态只进不退（`submitted → under_review → approved → return_in_transit → received_inspection → refund_pending → refunded → completed/closed`），批准时间与批准人、批准金额与批准动作由数据库 CHECK 成对约束——没有批准依据的案件写不进 `approved` 之后的状态。`cancel` 类案件批准即取消订单、释放该订单全部 active 预留并直接结案（已收款返回 `409 PAID_ORDER_REQUIRES_REFUND`，已发货返回 `409 ORDER_ALREADY_SHIPPED`）。

退款是可独立核对的台账，不是对 `Payment` 的原地改写。可退余额按「实收 − 已退 − 在途」计算，并同时校验订单级和流水级两个维度；案件内退款还受批准金额上限约束。进入 `refunded` 必须已有执行动作与执行时间（数据库 CHECK 兜底），`unknown` 没有人工出口。执行人不能是申请人（四眼原则）；线上渠道在没有真实适配器时返回 `503 PAYMENT_ADAPTER_UNAVAILABLE`，不伪造成功，线下渠道必须留下银行水单/现金凭据等 `reference`。

### 3.5 会员、优惠、库存、通知、报表、部署（M10–M15）

| 方法与路径 | 用途 / 关键输入 | 权限与关键规则 |
|---|---|---|
| `POST /storefront/member/otp/request` / `POST /storefront/member/otp/verify` | 邮箱、验证码 challenge | 限速、统一提示；OTP 仅短时有效且不得记录明文 |
| `POST /storefront/member/logout` / `GET /storefront/member/profile` | 登出/本人档案 | 已验证会员会话；只访问本人 |
| `GET /storefront/member/orders` / `GET /storefront/member/points` / `GET /storefront/member/coupons` | 本人订单摘要、积分、优惠券 | 联系人/订单详情按会员可见范围控制 |
| `GET/POST /admin/customers` / `GET/PATCH /admin/customers/:id` | 客户查询/建立/资料更正 | `customers.read/manage`；敏感字段单独授权审计 |
| `GET/POST /admin/members` / `PATCH /admin/members/:id` | 会员资料、等级、状态 | `members.manage`；积分变化另走流水接口 |
| `POST /admin/members/:id/points-adjustments` | 正负积分、原因 | `points.adjust`；幂等且产生账本流水 |
| `GET/POST /admin/privacy-requests` | 队列（`status`/`overdue`/游标，按到期排序并给出未结案与逾期数）/ 受理 | `privacy.read` / `privacy.manage`；受理只记线索，客户名下不落人 |
| `GET/PATCH /admin/privacy-requests/:id` | 详情（含审计同源的处理历史）/ 改负责人或延期 | `privacy.read` / `privacy.manage` + `If-Match`；延期须理由且不得早于受理或超一年 |
| `POST /admin/privacy-requests/:id/verify` / `POST /admin/privacy-requests/:id/complete` | 身份核验/批准处理 | `privacy.verify` / `privacy.process` + `Idempotency-Key`；未核验不得批准或完成，拒绝可；删除/匿名化完成须保留例外依据 |
| `PATCH /admin/privacy-settings` | 受理后到期天数（1–365） | `privacy.manage` + `If-Match`；只影响新受理的请求 |
| `GET/POST /admin/coupons` / `GET/PATCH /admin/coupons/:id` | 优惠规则查询（`q`/`status`/游标）/建立/详情/修改 | `coupons.read` / `coupons.manage`；修改须 `If-Match`，改规则不改历史订单快照；券码冲突 409 `COUPON_CODE_TAKEN`，会员专属规则在无会员目录时 422 `MEMBER_TIERS_UNAVAILABLE` |
| `POST /admin/coupon-batches` / `POST /admin/coupon-batches/:id/issue` | 批次创建/发放 | `coupons.issue`；幂等；营销渠道必须有有效同意；在会员目录（M10）落地前创建与发放一律 422 `MEMBER_AUDIENCE_UNAVAILABLE` |
| `GET /admin/coupons/:id/redemptions` / `POST /admin/coupons/:id/disable` | 核销记录/停用 | `coupons.read/manage`；停用须原因 + `Idempotency-Key`；核销记录只追加，顾客只给 HMAC 摘要前 8 位（`customerRef`），停用不改历史占位/核销 |
| `GET /admin/inventory` | 全部变体的现存/预留/可售与低库存状态（`q`、`variantId`、`lowStock`） | `inventory.read`；`available` 由服务端算，未建库存行的 SKU 也出现（version 0） |
| `GET /admin/inventory/movements` | 只追加的库存流水（`variantId`、`type`、`orderId`、`caseId`、`from`、`to`） | `inventory.read`；类型为闭集，调整与退货入库共用一张表 |
| `POST /admin/inventory/adjustments` | `variantId`、`delta`（非零整数增量）、`reason`、`reasonCode`、`reference`、`expectedVersion` | `inventory.adjust` + CSRF + `Idempotency-Key`；不可 set 现存量，调减不得低于已预留 |
| `GET /admin/inventory/thresholds` / `PATCH /admin/inventory/thresholds` | 低库存阈值列表；单条 `variantId`、`lowStockLevel`、`expectedVersion` | `inventory.read` / `inventory.manage` + CSRF；阈值只影响提醒，`expectedVersion` 在 body 里（0 = 新建） |
| `GET/PATCH /admin/notification-settings` | 通道、模板和语言 | `notifications.manage`；交易与营销分开配置 |
| `GET /admin/notification-jobs` / `POST /admin/notification-jobs/:id/retry` | 状态/有限重试 | `notifications.read/retry`；重发不重放业务动作 |
| `GET /admin/reports/:reportKey` | 时间、时区、维度、筛选 | `reports.view`；响应包含口径版本和生成时间 |
| `POST /admin/report-exports` / `GET /admin/report-exports/:id` | 异步导出/任务状态 | `reports.export`；默认无 PII，限时下载 |
| `GET /admin/audit-logs` | 对象/动作/人员/时间筛选 | `audit.read`；日志不可修改或删除 |
| `GET /admin/health` | 服务存活/就绪摘要 | 不返回秘密、拓扑或详细内部错误；限运维访问 |
| `POST /admin/operations/backup` / `GET /admin/operations/jobs/:id` | 受控备份/作业状态 | 运维授权；操作及结果审计 |

## 3.6 字段级 DTO 契约

下列 DTO 使用 JSON camelCase。未列出的响应字段不得擅自添加敏感资料；请求 DTO 默认 `additionalProperties: false`，未知字段返回 `422 VALIDATION_ERROR`。`PATCH` 仅更新显式提交字段；字段缺省表示不变，显式 `null` 仅在 schema 标明可空时表示清除。时间均为 UTC `date-time`；金额字段为整数最小货币单位，报价/订单内固定一个 `currency`。

### 3.6.1 分页、筛选与编辑版本

| 名称 | 类型 | 规则 |
|---|---|---|
| `cursor` | string，optional | 不透明游标；不能由客户端拼装偏移量 |
| `limit` | integer，default 25 | 范围 1–100 |
| `sort` | enum/string，optional | 各资源单独白名单；无效值 `422 VALIDATION_ERROR` |
| `direction` | `asc\|desc` | 默认由资源定义；仅与白名单排序字段组合 |
| `q` | string，optional | 去除首尾空格；限制长度由 operation schema 具体标注 |
| `If-Match` / `expectedVersion` | ETag/string 或 positive integer | 有版本控制资源必须提交；版本过期返回 `409 VERSION_CONFLICT` 和当前版本号，不自动覆盖 |
| `Idempotency-Key` | string，required on listed writes | UUID 或高熵客户端值；服务端按操作域保存请求摘要和原结果；相同 key 不同摘要返回 409 |

首期输入限制默认值（UTF-8 字符串按 Unicode code point 计数；超限返回 422，不截断）：商品名称 1–160、slug 1–180、SKU 1–64（ASCII 字母/数字开头，后续仅字母/数字/`.`/`_`/`-`；唯一性不区分大小写）、短描述 ≤320、商品描述 ≤50,000、SEO title ≤70、SEO description ≤320；邮箱 ≤254、电话 ≤32、姓名 ≤120、地址行 ≤200；内部备注/操作理由 ≤1,000；结账单行数量 1–99 且不得超过可售库存/变体限制。导入文件大小 ≤20 MiB、≤20,000 数据行、≤100 列；XLSX 宏禁用/拒绝。图片仅接受 JPEG/PNG/WebP，单张 ≤10 MiB；服务端校验解码格式，不依据扩展名/MIME 单独信任。以上限值若因客户数据迁移或主题需求调整，必须以版本化决策更改，不能在前后端各自覆盖。

### 3.6.2 商品、SKU 与公开商品（M03）

`POST /admin/products` 请求体：

| 字段 | 类型/必填 | 规则 |
|---|---|---|
| `baseSku` | string / required | 商品级可选管理编码；如提供，本店唯一 |
| `brandId` | UUID / nullable | 必须引用本实例有效品牌 |
| `categoryIds` | UUID[] / required | 可为空数组；不得重复，均须为有效分类 |
| `status` | enum / server-managed | 创建只接受 `draft`；不能通过普通 CRUD 直接建成 active |
| `marketCodes` | string[] / required | 至少一个已配置市场；市场资格服务端复核 |
| `translations` | TranslationInput[] / required | 每个 locale 唯一；`locale` ∈ 当前启用语言；名称、slug、description、shortDescription、SEO 字段按下方规则 |
| `variants` | VariantInput[] / required | 至少一个可售 SKU；SKU 在本实例唯一 |
| `media` | ProductMediaInput[] / optional | 图片已入库的 `mediaId`、顺序、各语言 alt；只能引用本实例媒体 |
| `attributes` | AttributeValue[] / optional | 属性定义及选项必须已配置；不得由用户传库存数覆盖库存账本 |
| `taxClassRef` | string / nullable | 仅引用已批准税务配置；税务功能关闭时不得自行计算税额 |

`TranslationInput`：`locale`（required，`zh-CN|zh-HK|en` 及以后启用的 locale）、`name`（required，非空）、`slug`（required，当前 locale 唯一）、`shortDescription`、`description`、`seoTitle`、`seoDescription`（后三项可空）。发布校验要求每个启用语言至少有名称、slug、商品页必要描述及规格展示文案；缺少返回 422，`fieldErrors[]` 指出 `field`、`locale` 和 `code`。

`VariantInput`：`sku`（required）、`optionValues`（required object，键为已配置规格 ID，值为有效选项 ID/值）、`priceMinor`（integer ≥ 0）、`compareAtMinor`（integer|null；若不为空不得低于有效售价）、`currency`（必须等于店铺基础币种）、`status`（`active|inactive`）。创建/编辑 DTO 不接受 `onHand`、`reserved` 或 `available`；库存只经 M12 接口更改。

`POST /admin/products/:id/publish` body：`expectedVersion`、`marketCodes[]`、`publishedAt`（缺省立即发布；未来时间按店铺时区输入转换后保存 UTC）。成功返回商品版本、发布状态和 `publishedAt`。`unpublish` body 必填 `reason`。公开商品 DTO 仅含当前 locale 的翻译、可售规格/价格、展示图、库存派生的 `inStock`/`displayStockState`、分类/品牌引用和 SEO；不返回成本、预留数量、员工备注、草稿字段。

### 3.6.3 内容页面和前台陈列（M04）

页面草稿 `POST/PATCH /admin/pages/:id` body：`pageKey`（实例内唯一标识）、`pageType`（由主题注册）、`translations[]`（locale、title、slug、body/blocks、SEO title/description、`indexable`）、`blocks[]`。每个 block 的公共字段为 `id`、`type`（主题注册 enum）、`visible`、`position`、`config`（必须满足该 block type 的注册 schema）。未注册 block、自由 HTML/script/CSS 一律 422 拒绝。`PATCH` 必须带版本。

陈列 `PUT /admin/merchandising/:pageKey` body：`expectedVersion`、`sections[]`；每节包含 `sectionId`、`type`、`visible`、`position`、`titleByLocale`、`source`、`limit`（正整数且不超主题上限）、`sortMode`（`manual|newest|fulfilled_sales_30d|price_asc|price_desc`）、`productIds[]`（仅 manual 必填）、`categoryIds[]`/`collectionId`（按 block schema）。manual 时不接受动态排序规则；动态模式不接受 `manualRank`，后端只返回合格商品并用开发规格的稳定规则补位。

预览 `POST /admin/pages/:id/preview-token` body：`locale`、`viewport`（`mobile|desktop`）、`expectedVersion`；返回一次性/短时 `previewUrl` 和 `expiresAt`，预览不得索引。发布/撤下/回滚操作均须 `expectedVersion`、原因（适用时）和发布模式；定时发布唯一待执行任务，任务回传 `jobId`、绑定 `version`、`scheduledAt`、状态。

Storefront 页面/目录响应不返回草稿；陈列 block 的内容版本和商品资格版本一致。公开资源接受 `locale`、`market`、`cursor`、`limit`、允许的 `sort`；无效/未启用 locale 返回 422，未开放 market 返回 `MARKET_NOT_AVAILABLE`。

### 3.6.4 导入导出（M05）

`POST /admin/import-jobs` body：`fileObjectKey`（授权上传生成）、`fileSha256`、`format`（`csv|xlsx`）、`mode`（`create_or_update_by_sku|create_only|update_only`）、`commitMode`（`valid_rows|atomic`）、`columnMapping`（源列到允许字段的映射）、`localeSet[]`。库存列不映射到商品现存量；库存调整需单独导入类型和 M12 流水。

validate 响应：`jobId`、`fileSha256`、`status`、`totalRows`、`validRows`、`invalidRows`、`newCount`、`updateCount`、`skipCount`、`previewRows[]`（`rowNumber`、`sku`、`action`、`changes[]`、`errors[]`、`warnings[]`）。Execute body 必须带 `confirmedFileSha256`、`confirmedMappingVersion`、`expectedValidRows` 和 `Idempotency-Key`；任一预览数据已变返回 409，执行结果含 `created/updated/skipped/failed` 计数和每行最终状态。`valid_rows` 只逐行提交有效数据；`atomic` 有任一错误不得写入任何行。

导出任务创建 body：`resource`、`filters`、`columns[]`、`locale`、`redactionPolicyVersion`。导出权限必须另行校验，PII 列须权限允许；job 响应仅在完成时返回短时 `downloadUrl` 和 `expiresAt`，不在列表 API 暴露长效对象地址。

### 3.6.5 购物袋、报价与订单创建（M06/M07）

购物袋行 body：`variantId`（UUID）、`quantity`（整数 1–配置最大值）；客户端不提供价格。游客购物袋身份由安全 cookie/header 绑定的随机 session 管理，未登录接口不能访问订单详情。

报价 `POST /storefront/checkout/quote` body：

| 字段 | 类型/必填 | 规则 |
|---|---|---|
| `cartId` | UUID / required | 只接受当前游客会话拥有的 active cart |
| `locale`、`marketCode` | string / required | 必须启用且允许交易 |
| `contact` | object / required | `email`/`phone` 按店铺订单通知配置至少一个有效非空值；两项同时为 null、缺失或只有空白不能报价；字段格式校验，另一非必需项可空 |
| `shippingAddress` | object / required if shipping | 名称、国家/地区代码、省/市、地址行、邮编/电话按市场配送规则 required；地址仅作为报价快照 |
| `shippingMethodId` | UUID / required | 当前地址可用的方法 |
| `couponCode` | string / optional | trim + uppercase；每单最多一个 |
| `memberSession` | cookie-bound / optional | 只能引用已验证会员身份，不接受 body 中任意 memberId |
| `policyAcceptances[]` | object / required as configured | 每项 `{policyKey, version, accepted:true}`；营销同意不作为交易必需项 |

报价响应 `Quote` 必须返回：`quoteId`、`version`（正整数，下单时作为 `confirmedQuoteVersion` 原样提交）、`expiresAt`、`currency`、`lines[]`（商品/规格名称快照、SKU、数量、单位价、行小计、行优惠）、`subtotalMinor`、`discountMinor`、`shippingMinor`、`taxMinor`、`totalMinor`、`shippingMethod`、`couponSummary`（脱敏码/结果）、`ruleVersions`（必填 `price`、`promotion`、`shipping`、`tax`；前三项为版本字符串，未启用税费时 `tax:null`） 和 `warnings[]`。报价 ID 不可修改，15 分钟过期；客户提交金额不采信。

创建订单 `POST /storefront/checkout/orders` body：`quoteId`、`confirmedQuoteVersion`、`paymentMethodCode`、`customerNote`（optional，≤1,000 字符）、`Idempotency-Key`。该请求不接收商品价格、优惠金额、配送费、税额或总额；若提交额外价格字段，按未知字段返回 422 且不创建订单。响应返回 `orderId`、`publicOrderNumber`、订单/支付状态、`currency`、`totalMinor`、`paymentAction`（`type`、安全跳转 URL 或说明，按方法返回）。重复同请求返回同订单，不重复建 reservation 或支付意图。首期未定义访客凭订单号查询完整订单的公开接口；线上付款返回页不能把浏览器回跳视作成功，待确认状态通过交易通知告知顾客；会员只能通过已验证会话查看本人订单摘要。若纳入访客订单查询，必须作为单独变更设计一次性/短时访问凭据、最小字段响应及防枚举用例。

### 3.6.6 订单、包裹、付款和结算（M07–M09/M16）

后台订单详情响应：`id`、`publicOrderNumber`、`orderStatus`、`paymentStatus`、`fulfillmentStatus`、`currency`、金额构成、交易商品/语言/规格快照、付款方式、配送方式/地址快照、优惠快照、`shipments[]`、`statusHistory[]`、`createdAt/updatedAt`。联系人按 `customers.read_pii` 遮蔽；所有状态字段只读，状态变更只能通过显式 action endpoint。

取消 body：`expectedVersion`、`reasonCode`、`reason`、`customerNotified`；已成功付款不得由此接口直接清账/退款，必须走售后退款接口。地址修改 body：`expectedVersion`、`address`、`customerConfirmationRef`（费用变化必需）；已发货请求返回 409 `ORDER_ALREADY_SHIPPED` 并要求走承运商人工记录。

创建 shipment body：`items[]`（`orderItemId`、`quantity` ≥ 1）、`carrierCode`（可空）、`carrierName`（手工承运时可填）、`trackingNumber`（可空）、`note`。提交后累计包裹数不得大于订购量；发货 action 需要 `expectedVersion`，原子扣库存并建立流水。COD 收款登记 body：`outcome`（`collected|rejected|returned`，人工转账另有 `succeeded|cancelled`）、`amountMinor`、`occurredAt`、`reference`、`reason`、`expectedVersion`；金额必须等于订单总额且币种一致，拒收与退回必须写原因，COD 必须已有包裹发货。签收不会自动触发收款，也不会把 `paymentStatus` 改成已收款。

退款创建 body：`paymentId`、`orderId`、`amountMinor`（positive integer）、`currency`（与原支付相同）、`reasonCode`、`reason`、`caseId`（售后关联，可空）、`Idempotency-Key`。响应字段固定为 `id`、`publicRefundNumber`（`REF-YYYYMMDD-XXXXXX`）、`orderId`/`publicOrderNumber`、`paymentId`/`publicPaymentNumber`、`caseId`、`channel`（`cod|manual|online`）、`providerCode`、`environment`、`amountMinor`、`currency`、`status`（`requested|approved|processing|refunded|failed|rejected|cancelled|unknown`）、`reasonCode`、`reason`、`requestedBy`、`approvedBy`/`approvedAt`、`executedBy`/`executedAt`、`reference`（付款凭据）、`externalRefundId`（渠道退款号）、`failureCode`/`failureMessage`、`version`、`createdAt`/`updatedAt`；操作历史读 `GET /admin/refunds/:id` 的追加写 `events[]`（`type`、`fromStatus`/`toStatus`、`source`（`admin|system|provider`）、`actorId`、`occurredAt`）。审批 `POST /admin/refunds/:id/approve` 与驳回 `.../reject` 只接受 `reason` 与 `If-Match`，申请人与批准人必须是两个账号；执行 `POST /admin/refunds/:id/execute` 接受 `reason`、`reference`（线下渠道必填，作为付款凭据）、`occurredAt`。结果未知时只能查/对账，不能无幂等重试。

售后案件 DTO：创建 body 为 `orderId`、`caseType`（`cancel|refund|return|exchange`）、`items[]`（`orderItemId`、`quantity` 1–99）、`reasonCode`（可空）、`reason`、`requestedRefundMinor`（可空）；行数量按同一案件内累计计算，超出可退量 422，非本订单行 422。案件响应含 `publicCaseNumber`（`AS-YYYYMMDD-XXXXXX`）、`publicOrderNumber`、`status`、`source`（`admin|customer`）、`currency`、`orderStatus`、`orderTotalMinor`、`requestedRefundMinor`、`approvedRefundMinor`、`refundedMinor`、`pendingRefundMinor`、`refundableMinor`、`paymentStatus`、`contactMasked`、`ownerId`、`approvedAt`/`approvedBy`、`rejectedAt`/`rejectReason`、`closedAt`、`items[]`（`orderItemId`、`sku`、商品/规格快照、订购/申请/批准/已收/已检数量、`amountMinor`、`disposed`）、`refunds[]`、`returns[]`、`receipts[]`、`inspections[]`、`events[]`、`version`。可退余额由服务端计算并下发，客户端不自行用订单总额推算。审核 body 只含 `reason` 与 `If-Match`；退货寄回 `ReturnShipmentRequest`（`trackingNumber` 必填，承运商/名称/时间/参考号可空）；收件 `receivedAt` + 逐行 `quantity`；质检逐行 `quantity` 与 `disposition`（`sellable|damaged|quarantine|scrap`），只有 `sellable` 会写 `onHand` 与 `return_restock` 库存流水。

支付渠道配置写入 body：`providerCode`、`environment`（`sandbox|production`）、`enabled`、`publicConfig`（白名单字段 `accountSummary|instructions|defaultCurrency|providerAccountRef`）、`secretRef`（必须形如 `secret://`/`env://` 的引用，直接传密钥本体一律 422 `SECRET_REFERENCE_INVALID`）、`approvalReference`。GET 仅返回 `secretConfigured`、`secretFingerprint`、`connectionStatus`、`lastCheckedAt`，不回显引用与密钥。启用必须有批准依据（数据库 CHECK 兜底），停用在该渠道仍有 `pending|authorized|unknown` 流水时返回 409 `PAYMENT_METHOD_IN_USE`。

Webhook 原始 body 由 adapter 验签；进入内部标准事件前，规范字段为 `providerEventId`、`eventType`、`providerTransactionId`、`merchantReference`、`amountMinor`、`currency`、`occurredAt`、`signatureVerified`、`payloadDigest`。客户端不能传 `signatureVerified`；该字段只能由服务端 adapter 产生。成功响应只确认事件已安全接收/去重，不直接暴露订单资料。

结算导入 preview 行字段：`externalReference`、`transactionType`（`payment|refund|fee|adjustment`）、`grossMinor`、`feeMinor`、`netMinor`、`currency`、`settledAt`、`matchStatus`、`differenceCode`。确认操作保存文件摘要、原始行摘要和确认者；人工解决差异 body 必须有 `resolutionCode`、`internalRecordId`（适用时）、`reason`，不允许覆写支付/退款 ledger。

库存 DTO：`GET /admin/inventory` 的每一行是 `variantId`、`sku`、`productId`、`productName`、`productStatus`、`variantStatus`、`onHand`、`reserved`、`available`、`lowStockLevel`、`lowStockVersion`、`lowStockState`（`ok|low|out_of_stock`）、`version`、`updatedAt`；游标是上一页最后一个 `sku`（按键排序，不按时间），所以分页稳定且与业务排序一致。`available = onHand − reserved` 只由服务端计算，客户端不自行相减。`POST /admin/inventory/adjustments` 的响应是 `movement`（`id`、`type`、`quantity`（绝对值）、`stockDelta`（带符号）、`onHandAfter`、`reason`、`reasonCode`、`reference`、`orderId`、`caseId`、`actorId`、`createdAt`）、调整后的 `onHand`/`reserved`/`available`/`version`、`lowStockLevel` 与 `replay`（同一幂等键返回原流水时为 true）。阈值写入用 body 里的 `expectedVersion`（0 表示期望尚无阈值行），与库存版本互不干扰——改阈值不会让库存调整的版本失效。

### 3.6.7 店铺配送、会员、优惠、库存与报表 DTO（M01/M09–M14）

| 资源 | 写入字段 | 约束/响应关键字段 |
|---|---|---|
| 店铺配置 | `displayName`、`locales[]`、`defaultLocale`、`baseCurrency`、`timezone`、`marketProfiles[]`、`featureFlags`、`brandAssets` | 币种/时区需合法；币种变更若已有交易须拒绝；market 含审批状态/可配送区但不能由普通店员自行批准 |
| 配送区 | `code`、`nameByLocale`、`countryCodes[]`、`regionCodes[]`、`priority`、`enabled` | 不能有未处理重叠区域；响应包含版本 |
| 配送方式/费率 | `code`、`nameByLocale`、`zoneIds[]`、`fixedFeeMinor`、`freeAboveMinor`、`currency`、`estimatedMinDays`、`estimatedMaxDays`、`codEnabled`、`enabled` | 首期只支持固定费/金额门槛；不接受重量、件数或承运商自动费率字段 |
| Coupon | `code`、`discountType`（`fixed\|percent`）、`discountValue`（整数最小单位或 1–10000 basis points）、`validFrom`、`validUntil`、`minSubtotalMinor`、`totalLimit`、`perCustomerLimit`、`eligibleProductIds[]`、`eligibleCategoryIds[]`、`memberTierIds[]`、`refundPolicy`（`none\|restore`）、`status` | code trim+uppercase 唯一；范围为空表示全场通用，商品与分类是「或」关系；百分比与固定额都不超过符合条件金额；`memberTierIds` 在会员目录落地前一律 422；响应带 `usage`（`usedCount = 预占+已核销−已返还`）与 `codeMasked`，不回写规则快照 |
| Coupon batch/issue | `couponId`、`recipientMemberIds[]` 或受控筛选、`channel`（`account_only|email|sms`）、`templateId` | 外发 channel 校验营销同意；响应返回计划/成功/跳过/失败数，不明文列出不需要显示的顾客资料 |
| 库存调整 | `variantId`、`delta`（非零整数）、`reasonCode`、`reason`、`reference`、`expectedVersion`、`Idempotency-Key` | 禁止 set `onHand`；响应包含调整前后、可售数及 `movementId`；不足库存不能造成负数 |
| 会员积分调整 | `memberId`、`deltaPoints`（非零整数）、`reasonCode`、`reason`、`Idempotency-Key` | 正负方向受权限/限额约束；只新增 PointLedger，不改历史流水 |
| 隐私请求 | `requestType`、`customerRef`（可空）、`scope`、`sourceChannel`、`dueAt`、`verificationMethod` | 状态由服务端状态机驱动；导出/删除必须通过 identity verify、授权审批及处理 action |
| 通知模板 | `eventType`、`purpose`（`transactional|marketing`）、`locale`、`channel`、`subject`、`body`、`enabled`、`version` | 营销发送另校验 consent；交易模板不能携带营销用途 |
| 报表查询 | `from`、`to`、`timezone`、`market`、`paymentMethod`、`currency`、分页/维度参数 | from/to 为含起不含止；单店只汇总基础币种；响应带 `metricDefinitionVersion`、`generatedAt`、filters 和 totals |

### 3.6.8 OTP、通知和通用后台列表

- OTP request body 仅含 `email`、`locale`、`purpose`；响应统一为 `challengeId`（随机 UUID，仅关联挑战，不是认证凭据）、`challengeAccepted:true`、`resendAfterSeconds`、`expiresInSeconds`，对已登记及未登记地址均采用相同响应字段和状态，不得返回是否已登记会员。Verify body 含 `challengeId`、`code`；响应只发安全 cookie，并给出 member summary，不回传验证码或挑战秘密。
- 后台用户 create/invite body：`email`、`displayName`、`roleIds[]`、`locale`；状态由邀请流程管理。权限变更接口必须记录权限差异并阻止调用者授予自身无权授出的权限。
- 通知 retry body 必须含 `reason` 和 `Idempotency-Key`；返回原业务 `notificationJobId` 的新一次 attempt，不重做原业务操作。
- Audit log 列表筛选：`actorId`、`action`、`objectType`、`objectId`、`result`、`from`、`to`；响应中的变更摘要经敏感字段过滤，且不提供写入/删除 endpoint。

## 4. 关键业务 API 时序与一致性

### 4.1 下单

1. 前台请求 `POST /storefront/checkout/quote`，服务端读取当前价格/库存/市场/优惠/配送/税务配置并保存不可变报价快照。
2. 顾客确认后，前台以 `quoteId` + `Idempotency-Key` 调用 `/checkout/orders`。
3. API 在数据库事务中重验报价版本、有效期、库存及券额度，创建订单、库存/优惠预留记录和 outbox 事件。
4. 事务提交后才向付款服务商请求支付意图；不能持有数据库锁等待网络调用。外部失败时保留订单并按状态机标记待处理/失败，安全补偿预留。
5. 同 key 同 payload 返回同一订单；同 key 不同 payload 返回 `409 IDEMPOTENCY_CONFLICT`。

### 4.2 支付 Webhook

1. 验证服务商签名、时间窗/重放防护；无效请求拒绝且不改变账本。
2. 以 provider + event ID 建唯一键；重复事件返回成功接收但不重复记账。
3. 先持久化事件和处理任务，再快速响应服务商；异步 worker 查询/应用合法状态转换。
4. 金额、币种、商户号与本地 payment 不匹配时进入差异/人工队列，不得直接标为已付款。
5. 未知状态不视为失败；库存和优惠预留按状态机继续占用，等待查询或人工处理。

### 4.3 定时发布、导入与消息任务

- 定时发布按店铺 IANA 时区输入、UTC 执行；任务必须绑定页面版本，旧任务不得覆盖新版本。
- 导入必须区分 `validate` 与 `execute`；执行时校验确认的文件摘要及映射版本；重复提交有同一结果。
- Outbox 和业务变更在同一事务写入。消费者至少一次投递，按 event ID 幂等；失败退避并进入可观察死信状态。

## 5. OpenAPI 交付规则

R1 编码前须在 `packages/contracts/openapi.yaml` 补齐每个实现 operation 的：

1. `operationId`、标签、摘要、权限要求、认证方式、成功状态码和错误状态码。
2. 每个请求参数、请求体、响应 DTO、必填字段、长度/范围/枚举、格式及示例。
3. 金额使用 integer 最小单位；时间使用 date-time；敏感字段标记及脱敏说明。
4. `Idempotency-Key`、`If-Match`、分页、排序、语言和追踪 header。
5. 通用错误 schema、业务错误码、异步任务状态和回调验证说明。
6. 示例通过 schema 校验；从 OpenAPI 生成前端 API 类型/客户端，不手工复制接口 DTO。

PR 必须验证 OpenAPI 语法/schema，检查 operationId 唯一、权限标签完整，以及生成客户端无意外破坏性变更。该规范文件提交并评审前，不开始依赖具体 DTO 的 UI 联调。

## 6. 文档变更控制

新增接口需在本文件资源表登记、在 OpenAPI 中定义，并关联对应 `TC-*` 用例、权限点、事件 schema 和数据实体。接口废弃需至少经过兼容周期并保留 API 主版本策略。商家首店外部服务商的请求签名、字段差异只写入对应 adapter 契约，不污染通用 API。
