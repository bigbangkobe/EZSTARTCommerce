# 上线验收测试用例（方案 C）

> 版本：v1.0　日期：2026-11-20　状态：待执行
> 范围：mrinhk 上线验收 + 烟草客户复制前置验证。
> 定位：本文件是**本期上线门禁用例**，与功能矩阵 [TEST_CASES.md](TEST_CASES.md) 互补——后者覆盖全功能回归，本文件只覆盖"这次上线必须证明的事"。
> 依据：[开发方案与排期](../03-开发文档/DEVELOPMENT_PLAN.md) · [支付适配器规格](../03-开发文档/PAYMENT_ADAPTER_SPEC.md) · [技术架构 v2.0](../03-开发文档/ARCHITECTURE.md)

---

## 0. 使用说明

| 项 | 约定 |
|---|---|
| 级别 | **P0** 上线阻断；**P1** 上线前必须修复；**P2** 可带缺陷上线但需登记 |
| 环境 | `staging` 执行全部；标注 ⚑ 的用例在生产**只读验证** |
| 证据 | P0 用例必须留：截图/请求响应/DB 查询结果/日志片段 |
| 通过标准 | P0 100% 通过，P1 ≤ 0 个未修复，P2 有书面接受记录 |

**总计 78 条**：P0 41 条、P1 27 条、P2 10 条。

---

## A. 支付适配器抽象（PA）

| ID | 用例 | 预期结果 | 级别 |
|---|---|---|---|
| PA-01 | 后台 PATCH 未登记渠道（如 `alipay_direct`） | 返回 `UNSUPPORTED_PAYMENT_PROVIDER`，配置不落库 | P0 |
| PA-02 | 已登记渠道（`cod`）改 displayName | 更新成功，version +1，返回新 version | P0 |
| PA-03 | `publicConfig` 塞入非白名单键（如 `apiKey`） | 返回 `PUBLIC_CONFIG_KEY_NOT_ALLOWED` | P0 |
| PA-04 | `publicConfig` 塞入密钥形状值（`sk_live_xxx`） | 键不在白名单即拒绝；即使键合法，值超 200 字符或含控制字符也拒绝 | P0 |
| PA-05 | `secretRef` 传 `sk_live_abc` | 返回 `SECRET_REFERENCE_INVALID` | P0 |
| PA-06 | `secretRef` 传 `secret://aws-sm/ezstart/mrinhk/payment/xxx` | 接受并落库，DB 中只有引用字符串 | P0 |
| PA-07 | 线上渠道 `enabled=true` 但 `secretRef` 为空 | 返回 `PAYMENT_CREDENTIAL_REQUIRED` | P0 |
| PA-08 | `enabled=true` 但 `approvalReference` 为空 | 返回 `PAYMENT_APPROVAL_REQUIRED` | P0 |
| PA-09 | 并发两次 PATCH 同一 method（version 相同） | 一条成功、一条 `VERSION_CONFLICT`，不出现丢失更新 | P1 |
| PA-10 | 适配器返回原始状态字符串（如 `TRADE_SUCCESS`） | 归一化为内部状态后才落库，DB 无渠道原始值 | P0 |

---

## B. 线上支付通道（OG）

| ID | 用例 | 预期结果 | 级别 |
|---|---|---|---|
| OG-01 | 正常下单 → 创建支付 → 跳转收银台 | 生成 `Payment` 记录，`status=pending`，`providerTransactionId` 非空，`redirectUrl` 可访问 | P0 |
| OG-02 | 沙箱完成支付 → 回调 → 查询订单 | 订单 `paymentStatus=succeeded`，`Payment.paidAt` 有值，`PaymentEvent` 有对应记录 | P0 |
| OG-03 | 沙箱支付失败 | `Payment.status=failed`，订单不进入已付，库存占位按规则释放 | P0 |
| OG-04 | 用户在收银台取消 | `Payment.status=cancelled`，订单可重新支付（同一 `Payment` 重试或新建，规则一致） | P0 |
| OG-05 | 退款全额 | 调渠道退款成功，`Refund` 记录状态正确，订单售后台账一致 | P0 |
| OG-06 | 退款金额大于已收 | 拒绝，返回金额类错误，不产生 `Refund` | P0 |
| OG-07 | 创建支付重试（网络超时后重发） | 渠道侧只有一笔单（幂等键 = `paymentNumber`），本地只有一条 `Payment` | P0 |
| OG-08 | 渠道返回 `unknown` 状态 | `Payment.status=unknown`，**不释放库存、不改订单为失败** | P0 |
| OG-09 | `unknown` 后由 `queryPayment` 收敛为成功 | 状态前进为 `succeeded`，台账与订单同步 | P0 |
| OG-10 | 后台尝试把 `unknown` 手工改为失败 | 返回 `PAYMENT_STATUS_UNKNOWN_REQUIRES_PROVIDER` | P0 |
| OG-11 | 支付金额与订单总额差 1 分 | 返回 `PAYMENT_AMOUNT_MISMATCH`，不入账 | P0 |
| OG-12 | 币种不一致 | 返回 `PAYMENT_CURRENCY_MISMATCH` | P1 |
| OG-13 | 后台点"测试连接"（凭据正确） | `connectionStatus=verified`，`lastCheckedAt` 更新 | P0 |
| OG-14 | 测试连接（凭据错误） | `connectionStatus=failed`，返回脱敏原因（无密钥、无完整响应体） | P0 |
| OG-15 | `enabled=true` 但 `connectionStatus=failed` | 前台结算页**不展示**该支付方式 | P0 |
| OG-16 | 修改配置后不重启服务 | 新配置在 5 分钟内生效（缓存 TTL），前台展示随之变化 | P0 |

---

## C. 密钥与配置（CFG）

| ID | 用例 | 预期结果 | 级别 |
|---|---|---|---|
| CFG-01 | `secret://aws-sm/<name>` 解析 | 返回凭据，进程内缓存命中，5 分钟内不重复请求 | P0 |
| CFG-02 | 引用指向不存在的 secret | 抛错，**不回退空凭据**，支付功能标记不可用 | P0 |
| CFG-03 | 生产环境配置 `secret://env/PAY_KEY` | 启动期校验拒绝（或配置标红阻断），不允许生产用 env 形态 | P0 |
| CFG-04 | IAM Role 只授本实例前缀 | 访问其他客户前缀 secret 被拒绝（AccessDenied） | P0 |
| CFG-05 | 全链路日志检索密钥明文 | 0 命中（应用日志、访问日志、错误信息、`Payment.metadata`） | P0 |
| CFG-06 | 密钥轮换后 | 缓存过期后新密钥生效，旧密钥失效不影响已入账订单 | P1 |
| CFG-07 | 后台配置页对无权限角色可见 | `payment.config` 权限缺失时接口 403，页面不渲染敏感字段 | P0 |
| CFG-08 | 审计日志 | 每次配置变更记录 actor、时间、变更字段（不含密钥值） | P1 |

---

## D. 回调与幂等（WH）

| ID | 用例 | 预期结果 | 级别 |
|---|---|---|---|
| WH-01 | 合法回调 | 200，状态前进，`PaymentEvent` 新增一条 | P0 |
| WH-02 | 同一回调重复推送 5 次 | 首次 200 入账，后续 4 次均 200 但**不产生新记录**（`dedupeKey` 唯一约束） | P0 |
| WH-03 | 签名错误 | 400，不落任何台账，不改任何状态 | P0 |
| WH-04 | 时间戳超出 ±5 分钟 | 拒绝（400/408），不落库 | P0 |
| WH-05 | `rawBody` 被 JSON 重新序列化后验签 | 抓包比对：线上代码使用原始字节，造一条字段顺序不同的回调仍验签通过 | P0 |
| WH-06 | 回调单号在本地不存在 | 返回 200 + 记死信（避免渠道重试风暴），死信可查询 | P0 |
| WH-07 | 乱序回调（先收到 succeeded 再收到 pending） | 后者不推进状态，记 `PAYMENT_STATE_CONFLICT` 异常，状态保持 succeeded | P0 |
| WH-08 | 回调金额与订单不符 | 不推进状态，记异常 + 触发告警 | P0 |
| WH-09 | 未启用/不存在的 provider 回调 | 404，不泄露 provider 是否存在 | P1 |
| WH-10 | 回调并发 20 次 | 只产生一条 `PaymentEvent`，无死锁，无 5xx | P1 |
| WH-11 | 死信重放 | 重放后台账正确，不重复入账 | P1 |

---

## E. COD 与对账（COD）

| ID | 用例 | 预期结果 | 级别 |
|---|---|---|---|
| COD-01 | 下单选 COD，未发货登记收款 | 返回 `ORDER_NOT_SHIPPED` | P0 |
| COD-02 | 发货后登记收款 | `status=collected`，订单 `paymentStatus=collected` | P0 |
| COD-03 | 登记拒收无原因 | 返回 `REASON_REQUIRED` | P0 |
| COD-04 | 登记拒收有原因 | `status=rejected`，库存/售后按规则处理 | P0 |
| COD-05 | 已收后登记退回 | `status=returned`，退款/售后链路可继续 | P0 |
| COD-06 | 收款时间早于下单时间 | 返回 `PAYMENT_TIME_INVALID` | P1 |
| COD-07 | 结算导入对账文件 | 差异进入差异队列，金额匹配项标记已对账 | P1 |
| COD-08 | 已取消订单登记收款 | 返回 `ORDER_ALREADY_CANCELLED` | P1 |
| COD-09 | 线上渠道 `pending` 超 15 分钟 | 对账任务拉起 `queryPayment` 并收敛状态 | P1 |

---

## F. 烟草合规（TOB）

| ID | 用例 | 预期结果 | 级别 |
|---|---|---|---|
| TOB-01 | 首次访问未确认年龄 | 拦截页出现，无法浏览商品详情 | P0 |
| TOB-02 | 直接访问商品 URL（绕过入口） | 仍被拦截或跳转年龄门 | P0 |
| TOB-03 | 篡改 cookie/localStorage 年龄标记为伪造值 | 服务端校验失败，回到年龄门 | P0 |
| TOB-04 | 结账时年龄未确认 | 服务端拒绝下单（非仅前端隐藏按钮） | P0 |
| TOB-05 | 商品页健康警示 | 按法务文案展示，文案来源为配置而非硬编码 | P0 |
| TOB-06 | 结算页健康警示 | 同上，且下单前可见 | P0 |
| TOB-07 | 牌照/许可信息展示 | 页脚或指定位置展示，内容可后台配置 | P0 |
| TOB-08 | 销售限制（如单笔数量上限） | 超限被拦截，服务端校验 | P1 |
| TOB-09 | 配送环节年龄复核 | 履约流程含复核步骤，未复核不可完成交付 | P1 |
| TOB-10 | 广告/促销用语限制 | 受限用语不出现在前台可配置文案中（抽检 + 词表扫描） | P1 |
| TOB-11 | 未成年人下单举报入口 | 存在且可达，提交有记录 | P2 |

---

## G. 前台配置化（THM）

| ID | 用例 | 预期结果 | 级别 |
|---|---|---|---|
| THM-01 | 后台改主题色/字体 → 发布 | 前台刷新后生效，无需重新构建镜像 | P0 |
| THM-02 | 未发布草稿 | 前台仍是已发布版本，草稿不外泄 | P0 |
| THM-03 | 回滚到上一版本 | 前台恢复到旧版本，配置完整 | P1 |
| THM-04 | 配置非法值（颜色格式错误） | 保存被拒，给出字段级错误，不污染已发布版本 | P0 |
| THM-05 | 实例配置 `instance.yaml` 校验 | 非法值被 `instance:validate` 拒绝，字段路径准确 | P0 |
| THM-06 | 上线阻断项未满足 | `canLaunch=false`，`launchBlockerStatus` 列出未满足项 | P0 |
| THM-07 | 首页区块增删排序 | 前台顺序与后台一致，空区块不留白 | P1 |
| THM-08 | 多语言切换 | 文案随 locale 变化，缺失回退到默认语言 | P1 |

---

## H. 部署与运维（OPS）

| ID | 用例 | 预期结果 | 级别 |
|---|---|---|---|
| OPS-01 | `instance:init --dry-run` | 只输出计划，不写文件、不连生产库 | P0 |
| OPS-02 | `instance:init` 生成实例目录 | 目录结构完整，含 `.env`、compose、Caddyfile、deploy.sh | P0 |
| OPS-03 | 生成的密钥 | 随机生成且非空，`.env` 权限 600，LF 换行 | P0 |
| OPS-04 | `deploy.sh` 在 Linux 执行 | shebang 有效，迁移 → 启动 → 健康检查顺序正确 | P0 |
| OPS-05 | 数据库迁移 | 全部迁移成功，无待应用迁移残留 | P0 |
| OPS-06 | 健康检查 `/health/live`、`/health/ready` | live 200；ready 在 DB 不可用时 503 | P0 |
| OPS-07 | 域名 HTTPS ⚑ | 证书有效，HTTP 301 到 HTTPS，HSTS 头存在 | P0 |
| OPS-08 | 公网端口扫描 ⚑ | 仅 80/443 开放；DB/API/Worker 无公网端口 | P0 |
| OPS-09 | 备份 | 全量备份成功，文件可读，异地/异桶存储 | P0 |
| OPS-10 | 恢复演练 | 从备份恢复到新实例，数据行数与业务抽查一致，记录 RTO/RPO | P0 |
| OPS-11 | 回滚 | 回退到上一镜像版本，服务可用，数据兼容 | P0 |
| OPS-12 | 镜像发布 | CI 构建推 ECR，服务器只拉取，不本地构建 | P1 |
| OPS-13 | 告警触发 | 制造 5xx / 支付失败率升高，告警送达责任人 | P0 |
| OPS-14 | 证书到期告警 | 提前 30/14/7 天有告警 | P1 |
| OPS-15 | `fleet:upgrade --dry-run` | 输出待升级实例清单，不执行 | P1 |
| OPS-16 | 磁盘/内存水位 | 有监控与告警阈值，4 GB 实例无 OOM 记录 | P1 |

---

## I. 安全（SEC）

| ID | 用例 | 预期结果 | 级别 |
|---|---|---|---|
| SEC-01 | 无 `payment.config` 权限调 PATCH | 403，无副作用 | P0 |
| SEC-02 | 越权访问他人订单（改 orderId） | 404/403，不泄露存在性 | P0 |
| SEC-03 | CSRF：无 token 的写操作 | 拒绝 | P0 |
| SEC-04 | SQL 注入尝试（搜索/筛选参数） | 参数化生效，无报错泄露 SQL | P0 |
| SEC-05 | 上传非法文件类型/超大文件 | 拒绝，错误信息不含服务器路径 | P1 |
| SEC-06 | 错误页泄露堆栈 | 生产不返回堆栈与内部路径 | P1 |
| SEC-07 | 安全响应头 | CSP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy 存在 | P1 |
| SEC-08 | 后台会话 | 超时登出、密码重置流程有效、登录失败限流 | P1 |
| SEC-09 | 审计覆盖 | 配置变更、退款、权限变更均留痕 | P1 |

---

## J. 性能（PERF）

| ID | 用例 | 预期结果 | 级别 |
|---|---|---|---|
| PERF-01 | 首页（缓存命中） | p95 < 800ms | P1 |
| PERF-02 | 商品详情页 | p95 < 1s | P1 |
| PERF-03 | 结算页 | p95 < 1.5s | P1 |
| PERF-04 | 支付回调接口 | p95 < 500ms，20 并发无 5xx | P0 |
| PERF-05 | 下单接口 | p95 < 1s，无超卖、无重复单 | P0 |
| PERF-06 | 50 并发浏览 + 5 并发下单 | 无 5xx，错误率 < 0.5%，CPU < 80% | P1 |

---

## K. 端到端旅程（E2E）

| ID | 用例 | 预期结果 | 级别 |
|---|---|---|---|
| E2E-01 | 新客：年龄门 → 浏览 → 加购 → 线上支付 → 订单成功 | 全链路通过，库存扣减、台账、邮件/通知一致 | P0 |
| E2E-02 | 老客：登录 → 下单 COD → 发货 → 收款 | 全链路通过 | P0 |
| E2E-03 | 退款：已付订单 → 申请售后 → 批准 → 退款 → 完成 | 状态与金额一致，渠道退款成功 | P0 |
| E2E-04 | 后台自助配支付：填配置 → 测试连接 → 启用 → 前台可见 → 走通一笔 | 全程不改代码、不重启 | P0 |
| E2E-05 | 复制演练：用烟草客户配置起 staging 实例 | 只改配置即可起站，`instance:validate` 通过 | P0 |

---

## L. 用例与门禁映射

| 门禁 | 必须通过的用例 |
|---|---|
| G2 支付链路 | A 全部、B 全部、D 全部、CFG-01~05 |
| G3 合规与对账 | E 全部、F 全部、THM-01~06 |
| G4 基础设施 | OPS-01~11、OPS-13 |
| G5 测试与安全 | I 全部、J 全部、OPS-12/14/15/16 |
| G6 上线 | E2E 全部 + 10 项签字 |

---

## M. 执行记录模板

| 日期 | 用例 ID | 环境 | 结果 | 证据链接 | 缺陷单 | 执行人 |
|---|---|---|---|---|---|---|
| | | | 通过/失败/阻塞 | | | |

> 失败用例必须挂缺陷单；阻塞用例必须写清阻塞原因（环境、账号、依赖），不能只写"未执行"。
