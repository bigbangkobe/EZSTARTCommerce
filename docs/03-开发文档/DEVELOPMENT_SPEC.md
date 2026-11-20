# EZSTARTCommerce 开发执行规格

> 版本：1.0  
> 状态：**产品与工程基线冻结，可据此拆分模板核心开发；客户交易上线和客户专属前台有独立的参数/设计门槛。**  
> 日期：2026-10-17  
> 本文把总体方案转成开发可实现的共用契约。客户市场、服务商、政策文本和页面内容属于每家店铺必须填写的实例参数，不留给开发人员猜。

2026-10-19 工程补充：[后台身份生命周期契约](ADMIN_IDENTITY_LIFECYCLE.md) 细化已有初始化、邀请、MFA 和会话需求；安全默认值见 [identity-v1](IDENTITY_SECURITY_POLICY.md)，恢复责任见 [恢复流程](../05-部署运维文档/ADMIN_RECOVERY_RUNBOOK.md)。路由同步 API 1.7 与 OpenAPI；首店主/MFA/本人会话和数据库迁移已通过真实验证，见 [身份实现说明](R1_IDENTITY_IMPLEMENTATION.md)。其余模块仍须实现、评审和验收，R1 未完成。

## 1. 文档效力、变更与交付范围

### 1.1 冲突处理顺序

1. 客户已签署的范围、上线参数表及变更单，只能覆盖本文标记为“可配置”的值，不能破坏安全、数据一致性和实例隔离规则。
2. `DECISIONS.md` 管理产品层决策；本文管理工程及跨模块业务契约。
3. `modules/M00–M16` 定义模块细节及该模块验收项；`design/` 定义页面交互和视觉表现。
4. `PRODUCT_BACKLOG.md` 只决定拆分和顺序，不改变上述需求。
5. 如文档互相矛盾、缺字段或出现未列状态，开发须先登记决策/变更并更新文档，不能自行补业务含义。

任何获准变更均需同步：业务规则、数据/接口契约、权限、异常处理、原型、验收条件、迁移/升级影响和客户实例兼容范围，并记录负责人、日期、版本及旧规则迁移方案。

### 1.2 本项目交付边界

- 一套可复用的电商核心与后台代码；每家商家获得一套独立应用、数据库、对象存储空间、凭证、域名和备份。
- 默认一商家、一站点、一实例；多个站点建多个实例，不引入共享租户控制台。
- 通用后台/业务 API 可复用；客户前台由实例配置生成，调用该客户实例的版本化 API；仅 B/C 类例外单独设计、开发、发布。
- 首期访客购物结账、邮件 OTP 会员入口、三语、商品/内容/陈列、COD、获批线上支付适配、配送配置、库存、优惠、会员、订单、售后、报表、导入和私有部署均在核心范围。
- 不包含旧站数据迁移、法律判断、第三方账户审批、客户未签署的页面/集成、自动物流、SaaS、多仓、税务引擎/电子发票或顾客密码登录。

## 2. 已冻结的产品默认规则

这些是所有新实例的默认行为；店铺只有在相应开关和参数齐备后才可改变可配置项。

| 领域 | 开发基线 | 实例参数/阻断条件 |
|---|---|---|
| 实例 | 独立部署、独立数据库与文件空间；数据库不承担跨租户隔离 | 云区域、域名、备份和支持责任由客户填写 |
| 语言 | `zh-CN`、`zh-HK`、`en`；路径按实例路由策略生成；后台可分别维护翻译 | 页面/商品的最终译文由客户提供；缺少已启用语言必填内容时阻止发布 |
| 货币 | 每实例单一基础币种；价格、订单、支付、退款和报表全程使用该币种；不自动换汇、不跨币种相加 | 币种由客户确认；多币种需要单独变更 |
| 顾客身份 | 访客可完整购物和结账；会员是可选能力，基础登录方式为邮箱 OTP；不设密码 | 短信 OTP 只有在客户选定并提供服务商后启用 |
| 会员创建 | 仅顾客主动完成告知并验证邮箱后创建/关联会员；未验证访客资料不自动合并 | 同意文字及数据处理策略由客户审核 |
| 商品 | 后台编辑；每个启用语言必填的商品名称、slug、详情信息须齐全；SKU 在本实例唯一 | 市场可售范围、年龄/资格条件由已审核的店铺规则配置 |
| 陈列 | 后台仅能编辑当前主题注册的区块；手动排序或选用支持的动态排序；发布前预览 | 专属区块和未注册布局需另行开发 |
| 结账 | 服务端重新计算商品价、折扣、配送、税费和总价；浏览器传入金额不可信 | 生产结账须有至少一种已启用付款方式和可覆盖目的地的配送规则 |
| 优惠 | 默认每单最多一个优惠码；额度按事务预占；未明确配置叠加/返还策略前不叠加其他优惠券 | 优惠适用条件、核销/返还时点由客户参数冻结 |
| 库存 | 首期单库存地点；采用现货数、预留数和流水账；预留过期或付款状态未知不自动释放 | 预警阈值可按 SKU 设置；多仓另行变更 |
| 支付 | COD 和适配器框架；未获批、未配置、健康检查失败或停用的线上渠道不显示 | 客户服务商、商户账户、结算账号绑定、沙箱/生产凭证为上线阻断项 |
| 配送 | 后台区域 + 固定运费或订单商品金额门槛 + 免运门槛；首期人工履约、支持分包裹 | 区域、地址字段、时效、费用、COD 可用区域由客户填写；重量/件数费率和物流 API 另行确认 |
| 税务 | 税费开关默认为关闭；不作地区税务判断或自动税务申报 | 启用税费前必须提供经客户/顾问批准的计算规则；复杂税务/发票不属默认首期 |
| 通知 | 交易通知与营销通知分离；交易事件入队后异步发送；失败不回滚订单 | 邮件为基线通道，短信/WhatsApp 需另配服务商与模板 |
| 购物车 | 访客购物车通过随机、不可猜测会话标识持久化；30 天无活动过期；不启用弃购营销 | 客户需要更长保留或弃购营销时单独确认隐私策略 |
| SEO | 预览、后台、购物袋、结账、会员及非生产环境不索引；新站默认 noindex，批准生产域名/索引策略后再开放 | 每语言公开范围、域名和旧 URL 映射由客户审核 |
| 统计 | 订单/支付/退款账本是金额权威来源；访问分析匿名化并可独立关闭 | 告知/同意、事件保留和跨来源归因由客户按市场确认 |
| 运维 | 同版本重复部署；迁移有版本；备份和媒体分开恢复；无默认 24x7 运维承诺 | RPO/RTO、可用性、值守、升级及安全响应时间写入客户合同 |

## 3. 技术架构基线

### 3.1 技术选型

| 部分 | 冻结选择 | 约束 |
|---|---|---|
| 语言/运行时 | TypeScript、Node.js 24 LTS | 版本范围写入运行环境声明；升级由依赖变更评审，不自动追 latest |
| 商家后台 | Next.js 16 + React | 管理后台与顾客前台可同仓不同应用；后台所有敏感动作由服务端 API 授权 |
| API/Worker | NestJS 12 模块化单体；API 与异步 Worker 可独立进程、共享领域代码 | 领域之间通过应用服务/事件协作，不跨域直接改表 |
| 数据库 | PostgreSQL 18，按客户独立实例 | 交易关系、唯一约束、事务、行锁和版本迁移以 PostgreSQL 为准 |
| 持久化 | Prisma ORM 7 GA + 明确的 SQL/事务边界 | Prisma 8 在 GA 且兼容性评审前不进入首期；金额、库存、优惠、幂等写入必须在数据库事务内；复杂行锁可通过参数化 SQL；不以 ORM 回调实现交易状态机 |
| 前端包管理 | pnpm workspace 单体仓库 | `pnpm-lock.yaml` 锁定精确依赖；禁止业务包各自漂移依赖版本 |
| API | REST JSON `/api/v1`，OpenAPI 作为接口契约和类型生成来源 | 无 GraphQL；破坏性字段/语义变更新增主版本；同主版本只做向后兼容新增 |
| 文件 | S3 兼容私有对象存储；开发可用本地兼容服务 | 文件不放数据库；下载使用短效签名 URL；客户媒体空间隔离 |
| 异步任务 | PostgreSQL outbox + job 表 + 独立 Worker；首期不依赖 Redis | 任务具备租约/重试/死信/幂等；Redis 仅未来按证据引入缓存，不存权威状态 |
| 部署 | Docker 镜像 + Docker Compose；TLS 由反向代理/客户入口提供 | 每实例独立 compose 配置、数据库、媒体桶、密钥及环境变量 |
| 可观测性 | 结构化 JSON 日志、健康/就绪检查、请求 ID、业务指标与告警接口 | 脱敏后记录；不将顾客资料/凭证打进日志 |

### 3.2 仓库和应用边界

```text
apps/
  admin/                 Next.js 商家后台
  storefront-reference/  Next.js 通用参考前台；客户专属前台独立包或独立仓库
  api/                   NestJS REST API
  worker/                NestJS 异步任务进程
packages/
  contracts/             OpenAPI、生成客户端、事件 schema
  domain/                领域规则、值对象、状态转换
  database/              Prisma schema、迁移、仓储实现
  ui/                    后台/通用前台共享组件
  config/                lint、TypeScript、运行时配置规范
```

客户前台依赖 `contracts` 生成的 API 客户端，不复制业务规则，不直连数据库。通用核心可发版；客户前台按独立交付版本锁定 API 主版本、页面清单和主题区块契约。

### 3.3 主要领域模块

`identity-admin`、`store-config`、`catalog`、`content-merchandising`、`cart-checkout`、`orders`、`payments-reconciliation`、`fulfillment`、`customers-members`、`promotions`、`inventory`、`notifications`、`analytics`、`imports-exports`、`after-sales`、`deployment-operations`。每个模块仅通过公开应用服务/API/事件变更自己的数据；其他模块不能直接写其表。

## 4. 通用数据与接口契约

### 4.1 标识、时间、金额、翻译

- 内部实体使用 UUID 主键；订单号、SKU、优惠码是独立的人类可读唯一业务键，不复用数据库 ID。
- 数据库时间统一 UTC；店铺配置 IANA 时区，仅用于展示、营业日归属和定时任务。夏令时重复/不存在时间由时区库解析；含糊的定时输入要求用户明确选择。
- 钱款使用整数最小货币单位 + ISO 币种代码；拒绝浮点数写入。运算用整数或高精度十进制中间值，按币种小数位规则舍入；最终报价和每一组成金额均保存快照。
- 商品翻译独立存储，不能将繁体、简体或英文互相伪装为另一语言。后台编辑可显示未翻译状态；前台按 M03/M04 的明确规则阻止发布或隐藏缺译条目。
- 订单、支付、退款、运费、税费、商品规格名称及下单语言均保留交易时快照；后续改商品不回写历史订单。
- 删除对业务有引用的数据采用归档/停用；订单、支付、退款、库存流水和审计使用追加历史，不做原位覆盖或物理删除。

### 4.2 REST API

- 所有后台、Storefront API 使用 HTTPS；后台走会话认证，前台公开读接口只返回已发布/可售数据。
- 默认同一域名下路由 `/` 顾客前台、`/admin` 商家后台、`/api/v1` 接口；客户确需分子域时按实例登记精确 CORS allowlist，不允许带凭据的通配来源。
- 成功响应形态为 `{ "data": ..., "meta": ... }`；列表统一返回 `items`、`nextCursor`、`hasMore`，默认 25 条、上限 100 条。排序字段采用白名单，不能直接拼接 SQL。
- 错误响应形态为 `{ "error": { "code", "message", "fieldErrors", "requestId" } }`。`code` 稳定可供页面处理；`message` 按请求语言本地化；不得向客户端返回 SQL、堆栈、支付密钥或内部服务原始响应。
- 写接口接受 `Idempotency-Key` 的操作：创建订单/付款/退款、库存调整、导入执行、结算文件确认、批量发券。相同 key + 相同请求返回相同结果；相同 key + 不同 payload 返回 `IDEMPOTENCY_CONFLICT`。
- 每个请求生成/继承 `X-Request-Id`；支付 webhook、后台审计、异步任务均可关联此 ID 或原业务事件 ID。
- `429` 必须有可执行的重试提示；`409` 表示状态/库存/版本冲突；`422` 表示字段或业务校验失败；`503` 表示暂时不可用。客户端不能自行将未知付款状态解释为失败。
- `ETag`/版本号用于内容和配置编辑的并发冲突检查；提交旧版本返回 `409 VERSION_CONFLICT` 并让编辑者比较后再提交。
- 支付、邮件等第三方调用有超时上限、重试规则、服务端结果查询和人工补偿入口；禁止在数据库事务中等待第三方网络请求。

稳定业务错误码至少包含：`VALIDATION_ERROR`、`FORBIDDEN`、`NOT_FOUND`、`VERSION_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`MARKET_NOT_AVAILABLE`、`PRODUCT_UNAVAILABLE`、`INSUFFICIENT_STOCK`、`QUOTE_EXPIRED`、`PRICE_CHANGED`、`COUPON_INVALID`、`SHIPPING_UNAVAILABLE`、`PAYMENT_PENDING`、`PAYMENT_UNKNOWN`、`PROVIDER_UNAVAILABLE`、`RATE_LIMITED`。前端按 `code` 呈现下一步动作，不解析错误文案决定交易状态。

### 4.2.1 首期 API 资源清单

以下资源是模块拆分契约；字段 DTO 以各模块实体/规则为准，所有写操作另需对应权限码、审计、校验和错误码。

| 路径前缀/资源 | 主要端点动作 | 访问边界 |
|---|---|---|
| `/api/v1/admin/auth` | `POST login / mfa/verify / logout / password-reset`；`GET session` | 后台账号、限速、MFA、CSRF 和会话策略 |
| `/api/v1/admin/users`, `/roles` | `GET/POST/PATCH`; 用户停用、会话撤销、角色权限分配 | `staff.manage` / `roles.manage` |
| `/api/v1/admin/store-config` | `GET/PATCH` 店铺配置；语言/市场/付款方式开关状态 | 后台授权；配置变更审计 |
| `/api/v1/admin/products`, `/categories`, `/brands`, `/media` | 列表、详情、新建/编辑、发布/下架、媒体管理 | `catalog.*`; 商品读写和发布分权 |
| `/api/v1/admin/import-jobs`, `/export-jobs` | 上传、校验预览、执行/取消、错误报告/短效下载 | `catalog.import` 或数据域独立导出权限；幂等执行 |
| `/api/v1/admin/pages`, `/merchandising` | 草稿、版本、区块/选品、预览 token、发布/定时/撤下/回滚 | `content.*`; 发布操作审计 |
| `/api/v1/storefront` | 已发布配置、商品/分类/页面/集合、购物车读取/增改删 | 仅公开可售数据；对游客使用受限会话 token |
| `/api/v1/storefront/checkout` | `POST quote`, `POST orders`; 返回服务端金额和支付下一步 | 访客无账号；幂等键；市场/库存/券/配送复核 |
| `/api/v1/storefront/member` | OTP 申请/验证/登出；本人会员资料/订单摘要/优惠券/积分 | 已验证会员会话；无跨客户账号 |
| `/api/v1/webhooks/payments/{provider}` | 接收支付/退款回调、验签、去重、排队处理 | 仅 provider adapter；签名、IP/nonce/时间戳策略按服务商契约 |
| `/api/v1/admin/orders`, `/shipments` | 搜索、详情、确认/暂停/取消、内部备注、地址校验/更改、包裹创建/发货/签收 | `orders.*`, `shipments.manage`; 联系信息字段级权限 |
| `/api/v1/admin/payments`, `/refunds`, `/settlements` | 支付台账、退款申请/审批/执行/查询、结算批次预览/导入/差异处理 | 财务权限拆分；敏感动作二次确认 |
| `/api/v1/admin/shipping` | 区域/费率 CRUD、测试报价、启停 | 店铺配置权限；变更留配置版本 |
| `/api/v1/admin/customers`, `/members`, `/privacy-requests` | 档案、会员规则/积分、同意记录、请求核验/处理/受限导出 | PII/导出/隐私权限分开 |
| `/api/v1/admin/coupons`, `/coupon-batches` | 券规则、批量发放、停用、核销量 | `coupons.manage/issue`; 营销发送遵守同意 |
| `/api/v1/admin/inventory` | 现货/预留列表、调整单、流水、预警 | `inventory.read/adjust`; 盘点以调整记录提交 |
| `/api/v1/admin/notification-settings`, `/notification-jobs` | 模板/通道、发送状态、重试/人工重发 | `settings.manage`; 重发只重做通知 |
| `/api/v1/admin/reports` | 带口径/时间/时区筛选的聚合报表与导出任务 | `reports.view/export`; 默认不含 PII |
| `/api/v1/admin/after-sales` | 案件、审核、退货质检、关联退款/换货 | M16 角色表；不得绕过 Payment/Inventory 服务改账 |

购物车和会员会话仅代表访问身份，不是订单授权凭证。订单查询/前台自助售后若按 P1 加入，必须采用一次性验证链接/验证码，不允许仅凭订单号读取顾客资料。

逐路由方法、请求/响应约束、权限边界和 webhook/下单时序见 [API 接口契约](API_SPEC.md)；机器可读契约当前位于 [`packages/contracts/openapi.yaml`](../../packages/contracts/openapi.yaml)。本文的资源清单定义模块边界；R1 须补齐所有 operation 的成功响应字段 schema 并校验权限覆盖，之后用该文件生成客户端。

### 4.3 业务事件与异步任务

核心事件至少包括：`product.published`、`content.published`、`order.created`、`payment.status_changed`、`order.cancelled`、`inventory.reservation_expired`、`shipment.created`、`refund.status_changed`、`member.points_posted`、`coupon.status_changed`、`privacy_request.due`。

事件具备 `event_id`、`event_type`、`schema_version`、`aggregate_id`、`occurred_at`、`correlation_id` 和最小业务 payload。业务事务与 outbox 写入同一数据库事务；Worker 至少一次投递，消费者按 `event_id` 幂等处理。失败退避重试后进入 dead-letter 状态，后台显示原因、重试次数和安全重放操作；重放不能重复扣款、发券、积分或库存。

## 5. 交易计算规则

### 5.1 结账金额顺序

1. 读取当前商品/变体服务端价格与可售资格，按数量计算商品行小计。
2. 应用商品配置的有效销售价；已归档、下架、市场不可售、未满足资格或库存不足的商品拒绝结账。
3. 验证单个优惠码、会员身份和适用商品/分类；按已保存规则版本计算优惠。优惠金额不能超过符合条件商品金额，不能产生负数。
4. 计算配送方式与目的地区域费用；不符合配送区时拒绝报价。免运门槛统一以商品优惠后、税费前金额计算；后台明确显示这个口径。
5. 税费未启用则为 0；启用时按客户签字的版本化税务参数计算，并保存地区、税类、税率、含税标志和舍入结果快照。
6. `应付总额 = 商品金额 - 优惠 + 配送费 + 税费`。订单确认页、订单记录、付款请求必须使用同一份服务端报价快照；金额或规则版本变化时要求重新确认。

固定金额优惠按可优惠商品行金额比例分摊；整数舍入余数按订单行创建顺序分配。退款优先沿用原订单行优惠/税费/运费分摊快照，不能按当前商品规则重算历史交易。

### 5.2 库存与优惠占位

- `available = on_hand - reserved`；所有订单预留和库存调整在数据库事务内锁定对应 SKU 行并校验数量。
- 每个下单行创建唯一预留记录；线上待支付预留默认 30 分钟。到期后先查询服务商：明确未支付/取消才释放；处理中/未知保持预留并告警，不自动释放。已付款和已确认 COD 的预留不按支付 TTL 自动释放。
- 支付结果未知时自动服务端查询间隔为 1、5、15、30 分钟；仍未知则进入财务/客服待处理队列，继续接受合法回调/人工查询，不自动判失败、不释放库存或优惠占位。
- 发货时按包裹实际发货数量同时减少 `on_hand` 与 `reserved`，写库存流水；未发货取消释放预留但不增加现货；已发出商品不因取消增加现货。
- 售后退回商品只有在仓库收货、质检并选择“可售入库”后增加 `on_hand`；损坏、冻结、报废分别记流水。
- 优惠额度在订单创建事务中占位；重复请求使用同一占位。订单取消/明确支付失败按规则释放；付款状态未知时不释放；成功退款是否返券由客户规则决定并记录单独事件。

### 5.3 顾客、会员与优惠默认行为

- 订单通知所需联系方式按店铺启用渠道收集；不默认同时强制邮箱和手机。
- 邮箱 OTP 为 6 位数字，默认 10 分钟有效、单码最多 5 次验证；重发间隔 60 秒、每邮箱每小时不超过 5 次；5 次错误后冷却 15 分钟。通用提示不泄露邮箱是否注册；OTP 明文只用于发送，不落库/日志。
- 积分规则按实例配置；基础模板以已完成订单的商品实收净额为计算基数，不计配送费和税费。取消/退款按退款金额比例幂等冲回；兑换点数先预占，取消释放。客户规则未配置时关闭积分兑换而不猜比例。
- 交易通知不代表营销同意。营销推送必须有对应渠道/用途/文案版本的有效同意；退订即时阻止后续营销发送。

### 5.4 商品搜索与陈列动态排序

- 首期搜索范围是当前语言的商品名称/描述、SKU、品牌和分类；精确 SKU 优先，其余为标准化词项/子串匹配。结果只包含已发布、当前市场可售商品；不做拼写纠正、语义搜索、同义词推荐或外部搜索服务。
- 分类筛选只显示该客户主题/商品目录中启用且有可用值的属性；排序入口仅开放已实现规则。默认动态排序包括新品、近 30 天已履约销量、价格升序、价格降序；同值稳定依次按发布时间、商品 ID/SKU 排序。
- 新品按首次发布时间倒序；销量只计已发货/完成订单的件数，取消订单不计，成功退款按退回件数冲减；价格排序使用当前可购买变体最低价。缺货/禁售商品不得因排序规则重新进入前台。

### 5.5 优惠码计算与核销

- 优惠码去除首尾空格并转大写后匹配；有效区间为 `valid_from <= now < valid_until`，后台输入时区按店铺 IANA 时区解析并保存 UTC。
- 商品销售价先作为当前商品有效单价；最低消费按销售价汇总、扣优惠码前、税费/配送费前的符合条件商品金额计算；优惠码后计算。订单每单最多一个优惠码，不与其他优惠码叠加。固定金额/百分比优惠不可超过符合条件金额；百分比在 API/数据库以整数 basis points 表示（100 bps = 1%，范围 1–10,000），按最小货币单位四舍五入（half-up）。
- 下单事务创建 `reserved` 使用记录；线上确认成功或 COD 人工确认时转 `redeemed`；确认前明确取消/失败时释放；付款未知保持预占。已核销后取消/退款不直接删除历史使用记录，是否返券依实例规则通过新的返还记录处理。
- 单顾客限制优先使用已验证的 Member ID；访客订单以规范化邮箱/电话的实例密钥 HMAC 值检查并限用，不在报表/审计中暴露原联系方式。访客联系方式未经验证不能用于会员合并。
- 已实现口径（M11）：额度状态机 `reserved → redeemed / released / expired` 只进不退，占额度口径为 `预占 + 已核销 − 已返还`；报价只做只读试算，额度在下单事务内加 advisory lock 复核后预占。报价与订单各存一份 `couponSnapshot`（含 `ruleVersion`）：改券后旧报价下单返回 409 `COUPON_CHANGED`，历史订单金额不变。整单退款且 `refundPolicy=restore` 时新建 `CouponQuotaReturn` 返还记录（含一条 `redeemed→redeemed` 审计事件），绝不改写原核销行；`refundPolicy=none` 或部分退款不返还。未知券码、过期/未开始/停用/币种不符/未达最低消费/范围不适用/总额度或单人限额用尽分别返回 409 与稳定原因码（`COUPON_*`），不再静默按原价结算。

### 5.6 结账价格与地址变更

- 购物车报价/结账报价有效期默认 15 分钟；创建订单前再次验证价格、促销、库存、市场和配送。报价失效或任一金额变化时返回新摘要，要求顾客确认后再下单。
- 任何未发货订单修改地址时重新校验配送区和费用。费用不变可授权保存；费用变化必须经顾客确认。已付款订单须通过已配置的补收/退款方式完成差额后生效；线上待付款订单要先安全取消旧支付意图并按新金额创建支付，若旧支付结果未知则暂停改址并进入人工复核；COD 可在顾客确认后更新待收金额。若线上渠道不支持差额处理，则拒绝直接修改并引导客服取消重建订单。已发货禁止后台直接改地址，转承运商人工处理并记录。

## 6. 关键状态机与允许转换

状态字段与历史表分离；每次改变需校验前置状态、权限、金额/数量约束并写 `from/to/actor/source/reason/time`。未列转换一律拒绝并返回业务冲突，不以管理员任意改状态兜底。

| 对象 | 状态 | 关键转换规则 |
|---|---|---|
| 商品 | `draft → active → archived`；active 可下架回 draft | 仅满足语言/市场/价格/SKU/媒体校验后发布；缺货是库存派生展示，不覆盖商品状态 |
| 内容/陈列版本 | `draft → scheduled → published → withdrawn`；发布任务可 `failed/cancelled` | 同一页面/语言版本原子发布；预览不改变线上版本；回滚创建新版本；定时任务绑定目标版本 |
| 导入任务 | `uploaded → validating → ready → processing → completed / completed_with_errors / failed / cancelled` | 执行前预览和二次确认；失败行不写；中断可从行级幂等续跑；库存调整走 M12 |
| 购物车 | `active → converted / expired` | 30 天无活动转 `expired`；`converted` 后不可重用下单；“弃购”仅是分析分群，不改变交易状态；价格/库存每次结账重查 |
| 结账 | `open → validating → order_created` 或 `validation_failed / expired` | 创建订单用幂等键；任何页面回跳不等于订单付款结果 |
| 订单 | `pending_payment / awaiting_confirmation → confirmed → processing → partially_shipped → shipped → completed`；未发货可按审批转 `cancelled`；任意非终态可经授权置 `on_hold` 再恢复 | COD 创建为 `awaiting_confirmation` 且付款状态为 `cod_due`，授权人员确认后进入 `confirmed`；线上仅经签名回调/服务端查询成为 `confirmed`；发货数量和支付状态分别校验 |
| 线上支付 | `created → requires_action / processing → succeeded / failed / cancelled / unknown` | 回调验签、事件 ID 去重；超时变 `unknown` 并查询；仅可信服务端结果可定为成功/失败 |
| COD 收款 | `cod_due → collected / rejected / returned`；已收后可进入退款台账 | 仅授权人员记录收款/拒收/退回；签收不自动视为收款 |
| 退款 | `requested → approval_pending → processing → succeeded / failed / unknown / cancelled` | 退款单独记账，不改原付款；未知先查询，不盲目重发；处理中 + 成功金额之和不能超过实收可退额 |
| 配送/包裹 | `unfulfilled → preparing → partially_fulfilled → fulfilled → delivered`，可 `exception` | 每个 Shipment 独立记录商品/数量/追踪；订单行累计发货不得超订购量；按人工证据登记签收 |
| 优惠占位 | `reserved → redeemed / released / expired` | 成功核销/释放均幂等；付款未知维持占位；返券创建新审计记录，不覆盖旧使用记录 |
| 库存预留 | `reserved → committed / released / expired` | 发货时 committed 并出账；仅满足取消/明确失败条件时释放；预留未知保持不动并告警 |
| 售后案件 | `draft → submitted → under_review → approved / rejected / needs_information → return_in_transit → received_inspection → refund_pending → refunded / replacement_sent → completed / closed`；失败可 `refund_failed` | 依案件类型跳过不适用步骤但留事件；COD 未收款取消不产生付款退款；按 M16 权限矩阵执行 |
| 隐私请求 | `received → identity_verification_pending → under_review → approved / rejected / needs_information → processing → completed` | 身份未核实不得泄露账户存在性、导出或删除；交易保留例外单独记录 |
| 通知任务 | `queued → sending → sent`，失败为 `retrying / failed / dead_letter` | 重试同一通知事件；人工重发只重发通知，不重做交易；营销和交易渠道校验分开 |

### 6.1 订单、支付、履约三套状态不可合并

后台详情分别显示 `order_status`、`payment_status`、`fulfillment_status`。订单完成必须同时满足履约完成与适用付款条件；COD 尚未登记收款可以是“已送达/待收款”，不能伪装为“已支付”。取消订单不会删除付款或退款记录。

## 7. 后台角色与权限基线

所有授权在服务端按 permission code 校验；前端隐藏菜单只改善体验，不构成安全边界。默认角色可增删权限，但不得删除系统最后一个店主；权限变更立即影响下一次请求并可撤销会话。

| 角色 | 默认范围 |
|---|---|
| 店主 | 全部业务操作、角色管理、MFA、付款配置；审计记录只读，不可改写 |
| 管理员 | 商品/内容/订单/库存/顾客日常管理；无店主转让/销毁实例权限；退款/付款凭证/隐私导出按显式权限授予 |
| 商品运营 | 商品、分类、媒体、导入、陈列草稿；不能查看完整订单顾客资料、付款凭证或执行退款 |
| 订单客服 | 订单、地址（按字段权限）、配送、售后案件建立/分派；退款审批/执行分开授权 |
| 财务 | 付款、退款审批/执行（按额度）、对账和财务导出；默认不改商品/库存 |
| 仓库 | 受限订单商品/配送信息、包裹发货、收货质检建议；无顾客完整档案、退款或支付设置 |
| 报表只读 | 获准的聚合报表；不读顾客/订单明细、不导出 PII |
| 隐私专员 | 身份核验、请求队列、导出/更正/匿名化处理；资料访问与导出分权限，不能自动审批自己处理的请求 |

店主/管理员必须启用 TOTP MFA；一次性恢复码只存哈希并且使用后作废。高风险操作包括退款、密钥变更、数据导出、角色权限、批量库存/价格更改、隐私请求、实例销毁：需二次确认和审计；达到商家配置限额时需要第二授权人。密钥/密码/OTP/卡号/CVV/完整银行账号严禁进普通日志或审计摘要。

后台基线：唯一员工账户、密码 hash（Argon2id）、密码至少 12 个字符、密码重设链接一次性且 30 分钟到期、强制 TLS、同一账户 15 分钟内 5 次失败后冷却 15 分钟并配合 IP 限速、30 分钟空闲会话过期、12 小时绝对期限、停用后即时撤销所有会话、权限收紧后按新权限即时生效、敏感动作 CSRF 防护。会话 Cookie `HttpOnly`、`Secure`、`SameSite`；受保护写操作校验 CSRF token 和来源。具体安全值调整需经安全评审和记录。

### 7.1 服务端权限码和默认角色包

权限码是可审计的独立授权项；新增 API 时先登记权限码，再授予角色。角色管理者不能授予自己没有的权限，也不能创建比自己权限更高的新角色。

| 权限域/权限码 | 默认角色 | 说明 |
|---|---|---|
| `staff.read`, `staff.manage`, `roles.manage` | Owner；Admin 可由 Owner 单独授权 | 员工读取/邀请/停用/角色分配；不能授出调用者自身没有的权限 |
| `store.settings.manage`, `payment.config`, `operations.health.read`, `instance.backup`, `instance.export`, `instance.decommission` | Owner；Admin 可授权非支付店铺设置和受限健康查看 | 支付密钥/生产模式、备份、导出和销毁需 MFA、二次确认及审计 |
| `catalog.read`, `catalog.write`, `catalog.publish`, `catalog.import`, `media.manage` | Owner、Admin、ProductOps | 商品/媒体、导入；批量覆盖需预览确认，库存不通过商品 API 写入 |
| `content.read`, `content.write`, `content.preview`, `content.publish`, `content.seo` | Owner、Admin、ProductOps（可由 Owner 拆权） | 草稿编辑、预览和发布分权；只能编辑主题注册区块 |
| `orders.read`, `orders.update`, `orders.cancel`, `orders.address_change`, `shipments.manage` | Owner、Admin、OrderSupport；Warehouse 只授予受限履约权限 | 地址修改仅未发货；完整联系方式仍需独立 PII 权限；发货数不能超订购量 |
| `customers.read_masked`, `customers.read_pii`, `customers.manage`, `customers.export` | Owner；OrderSupport 默认 masked；PrivacySpecialist 按任务授权 | 顾客档案、全字段查看和导出分开授权 |
| `members.manage`, `points.adjust`, `coupons.read`, `coupons.manage`, `coupons.issue` | Owner、Admin；对应运营岗位可授权 | 积分人工调整单独记录原因、审计和限额；营销发放检查同意。优惠券：读与核销记录是 `coupons.read`（核销记录只见顾客 HMAC 摘要），建/改/停用是 `coupons.manage`（停用须幂等键），批量发放是 `coupons.issue`；在会员目录（M10）落地前，创建会员专属规则返回 422 `MEMBER_TIERS_UNAVAILABLE`，批次创建与发放返回 422 `MEMBER_AUDIENCE_UNAVAILABLE` |
| `inventory.read`, `inventory.adjust`, `inventory.manage` | Owner 与 Admin 三项全给；ProductOps 只给 `read`；Warehouse 给 `read`+`adjust`（`role-presets.ts` 现状） | 调整记前后数量/原因，只接受增量不做 `set onHand`；阈值只影响提醒，与调整分开授权 |

库存的实际授权形状：`inventory` 预设组固定为 `read`+`adjust`+`manage`；`warehouse` 预设显式只拿 `inventory.read` 与 `inventory.adjust`，改不了阈值；`product_ops` 只有 `inventory.read`。调整需要 `inventory.adjust` + CSRF + `Idempotency-Key` 与期望版本（0 表示该 SKU 尚无库存行），阈值写入需要 `inventory.manage`。
| `payments.read`, `payments.collect`, `payment.config`, `payments.reconcile`, `refunds.create`, `refund.approve`, `refund.execute` | Owner；Finance 可获收款登记与对账；OrderSupport 默认只能建售后案/查有限信息 | 收款登记与退款审批/执行分开；生产凭证配置不因财务权限自动开放 |
| `shipping.manage`, `notifications.read`, `notifications.manage`, `notifications.retry` | Owner、Admin；Shipping/Operations 岗位按职责授权 | 配送规则有版本；重发只重试通知，不重做业务动作 |
| `reports.view`, `reports.export` | Owner、Admin、ReportsReadOnly | ReportsReadOnly 仅聚合结果，不能查看顾客/订单 PII |
| `privacy.read`, `privacy.manage`, `privacy.verify`, `privacy.process`, `privacy.export` | Owner、PrivacySpecialist 按任务授权 | 核验、处理、导出分权；申请人不得审批自己处理的请求 |
| `aftersales.read`, `aftersales.manage`, `aftersales.approve`, `aftersales.inspect`, `audit.read` | Owner；OrderSupport 默认 `read`+`manage`+`inspect` 不含 `approve`；Warehouse 只给 `inspect`；审计人员单授 `audit.read` | 售后审批（案件结论与批准金额）、质检处置、审计三类权限分开；审计记录不可编辑/删除 |

售后与退款的实际授权形状（`role-presets.ts`）：`aftersales` 预设组固定为 `read`+`manage`+`approve`+`inspect` 四项；`order_support` 显式列 `read`/`manage`/`inspect` 三项、不含 `approve`；`warehouse` 只拿 `aftersales.inspect`。退款另走 `refunds.create`、`refund.approve`、`refund.execute`：`finance` 预设三项全给，Owner 全给，OrderSupport 与 Warehouse 一项都不给。服务端在 `approveRefund` 里强制“申请人 ≠ 批准人”（`403 SELF_APPROVAL_FORBIDDEN`），因此即便一个账号拿到全部三项，也不能自建自批；取消类案件的批准会同时取消订单并释放预留，所以它要求 `aftersales.approve` 而不是 `orders.cancel`。

本表的代码投影是 `packages/config/src/role-presets.ts`（服务启动时幂等补齐缺失的预设角色，已存在的预设不被覆盖）；新增权限码时先改契约 x-permission，再同步该文件，否则启动会因预设引用未知权限码而失败。

授权方式是“角色拥有权限集合，用户绑定角色”；API 每次请求检查用户状态、有效会话、MFA 要求及当前权限版本。接口、按钮、列表字段、导出、异步任务下载均执行同一权限规则；读取完整 PII 也记录 `AuditLog`。

## 8. 页面、发布、导入、通知和统计的端到端流程

### 8.1 商品编辑与发布到前台

后台新建草稿 → 填三语、SKU/变体/价格/市场、媒体/SEO → 服务端逐字段校验 → 预览指定设备/语言 → 发布生成不可变版本 → 发布事件更新前台可读缓存 → Storefront API 只读已发布版本 → 再按当前市场/库存计算可购买资格。发布后商品下架/市场禁售须立即停止购买；手动陈列保留后台选择并标异常，前台隐藏；动态陈列从合格候选补位。

### 8.2 内容计划与回滚

草稿快照 → 权限校验 → 三语完整性/slug/重定向/区块/商品资格校验 → 桌面和手机预览 → 立即或店铺时区定时发布 → 原子切换版本 → 站点地图刷新。计划任务绑定目标版本，不允许旧撤下任务撤掉更新版本。失败保留旧线上版本并告警。回滚从历史快照创建新版本，不覆盖历史。

### 8.3 导入商品

模板下载 → 文件/病毒与格式检查 → 映射/校验 → 行级预览（新增/更新/跳过/错误/警告）→ 选择“仅应用有效行”或“全批原子” → 二次确认 → 幂等行任务 → 汇总报告/错误文件。默认模式为仅应用有效行；错误行无副作用。不存在于文件中的商品不删除。远程图片只允许安全 HTTPS 下载并阻止内网地址、重定向滥用和超大文件。

### 8.4 订单、通知、报表

订单事务写入订单/行快照、库存和优惠占位、支付意图及 outbox → 第三方付款调用在事务外 → webhook/主动查询更新付款 → Worker 处理通知和积分 → 后台根据独立状态履约/售后。异步失败可观察和重试，不回滚已确认的核心交易事实。经营报表读交易台账和聚合表；分析 SDK 事件不用于确认交易。

## 9. 安全、隐私和内容治理

- 每个客户实例独立数据库账号、密钥、对象存储桶/前缀、备份和域名；后台接口禁止接收客户端指定 `instance_id` 来切换数据空间。
- 生产 secrets 仅来自 secrets manager/受控环境注入；数据库只存密钥引用及不可敏感连接状态；保存后不回显明文。服务商账户审批/结算账户绑定在服务商系统完成。
- 个人资料按最小字段收集、字段级授权、传输/静态加密策略、脱敏和保留期限处理；访问/导出/更正/删除先身份核验。交易事实依客户批准的保留例外处置，不能被普通删除操作破坏。
- 顾客邮箱、电话、收件地址等直接身份字段使用实例级应用层 envelope encryption：AES-256-GCM 加密、每实例数据密钥由 KMS/受限 secrets key 加密托管；另用独立 HMAC-SHA-256 密钥建规范化邮箱/电话盲索引以支持精确查找。密钥版本和轮换/重加密过程有记录；数据库/备份静态加密不能代替字段加密。
- 导出文件只给授权用户短时下载链接，文件到期删除；日志和分析事件不得含直接身份信息。CSV/XLSX 导入/导出防公式注入。
- 管理导出签名 URL 默认 15 分钟有效、导出文件 24 小时后过期删除；个人资料请求导出仍需逐次验证身份和单独授权。实例迁出文件按客户批准的加密交付期限保存，禁止使用普通导出 TTL 替代合同交接。
- 图片上传校验大小、MIME、实际文件内容并剥除危险元数据；后台编辑内容不允许任意脚本/HTML 注入，受支持富文本采用白名单清洗。
- SEO 索引仅公开生产域名、已发布、语言完整且明确允许索引的页面；slug 重定向检测冲突、重复链和循环。
- 市场准入、商品/广告年龄限制、退款/隐私政策由客户及顾问提供批准依据，软件只执行已配置规则，不替代法律判断。

## 10. 生产运维基线

- 环境最少为本地开发、预发布、生产；生产数据不得复制到个人开发环境；使用脱敏种子数据。
- 数据库迁移必须前向可追踪；破坏性迁移采用 expand → migrate/backfill → contract 多发布步骤。生产发布前备份、验证迁移计划、检查 API/前台兼容；迁移不可安全回滚时按前向修复方案执行。
- 日备份为模板默认规划值；备份加密且存放在应用主机之外，数据库与媒体需可恢复配对。每次上线前/重大升级后恢复到隔离环境，记录完成时间、校验和缺失项。
- 健康检查分 liveness/readiness；readiness 检查 DB/依赖但不得暴露凭证；支付、通知等第三方状态以后台连接状态/告警展示。
- 目标基线：已约定数据量与机器规格下商品主内容 p75 ≤ 2.5 秒、内部关键 API p95 ≤ 800ms；日备份规划 RPO ≤ 24 小时、RTO ≤ 8 小时。以上是验收目标，不是没有合同约束的 SLA。
- 支持访问采用客户授权、限时账号、工单关联和审计；到期关闭。部署退出执行双重确认、业务数据导出、密钥轮换/撤销、主数据删除审批和备份轮转记录。

## 11. 模块 Done 与验收证据

每个模块的验收以模块文档中的条件为准，并必须附可复核证据：

1. 页面状态（正常、空、加载、字段错误、无权限、服务异常）和简繁英文案。
2. API/OpenAPI、权限点、数据库迁移、审计对象、幂等和并发/重复行为。
3. 正常流程、拒绝流程、外部超时/未知状态、人工补偿流程。
4. 移动端与桌面端；客户前台依该客户签字页面清单单独验收。
5. 指标/导出能追溯到来源数据，脱敏和过滤规则可复核。
6. 操作手册、部署/迁移/备份说明、必要的回滚或修复步骤同步更新。

“页面有入口”“数据库有字段”不算完成；业务流程必须能从起点走到终态，异常时有可见状态和安全恢复办法。

### 11.1 M00–M16 完成范围与验收主文件

| 模块 | 本期必须闭环的能力 | 细节与签收主文件 |
|---|---|---|
| M00 | 后台登录、员工生命周期、权限、MFA、审计、会话撤销 | [M00](../01-产品文档/modules/M00_ADMIN_ACCESS.md)；本规格第 7 节 |
| M01 | 店铺初始化、三语、市场开关、币种/时区、配置版本 | [M01](../01-产品文档/modules/M01_STORE_LOCALE.md)；第 2 节 |
| M02 | 响应式独立前台、公开 API、预览、SEO/URL 输出 | [M02](../01-产品文档/modules/M02_STOREFRONT.md)、[`docs/02-设计文档/STOREFRONT.md`](../02-设计文档/STOREFRONT.md) |
| M03 | 商品/变体/SKU/分类/品牌/多语言/可售校验 | [M03](../01-产品文档/modules/M03_CATALOG.md)；第 4 节 |
| M04 | CMS/首页陈列草稿、预览、发布、定时、回滚、重定向 | [M04](../01-产品文档/modules/M04_CONTENT_CMS.md)；第 8.1–8.2 节 |
| M05 | 商品批量导入预览、行级错误、部分/原子执行和受控导出 | [M05](../01-产品文档/modules/M05_IMPORT_EXPORT.md)；第 8.3 节 |
| M06 | 访客购物袋、报价、优惠/运费校验、幂等下单 | [M06](../01-产品文档/modules/M06_CART_CHECKOUT.md)；第 5–6 节 |
| M07 | 订单快照、状态、人工履约、分包裹、地址修改审计 | [M07](../01-产品文档/modules/M07_ORDERS.md)；第 6 节 |
| M08 | COD/线上适配器、回调/查询、退款台账、结算文件对账 | [M08](../01-产品文档/modules/M08_PAYMENTS.md)；第 5–6 节 |
| M09 | 区域/运费/免运、配送报价、人工多包裹履约 | [M09](../01-产品文档/modules/M09_DELIVERY.md)；第 2、5 节 |
| M10 | 顾客/会员档案、邮箱 OTP、等级积分、同意与隐私请求 | [M10](../01-产品文档/modules/M10_CUSTOMERS_MEMBERS.md)；第 5 节 |
| M11 | 优惠创建/发放/占位/核销/返还及营销同意联动 | [M11](../01-产品文档/modules/M11_PROMOTIONS.md)；第 5–6 节 |
| M12 | SKU 级库存、预留、流水、超时恢复、低库存预警 | [M12](../01-产品文档/modules/M12_INVENTORY.md)；第 5–6 节 |
| M13 | 三语交易通知、模板版本、幂等发送、重试/死信/重发 | [M13](../01-产品文档/modules/M13_NOTIFICATIONS.md)；第 4.3、8.4 节 |
| M14 | 交易经营报表、匿名访问漏斗、指标字典、受控导出 | [M14](../01-产品文档/modules/M14_REPORTS.md)；第 4.3、9 节 |
| M15 | 独立安装、配置、密钥、升级、备份恢复、迁出/停用 | [M15](../01-产品文档/modules/M15_SECURITY_DEPLOYMENT.md)；第 3、9–10 节 |
| M16 | 取消/退款/退货/换货案件、质检、退款与库存联动 | [M16](../01-产品文档/modules/M16_AFTERSALES.md)；第 6 节 |

### 11.2 自动化测试与发布证据

- 测试分层、覆盖规则、缺陷级别和质量门禁见 [测试策略](../04-测试文档/TEST_STRATEGY.md)；编号场景见 [测试用例矩阵](../04-测试文档/TEST_CASES.md)；生产演练见 [生产就绪验收](../04-测试文档/PRODUCTION_READINESS_ACCEPTANCE.md)。
- 每个实现模块至少提交领域单元测试、数据库/API 集成测试和对应功能用例；关键交易/发布/隐私链路还要有浏览器端到端测试。
- 单元测试不能替代数据库事务、锁、唯一约束、幂等、webhook 重放和实例隔离的集成验证。
- 开发前文档中定义的用例是待实现/待执行规格，不代表测试代码已写、结果已通过。每次发布须记录 build、commit、环境、用例结果、证据及例外签字。

## 12. 客户输入与上线阻断清单

### 12.1 需要客户/专业顾问填写，不得由开发编造

经营主体和首发市场；商品准入/年龄验证/内容审查责任；税费/发票口径；支付服务商、商户账户和退款/结算能力；COD 区域/上限/收款责任；配送区域、价格和时效；会员等级/积分/退款扣回规则；通知渠道及已审批模板；隐私告知、资料保留/请求处理期限及责任人；分析告知/保留策略；域名、索引策略、旧 URL 映射；云资源、备份/恢复合同目标、支持时段；客户专属前台页面/状态/交互、视觉稿、三语内容、源码/IP/变更责任。

完整表格见 `CLIENT_LAUNCH_INPUTS.md`。空项有责任人/截止日期前只阻断相应功能，不阻断不依赖它的模板基础开发。

### 12.2 生产交易硬门槛

以下全部签字且预发布演练通过，才能开放真实交易：

- 市场/商品审查人和启用市场配置已批准；禁售/资格规则可执行。
- 生产域名、HTTPS、公开索引/隐私政策和页面内容已批准。
- 基础币种、价格/税费口径、配送区域/价格、COD 可用条件已确认。
- 至少一个付款方式已配置并可用；线上支付需服务商批准、正式凭证、回调验证和退款/查询演练。
- 员工账号、角色、MFA、隐私请求负责人和通知发件配置完成。
- 实际商品、三语、订单/取消/退款/退货/超时支付和分批发货场景验收完成。
- 备份恢复、升级/回滚、密钥轮换、日志脱敏、通知失败和支持联系人验收完成。

未完成项对应功能保持关闭，不以“之后补资料”绕过上线门槛。

## 13. 开发准备与估算状态

模板核心的产品/业务/技术及测试规则已有可执行基线，可以进入工程准备及依赖已冻结模块的研发拆解。现有文档包含 API 路由/请求字段契约、OpenAPI 初稿和测试用例规格；R1 还需补齐 operation-specific 响应 schema、完成权限/安全审查、校验并试编译生成客户端，之后再开放依赖接口的模块开发。应用骨架、数据库迁移、事件 schema、测试框架/fixture/CI，并逐模块实现及执行自动化测试也属于工程实施产物，不是待业主再讨论的产品决策。

历史人日和日历工期仍标为规划参考，未按本规格、会员完整范围、支付对账、售后、独立前台及部署验收重新估算。不得引用旧合计作为承诺报价；需以实施团队、首店页面清单、支付服务商和客户输入表完成后重新估算。

## 14. 官方技术参考

- [Node.js 官方版本表](https://nodejs.org/en/about/previous-releases)：生产使用受维护的 LTS 版本。
- [Next.js 16 升级指南](https://nextjs.org/docs/app/guides/upgrading/version-16)：Next 16 运行时、TypeScript 与迁移约束。
- [NestJS 官方入门文档](https://docs.nestjs.com/first-steps)：Node.js 要求和框架基础。
- [PostgreSQL 版本支持策略](https://www.postgresql.org/support/versioning/)：主版本支持周期及小版本更新策略。
- [Prisma ORM 版本状态](https://www.prisma.io/docs/orm/release-status)：当前 Prisma 8 文档仍标注为 Release Candidate；因此首期选择已 GA 的 Prisma 7，不使用预发布 ORM 处理订单/付款。
