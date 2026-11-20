# EZSTARTCommerce 数据模型方案

跨模块固定实体、金额/时间约定与状态机以 [开发执行规格](DEVELOPMENT_SPEC.md) 为准；本文件描述关系和字段模型。

后台身份生命周期的初始 Prisma 模型与迁移已落地，见 [身份实现说明](R1_IDENTITY_IMPLEMENTATION.md)。BootstrapState 对应开通状态；AdminChallenge 合并承载受限挑战与待 MFA 登记字段；MfaFactor、RecoveryCode 和 AdminSession 保存因子/恢复码/会话；AdminInvitation 与 AdminPasswordReset 保存一次性邀请/重设凭据；IdentityNotificationJob 按 kind 承载两类单次秘密的加密待投递任务，数据库约束保证每个任务只对应一种目标。StoreConfig（单实例单店铺，id=1）、MarketProfile 与 MarketReviewRecord 已随第七条迁移落地：审核是追加历史，数据库约束保证“启用即已审核”且默认语言属于启用语言；第八条迁移落地 Category/Brand/Product 及其翻译、规格、图片、属性、分类关联与 InventoryItem（仅数量，流水由 M12 引入）；购物、订单、支付等交易实体仍待迁移实现。完整契约见 [身份生命周期数据约束](ADMIN_IDENTITY_LIFECYCLE.md#数据审计及交付门槛)。

## 1. 建模原则

- 领域模型保持通用电商语义，烟草类目作为商品/店铺配置，不作为独立硬编码主表。
- 本项目按每商家独立部署和独立数据库建模；如保留 store_id/instance_id，仅用于商店识别、迁移、导出和审计，不把它作为共享数据库的隔离机制或当前架构前提。
- 订单保存交易发生时的价格、商品名称、规格、语言、地址、运费和折扣快照，不能依赖商品当前值还原历史订单。
- 金额使用整数最小货币单位，并同时保存币种代码；禁止用浮点数累计金额。
- 多语言字段按可查询的翻译实体管理，避免将 zh/en/hk 字段散落在每个业务表中。
- 顾客资料与交易数据分离；限制访问、保留期限、删除/匿名化规则须由目标市场审查后配置。
- 每个有运营影响的后台变更保留操作者、时间、对象和变更摘要。

## 2. 领域关系概览

| 领域 | 核心实体 | 主要关系 |
|---|---|---|
| 商店配置 | StoreConfig、LocaleConfig、MarketProfile、FeatureFlag | 一店配置多语言、市场和功能开关 |
| 管理身份 | AdminUser、Role、Permission、AdminSession、MFAFactor、AuditLog | 用户通过角色获得权限；高权限账号启用 MFA，会话可撤销，关键操作可审计 |
| 商品目录 | Product、ProductTranslation、Variant、Category、Brand、MediaAsset | 一个商品有多个翻译、规格、图片和分类关联 |
| 内容/陈列 | ContentPage、Article、FAQItem、HomepageSection、ProductPlacement、PublishVersion、Translation、SeoRedirect、Collection、CollectionProduct | 页面和陈列配置按语言/版本发布；主题区块引用商品/分类；专题是跨分类的商品策展位；改 slug 保留重定向 |
| 购物 | Cart、CartItem、CheckoutSession | 访客购物会话包含多个商品规格 |
| 交易 | Order、OrderItem、Payment、PaymentEvent、Refund、Shipment、ShipmentItem | 订单包含商品快照、付款/退款流水和一个或多个包裹履约记录 |
| 结算对账 | SettlementBatch、SettlementLine、ReconciliationMatch | 服务商结算行与支付/退款台账匹配；差异保留原始记录并人工审计 |
| 促销 | Coupon、CouponRule、CouponRedemption | 优惠券由订单/顾客核销，订单保存优惠快照 |
| 顾客/会员 | Customer、MemberProfile、MembershipTier、PointAccount、PointLedger、OtpChallenge、ConsentRecord、CustomerPrivacyRequest | 访客可独立结账；会员用已验证联系方式自愿登录；顾客资料请求经身份核验后受控处理 |
| 库存 | InventoryItem、StockMovement、OrderReservation | SKU 库存变化有账目，订单可预留库存 |
| 通知 | NotificationTemplate、NotificationJob、DeliveryAttempt | 订单事件触发消息任务并记录发送结果 |
| 部署交接 | InstanceExportJob、DecommissionRecord | 商家业务数据可控导出；实例迁出/停用与备份轮转可审计 |
| 分析/导入导出 | AnalyticsEvent、AnalyticsSession、DailyMetricRollup、OrderAttribution、ImportJob、ImportRowResult、ExportJob | 网站事件形成匿名漏斗；经营报表以交易/库存数据汇总；导入保留行级结果，导出任务受权限和有效期控制 |
| 售后 | AfterSalesCase、AfterSalesItem、Refund、ReturnShipment、InspectionRecord、CaseEvent | 售后关联原订单、付款和库存流水；退款和案件状态独立 |
## 3. 关键数据对象草案

### StoreConfig

- id、store_name、brand_assets、domain、default_locale、base_currency、timezone、deployment_mode、created_at、updated_at。
- 首期实例独立，商店配置仅在该实例内生效。

### MarketProfile

- id、country_or_region_code、currency、timezone、enabled、review_status、reviewed_by、reviewed_at、review_notes。
- 未审核市场不得开放交易；法律判断由业主及专业顾问提供。

### Product / ProductVariant

- Product：id、sku_base、brand_id、status、category_ids、product_type、tax_class_ref、created_at、updated_at。
- ProductTranslation：product_id、locale、name、slug、description、seo_title、seo_description。
- Variant：id、product_id、sku、attributes、price_minor、compare_at_minor、currency、stock_tracking、status。
- 图片保存在对象存储，数据库存媒体 ID、顺序、替代文本及语言信息。

### Cart / CheckoutSession

- 使用随机 session token，不以顾客账号为前提。
- 保存商品规格、数量、创建/更新时间和有效期。
- 提交时重新从数据库核验商品、库存、优惠和配送金额；购物车展示金额不是结账可信金额。
- 可选 MemberSession 不作为 Cart/CheckoutSession 的前置条件；顾客主动登录并使用权益时，订单记录验证后的会员关联和权益计算快照。访客订单不得仅按未验证资料自动关联会员。

### Order / OrderItem

- Order：id、public_order_number、status、payment_status、currency、subtotal_minor、discount_minor、shipping_minor、tax_minor（适用时）、total_minor、customer_id（可空）、email/phone（按隐私策略保护）、created_at。
- OrderItem：商品 ID（可空以保留快照）、SKU、商品名/规格名快照、unit_price_minor、quantity、line_total_minor。
- OrderAddress：姓名、电话、国家/地区、行政区、地址字段和邮编；直接身份字段按开发执行规格进行实例级字段加密、权限遮蔽和审计访问。
- OrderStatusHistory：from_status、to_status、actor_id、note、created_at。
- 订单需保留结账语言、付款方式、配送方式、优惠券快照、会员身份/等级快照和积分规则版本引用。

### Payment / Shipment

- Payment：provider、provider_transaction_id、amount_minor、currency、status、created_at。
- PaymentEvent：外部事件 ID、验签结果、处理时间、幂等键、脱敏摘要。
- Refund：支付/售后引用、金额/币种、provider_refund_id、幂等键、状态、原因和操作者；不覆盖原 Payment。
- SettlementBatch/SettlementLine：服务商、结算期间、币种、原文件摘要、交易/退款号、毛额、手续费、净额、匹配状态和差异原因；重复导入可识别。
- Shipment：method、zone/rate snapshot、状态、发货/签收时间；订单可关联多个 Shipment。
- ShipmentItem：shipment_id、order_item_id、SKU 快照和本包数量；所有包裹数量累计不能超过订单数量。
- 支付凭证只放密钥管理服务，不保存卡号/CVV 等敏感支付数据。
- 结算银行账户由商户在支付服务商处绑定；本系统只保存必要的脱敏服务商状态/摘要，不保存完整银行账号或网银凭证。

### Customer / MemberProfile

- Customer：id、display_name、phone/email（规范化后、必要时加密）、source、created_at、updated_at。
- MemberProfile：customer_id、member_number、status、joined_at、membership_tier_id；等级是产品基线，等级门槛/周期由客户参数配置。
- ConsentRecord：purpose、channel、status、captured_at、source、policy_version。
- CustomerPrivacyRequest：id、customer_ref（可空，身份未确认时）、request_type（access/export/correct/withdraw_marketing/delete/anonymize）、source_channel、request_scope、verification_state、verification_method、verified_at、status、received_at、due_at、owner_id、reviewer_id、decision_at、decision_reason、retention_exception_ref、completed_at、export_job_ref；请求处理留审计，访问/导出短时授权，删除按已批准保留规则执行并与订单交易事实分离。
- ExportJob：id、requested_by、data_scope、redaction_policy_version、customer_privacy_request_id（可空）、status、created_at、expires_at、downloaded_at、purge_at；下载凭证短时有效，下载/过期清理均留审计，导出文件不进入普通日志或长期备份。
- 该模型不包含密码、登录凭证或顾客认证会话。

### Coupon / Inventory

- Coupon：code、type、value、valid_from/to、usage_limit、per_customer_limit、min_subtotal、eligible_scope、status。
- CouponRedemption：coupon_id、order_id、customer_id/session_ref、discount_minor、rule_version、state（reserved/redeemed/released）、reserved_at、redeemed_at、released_at、release_reason；状态转换幂等且额度预占事务化。
- InventoryItem：variant_id、on_hand、reserved、available、low_stock_threshold、updated_at。
- OrderReservation：order_id、variant_id、quantity、expires_at、status；支付状态未知时不得自动释放。
- StockMovement：variant_id、delta、reason、source_order_id、actor_id、created_at。
- 库存预留与扣减需事务处理，避免并发超卖。

### Merchandising / PublishVersion

- HomepageSection：page_key、section_type（主题注册类型）、position、visibility、locale/content reference、source rule、status。
- ProductPlacement：section_id、product_id、manual_rank 或 dynamic_sort_rule、market/channel scope。
- PublishVersion：配置快照/版本号、发布者、发布时间、当前状态，可回滚到上一个已发布版本。
- PublishSchedule：page_id、target_version_id、publish_at、unpublish_at、store_timezone、任务状态（scheduled/published/unpublished/skipped/failed）、失败原因与重试次数、created_by；首期每页最多一个待执行计划。撤下任务绑定版本，仅当前线上版本匹配时才执行。
- 前台仅消费已发布配置；商品可售性仍由商品状态、市场规则和库存服务端校验决定，陈列排序不能绕过规则。
- SEOFields：页面/商品/语言的 title、description、social_image、indexing_policy、canonical_ref；canonical/alternate URL 按实例域名、启用语言和已发布路由生成。
- SeoRedirect：store_id、locale、from_path、to_path、status_code（首期 301）、created_by、created_at、status；路径冲突或形成循环时拒绝发布。预览/草稿不得加入 sitemap，已发布且允许索引的路径才可输出。

### ContentPage / ContentPageVersion（M04 第一批已实现，202611180029）

- ContentPage：page_key（唯一，小写短横线）、page_type（standard/article/policy/faq/announcement）、blocks（草稿区块 JSON）、status（draft/scheduled/published/withdrawn）、position、scheduled_at、published_version_id、published_at、version（乐观锁）。
- ContentPageTranslation：page_id + locale（唯一）、title、slug（同语言内唯一）、seo_title、seo_description、indexable、published_slug（发布时写入、撤下清空，部分唯一索引）。
- ContentPageVersion：page_id + version（唯一）、release_seq（全局序列，派生内容发布标记 cr-N）、status（published/superseded/withdrawn）、snapshot（页面 + 三语翻译 + 区块的不可变 JSON）、published_at/published_by、note。
- ContentRelease：单行计数器，每次发布/撤下 +1；前台公开配置返回 cr-N，主题把它当区块埋点的 publish_version_id。
- 关键边界：前台只读 snapshot（草稿 slug 不进公开地址）；发布要求补齐店铺已启用语言；回滚用旧快照建新版本并同时恢复草稿；定时发布只登记计划，由 worker 到点执行，失败保留线上版本并写审计。

### ContentPreviewToken / SeoRedirect（M04 第二批已实现，202611190030）

- ContentPreviewToken：page_id、token_hash（SHA-256，唯一，明文 token 只在签发响应里出现一次）、locale、viewport（mobile/desktop）、expires_at、created_by。绑定签发时的草稿版本（版本不一致拒绝签发），默认 60 分钟、上限 24 小时；同页只保留最近 10 条有效链接。
- SeoRedirect：locale、from_path（唯一）、to_path、status_code（301/308）、page_id（可空，页面删除后置空但保留跳转）、created_by。CHECK 约束保证两端都是站内相对路径且不相同。
- 关键边界：预览只读草稿、不写 ContentRelease、不加载埋点；slug 变更时自动登记旧地址 → 新地址并把入站链改直；撤下页面时清理指向它的重定向；前台入口层缓存清单 30 秒后本地匹配，命中即 301。

### MerchandisingLayout / MerchandisingVersion（M04 第三批 202611190100；第四批 202611190120 扩到分类；第五批 202611200100 扩到专题）

- MerchandisingLayout：page_key（唯一，`home`、`category:<uuid>` 或 `collection:<uuid>`，第 32/33 条迁移用 CHECK 锁死这三种形状）、kind（home/category/collection；kind 必须与 page_key 形状一致）、sections（草稿区块 JSON）、status（draft/published）、version（乐观锁）、published_snapshot（线上不可变快照）、published_at/published_by、created_by/updated_by。
- 分类/专题版面都用 id 绑定而不是 slug：改名或改 slug 时已发布版面不会失联，也不会指到别的对象上。分类/专题被停用后版面仍在库里，但前台对应页面 404。
- MerchandisingVersion：layout_id + version（唯一）、snapshot（发布快照）、note、published_at/published_by；历史不可覆盖，回滚只能再发一版。
- 区块字段：section_id、type（服务端闭集，本批只有 product_grid）、visible、position（由数组顺序重排）、title_by_locale、sort_mode（manual/newest/fulfilled_sales_30d/price_asc/price_desc）、limit（1–24）、product_ids（手工顺序）、category_ids 与 collection_id（动态候选范围，两者叠加是「与」）。
- 关键边界：CHECK 约束保证「draft 无快照、published 必有快照」；保存草稿不动线上；发布要求三语标题齐全且手工商品全部可售，分类/专题版面还要求手工商品属于该范围（`MERCHANDISING_PRODUCT_OUT_OF_SCOPE`），专题版面里区块的 collection_id 必须等于本页专题（`MERCHANDISING_COLLECTION_OUT_OF_SCOPE`）；读取时重跑商品资格，手工区块失效商品隐藏并在后台标 issues，动态区块由后续候选补足；页面级范围（分类/专题）先收窄候选池，区块再在此范围内按规则筛选；发布同时推进 ContentRelease（区块埋点按新版本分组）。

### Collection / CollectionTranslation / CollectionProduct（M04 第五批 202611200100）

- Collection：position（前台列表顺序）、enabled、version（乐观锁）、created_at/updated_at。专题是临时策展位，可以随时新建/删除，不影响商品与分类本身。
- CollectionTranslation：collection_id + locale（唯一）、name（1–160）、slug（可空，同语言内唯一，只接受小写短横线形式）、description（可空）。slug 为空时该语言没有前台地址，列表与站点地图都不列。
- CollectionProduct：collection_id + product_id（联合主键去重）、position（运营编排顺序）。商品与专题是多对多：同一商品可以出现在多个专题里，专题也可以跨分类。
- SeoRedirect 新增 collection_id（可空，专题删除时置空并保留历史跳转）：专题改 slug 时登记旧地址 → 新地址 301；停用或删除专题时清理指向它的跳转，避免把访客送进 404。
- 关键边界：前台只列「启用 + 当前语言有 slug + 至少有一件当前市场可售商品」的专题；专题页优先渲染已发布版面，没有版面时按 position 平铺商品；专题页的候选池被锁定在该专题内，跨专题筛选保存即拒。

### SeoRedirect 归属（M04 第六批 202611200200）

- 归属字段：page_id（内容页）/ collection_id（专题）/ category_id（分类），都可为空（手工登记的跳转），三者互斥——CHECK `seo_redirect_single_owner` 保证 `num_nonnulls(...) <= 1`。归属字段决定停用/删除时的清理范围，多个归属并存会让「该不该跟着下线」变得不可推断。
- 写入口径：改 slug 时按语言登记旧地址 → 新地址 301，并把原本指向旧地址的跳转改直（连续改名后入站链接直达最新地址，不堆成链）；登记后若链路成环或自跳，宁可删掉这条记录，也不留下无限跳转。
- 清理口径：slug 清空、语言被删除、或新 slug 无法表达成站内路径时，删除 `to_path` 指向该旧地址的跳转；停用分类/专题（前台 404）时删除该归属的全部跳转，重新启用后地址由当前 slug 决定。删除对象时归属字段置空、跳转保留（历史链接仍能跳到当时的地址）。
- 地址形状：只接受站内 ASCII 路径（`normalizeRedirectPath`）。中文 slug 在前台可以访问（链接按百分号编码），但登记成跳转永远不会命中，因此分类/专题的 `sitePath` 对这类 slug 返回 null，服务层跳过登记而不是写坏记录。
- 清单口径：`GET /admin/redirects` 的 `page_key` 内容页用自身 page_key，专题/分类用陈列作用域 key（`collection:<id>` / `category:<id>`）；非空即表示这条跳转是改 slug 自动登记的，运营据此区分自动与手工。

### AfterSalesCase / Refund / Return

- AfterSalesCase：case_number、order_id、type、status、reason_code、customer_message、owner_id、source、created_at、closed_at。
- AfterSalesItem：case_id、order_item_id、requested_quantity、approved_quantity、line_refund_minor、disposition。
- Refund：payment_id（可空，如人工 COD 退款）、case_id、amount_minor、currency、provider_refund_id、idempotency_key、status、actor_id、reason、created_at。
- ReturnShipment：case_id、method、tracking_number、shipped_at、received_at、status。
- InspectionRecord：case_item_id、received_quantity、condition、inventory_disposition、actor_id、created_at。
- CaseEvent/CaseNote：from_status、to_status、actor/source、reason、created_at；内部备注与顾客可见文案分开保存。
- Refund 不覆盖原 Payment；累计成功/处理中退款不能超过可退实收额。退货库存处置必须生成 StockMovement。

## 3.1 分析事件与统计聚合

### AnalyticsEvent
- event_id（幂等 ID）、session_id（随机会话）、event_name、occurred_at（UTC）、locale、device_class、market_code、page_key、section_id、稳定的 section_key、placement_id、product_id、publish_version_id、interaction_id、environment（production/preview）、匿名 traffic_class（customer/staff/test/known_bot/suspected_bot）、consent_state、schema_version、referrer_host、UTM source/medium/campaign。
- 不得存姓名、电话、邮箱、地址、密码或支付资料；URL 参数先做过滤。
- 定制前台通过统一事件 SDK/适配器写入此契约；预览必须使用短时 token 并标记 environment=preview。员工流量由可信后台会话转换成短时内部标志，不写入员工账号 ID。正式报表排除 preview、员工、沙箱及测试订单；已知爬虫按版本化规则过滤，疑似机器人仅标记并允许过滤，以保留审计能力。

### AnalyticsSession / DailyMetricRollup
- AnalyticsSession：随机 session ID、首次/最近活动时间、入口页、来源/UTM、语言、设备类型；设置过期和保留策略。
- DailyMetricRollup：店铺日期、时区、指标名、维度和值，用于快速报表；可从原始事件按政策重算。
- OrderAttribution：订单与会话的可选关联及归因版本，不含直接身份信息。订单/支付数据库仍是成交金额权威来源。
- PlacementAttribution：cart_item_id、order_item_id、section_id、section_key、placement_id、product_id、publish_version_id、interaction_id、rule_version；单个订单行仅归因一个区块，不保存个人资料。订单金额、收款及退款仍由订单/支付账本提供。
- 陈列事件名：section_impression（可见曝光）、section_click（区块商品/CTA 点击）、placement_add_to_cart（服务端确认加购）、placement_order_attributed（服务端订单行归因）；均带 schema_version 与匿名幂等标识。
- ReportingCoverage：page_key、section_key、active_publish_version_id、last_event_at、coverage_status（healthy/missing/stale/error/no_traffic/unverified）、stale_after（按店铺流量/采集频率配置）、expected_event_types、observed_event_types、checked_at；结合页面访问事件标明主题埋点缺失/中断或无前台访问，避免把未采集显示成零曝光或误判为故障。
- 报表时间归属：行为事件按 occurred_at，归因订单数按 order.created_at，线上收款按成功入账时间，COD 按确认收款时间，退款按退款成功时间。陈列归因金额属于订单 cohort 指标，以所选订单创建期间的订单行为基础并按查询时收款/退款状态回算；经营现金流则按收款/退款实际发生日期单独统计。
- 订单行陈列实收按商品行金额统计：订单级优惠按优惠前商品行小计比例分摊，舍入余数按固定订单行顺序分配；配送费、税费和支付手续费排除；成功退款仅扣减关联订单行金额。COD 只有在明确收款状态后计入；未能关联订单行的退款进入未分摊金额，不强制归因到区块。

### 通知、审计与实例交接
- NotificationJob：业务事件类型/ID、收件目标引用（脱敏展示）、模板 ID/版本、locale、idempotency_key、创建/发送状态；业务事务提交后入队。DeliveryAttempt 记录渠道返回码、时间、脱敏错误和人工重发操作者/原因，不重复执行原业务动作。
- AuditLog：操作者、角色快照、动作、对象引用、结果、必要变更摘要、原因、时间和请求追踪 ID；普通后台只读不可编辑/删除，敏感值不进入摘要；保留期限及到期处置按实例策略。
- InstanceExportJob：实例 ID、请求人/审批人、导出范围、文件清单/校验值、创建/过期时间和状态；不包含密钥、OTP、会话令牌。DecommissionRecord 记录目标实例确认、数据交付、删除审批、主数据删除及备份轮转截止状态。

## 4. 状态模型

商品、内容发布、导入、购物车/结账、订单/支付/履约、退款、优惠占位、库存预留、隐私请求、通知和售后的规范状态以及允许转换均以 [开发执行规格第 6 节](DEVELOPMENT_SPEC.md#6-关键状态机与允许转换) 为准。实体字段应使用明确的枚举/受约束值并保存状态历史；不得新增“临时状态”或让后台绕过状态服务直接改字段。

## 5. 数据治理与安全要求

- 管理员按角色查看顾客联系方式；报表优先使用聚合数据。
- 日志和错误追踪不得包含完整地址、支付凭证、密码或访问令牌。
- 订单导出、顾客资料导出和库存调整均记录操作者。
- 备份加密并定期验证可恢复性。
- 顾客数据保留、删除、导出和营销同意流程按店铺目标市场确定。
- CSV 导入必须防止公式注入、恶意文件和字段越权覆盖。
- 管理界面显示本地时区，数据库时间统一使用 UTC 存储。

## 6. 已冻结的模型决策与实例参数

以下模型选择已冻结；每客户填写的是具体参数，不再重新选择数据结构：

| 项 | 模型基线 | 每实例需要补充 |
|---|---|---|
| 库存地点 | 首期单库存地点 | 仓库显示名称、发货地址；多仓另行变更 |
| 税费 | 支持可选税额快照，但默认税务关闭；模板不自行判断税法 | 已批准的市场计算规则、含税展示和发票需求 |
| 联系方式/地址 | 后台可读 PII 字段采用实例级应用层加密；独立 HMAC 索引用于精确查找；普通日志/事件不保存明文 | KMS/密钥托管、字段保留期、角色访问策略 |
| 会员 | MemberProfile、等级、积分账户/流水为 P0 | 客户等级门槛、周期、积分获取/兑换/过期及退款扣回规则 |
| 币种 | 每实例一个基础币种；多币种不在首期 | ISO 币种代码和金额小数位 |
| 保留/匿名化 | 订单与交易事实、会员/营销资料分域处理 | 具体留存期限、交易例外、隐私联系人和处理时限 |

跨模块状态、加密/密钥和金额规则见 [开发执行规格](DEVELOPMENT_SPEC.md)。
