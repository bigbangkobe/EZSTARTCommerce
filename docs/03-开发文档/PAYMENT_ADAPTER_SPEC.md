# 支付适配器与后台可配置规格

> 版本：v1.0　日期：2026-11-20　状态：已定稿（方案 C 范围）
> 目标：把"客户在后台填自己的收单账号"变成真实能力，同时不牺牲资金安全。
> 依据：[技术架构 v2.0](ARCHITECTURE.md) · [M08 支付](../01-产品文档/modules/M08_PAYMENTS.md) · [开发方案与排期](DEVELOPMENT_PLAN.md)

---

## 0. 一句话结论

**后台能配的是"账号"，配不出的是"驱动"。**

- 驱动（调 API、验签、字段映射、退款协议）= 代码，由我们写一次；
- 账号（商户号、密钥、环境、显示名、开关、批准依据）= 后台配置，每客户自己填；
- 密钥（私钥、API Secret）= 密钥管理服务，数据库只留引用。

三者分离后，新增客户接自己的收单通道 **不需要改代码、不需要重新部署**，只需在后台完成配置并通过连接测试。

---

## 1. 现状事实（2026-11-20 核对）

| 项 | 现状 | 结论 |
|---|---|---|
| 支付方式配置表 | `PaymentMethodConfig`：providerCode / environment / enabled / approvalReference / publicConfig / secretRef / connectionStatus / version | ✅ 已有，可复用 |
| 后台权限 | `payment.config`、`payments.read`、`payments.collect` | ✅ 已有 |
| 密钥存储 | 只存 `secretRef`（URI 形状，`secret://...`），显式拒绝 `sk_live_...` 明文 | ✅ 设计正确，但**无解析实现** |
| 支付方式白名单 | 仅 `cod`、`manual_bank_transfer` | ❌ 没有任何 `online` provider |
| 渠道状态机 | `online: [succeeded, cancelled, returned]` 已定义 | ✅ 可复用 |
| 支付回调入口 | 无；承运商已有 HMAC + 时间窗 webhook 可作范式 | ❌ 缺失 |
| 退款 | 台账 `Refund` 表存在，无渠道退款协议实现 | ❌ 缺失 |
| 对账 | COD 人工登记 + 结算导入基础 | ⚠️ 线上渠道对账缺失 |

**结论：配置容器齐全，驱动缺失。** 这不是配置能补的缺口。

---

## 2. 分层模型

```text
┌─────────────────────────────────────────────────────────┐
│ 后台配置台（客户/运营可操作）                            │
│  displayName · environment · publicConfig · enabled      │
│  approvalReference · secretRef(引用) · 连接测试          │
└───────────────────────┬─────────────────────────────────┘
                        │ 读配置
┌───────────────────────▼─────────────────────────────────┐
│ Provider Registry（代码闭集，编译期登记）                │
│  cod · manual_bank_transfer · <gateway>                  │
└───────────────────────┬─────────────────────────────────┘
                        │ 路由
┌───────────────────────▼─────────────────────────────────┐
│ PaymentAdapter（代码实现，每渠道一个）                   │
│  createPayment · queryPayment · refund · verifyWebhook   │
│  testConnection                                          │
└───────────┬──────────────────────────┬──────────────────┘
            │ 取密钥                    │ 对外请求
┌───────────▼───────────┐   ┌──────────▼──────────────────┐
│ SecretResolver        │   │ 收单机构 API                 │
│ aws-sm / ssm / env    │   └──────────┬──────────────────┘
└───────────────────────┘              │ 回调
                        ┌──────────────▼──────────────────┐
                        │ /webhooks/payments/:provider     │
                        │ 验签 → 归一化 → 幂等入账         │
                        └─────────────────────────────────┘
```

**不变式：** 后台永远不能凭空让一个渠道变成"可用"。`providers` 里没有 code，`PATCH /admin/payment-methods` 直接拒绝——避免配出一个没有适配器的空壳渠道（现有 `UNSUPPORTED_PAYMENT_PROVIDER` 已经这么做了，保留）。

---

## 3. 适配器统一契约

```ts
// packages/domain/src/payment-adapter.ts（仅类型与纯规则，不碰 IO）

export interface AdapterContext {
  readonly providerCode: string;
  readonly environment: 'sandbox' | 'production';
  /** 已解析的密钥，只在内存中存在，绝不写日志、绝不入库。 */
  readonly credentials: Readonly<Record<string, string>>;
  readonly publicConfig: Readonly<Record<string, string>>;
}

export interface CreatePaymentInput {
  /** 内部台账号，同时作为渠道侧幂等键。 */
  readonly paymentNumber: string;
  readonly orderNumber: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly returnUrl: string;
  readonly notifyUrl: string;
  readonly locale: string;
}

export interface CreatePaymentResult {
  /** 渠道侧单号；回调对账靠它。 */
  readonly providerTransactionId: string;
  /** 收银台跳转地址；无跳转（如直连扣款）时为 null。 */
  readonly redirectUrl: string | null;
  readonly rawStatus: string;
}

export interface QueryPaymentResult {
  /** 必须归一化到内部状态，不允许把渠道原始字符串直接落库。 */
  readonly status: 'pending' | 'authorized' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  readonly providerTransactionId: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly rawStatus: string;
}

export interface WebhookEvent {
  readonly providerTransactionId: string;
  readonly paymentNumber: string | null;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  readonly amountMinor: number | null;
  readonly currency: string | null;
  /** 渠道事件唯一 id，用于幂等；缺失时用 (单号+状态+时间戳) 派生。 */
  readonly eventId: string;
  readonly occurredAt: Date;
}

export interface PaymentAdapter {
  readonly code: string;
  readonly channel: PaymentChannel;
  /** 连接测试：用最小代价验证凭据有效、类目可用。 */
  testConnection(ctx: AdapterContext): Promise<{ ok: boolean; detail: string }>;
  createPayment(ctx: AdapterContext, input: CreatePaymentInput): Promise<CreatePaymentResult>;
  queryPayment(ctx: AdapterContext, providerTransactionId: string): Promise<QueryPaymentResult>;
  refund(ctx: AdapterContext, input: RefundInput): Promise<RefundResult>;
  /** 验签失败必须抛错，不允许返回"疑似成功"。 */
  verifyWebhook(ctx: AdapterContext, headers: Record<string, string>, rawBody: Buffer): Promise<WebhookEvent>;
}
```

### 3.1 硬约束（写死，不留给实现自由发挥）

1. **金额只收 minor units + currency**，适配器内部禁止浮点运算。
2. **幂等键固定为内部 `paymentNumber`**，重试沿用同一个，不允许每次生成新键。
3. **`unknown` 只能由 `queryPayment` 收敛**，后台无人工出口（沿用现有 `PAYMENT_STATUS_UNKNOWN_REQUIRES_PROVIDER`）。
4. **状态推进必须走 `nextPaymentStatus()`**，适配器只返回原始状态，不许自己写库。
5. **验签失败即拒绝**，返回 400 且不落任何台账。
6. **密钥不出 `AdapterContext`**，不进日志、不进 `Payment.metadata`、不进错误信息。

---

## 4. 密钥管理

### 4.1 引用协议

| 引用形式 | 解析来源 | 适用 |
|---|---|---|
| `secret://aws-sm/<name>` | AWS Secrets Manager | **生产推荐** |
| `secret://ssm/<name>` | SSM Parameter Store（SecureString） | 生产备选，成本更低 |
| `secret://env/<NAME>` | 进程环境变量 | 仅本地/dev，生产启动时拒绝 |
| `secret://file/<path>` | 挂载文件（600 权限） | 单机兜底 |

### 4.2 解析器

```ts
export interface SecretResolver {
  resolve(ref: string): Promise<Record<string, string>>;
}
```

- 进程内缓存 + TTL（默认 5 分钟），避免每次支付都打 Secrets Manager；
- 解析失败一律抛出，**不允许回退到空凭据**（否则会变成"静默无法收款"）；
- 启动时校验：`environment=production` 且 `secretRef` 为 `env`/`file` 形态 → 拒绝启动或标红阻断。

### 4.3 权限

实例 IAM Role 只授予本实例自己的 secret ARN：

```json
{
  "Effect": "Allow",
  "Action": ["secretsmanager:GetSecretValue"],
  "Resource": "arn:aws:secretsmanager:ap-northeast-1:<account>:secret:ezstart/<instanceId>/payment/*"
}
```

跨客户不可读：一个实例一个前缀。

---

## 5. 后台配置项清单

### 5.1 客户可自助

| 字段 | 校验 | 说明 |
|---|---|---|
| `displayName` | 1–80 字符，无控制字符 | 前台展示名 |
| `environment` | `sandbox` / `production` | 环境隔离，配置独立 |
| `publicConfig.accountSummary` | ≤200 字符 | 收款账户摘要，可公开 |
| `publicConfig.instructions` | ≤200 字符 | 转账说明等 |
| `publicConfig.defaultCurrency` | ISO 4217 | 币种 |
| `publicConfig.providerAccountRef` | ≤200 字符 | 渠道商户号（非密钥） |
| `secretRef` | 必须匹配 `secret://` 协议 | **只填引用，不填密钥本体** |
| `enabled` | boolean | 开关 |

### 5.2 需运营/我方填写

| 字段 | 原因 |
|---|---|
| `approvalReference` | 收单类目批复编号，合规留痕 |
| 密钥实际值 | 客户在 AWS 控制台或由我方代为写入 Secrets Manager |

### 5.3 代码内固化（不可配置）

- `providers` 列表与 `channel` 归属；
- 各渠道字段映射与验签算法；
- 状态归一化规则；
- `publicConfig` 白名单键（现有 `PUBLIC_CONFIG_KEYS`，不允许运营加键）。

**为什么 `publicConfig` 必须白名单**：否则客户能把密钥塞进 `publicConfig`，而它会随前台接口返回、进日志、进备份。

---

## 6. 回调与幂等

### 6.1 入口

```text
POST /webhooks/payments/:provider
```

- 无管理员会话、无 CSRF；身份只由签名 + 时间窗证明（沿用承运商 webhook 范式）；
- `rawBody` 必须保留原始字节，**不能先 JSON.parse 再验签**（签名针对原始字节）；
- 时间窗默认 ±5 分钟，超出直接拒绝。

### 6.2 处理顺序

```text
1. 查 PaymentMethodConfig(provider, environment) → 未启用/不存在 → 404（不泄露存在性）
2. 解析 secretRef → credentials
3. adapter.verifyWebhook() → 失败 400
4. 按 providerTransactionId 找 Payment → 找不到 → 记死信，返回 200（避免渠道无限重试）
5. dedupeKey = `${provider}:${eventId}` → 命中唯一约束 → 直接返回 200（幂等）
6. 校验金额/币种与订单一致 → 不符 → 记异常 + 告警，不推进状态
7. nextPaymentStatus() → 推进 → 写 PaymentEvent
8. 返回 200
```

**第 4 步为什么返回 200**：回调早于本地事务提交是常态，返回 5xx 会让渠道重试风暴；记死信后由对账任务补。但**第 3 步验签失败必须 400**，两者性质不同。

### 6.3 重复与乱序

- 重复：`PaymentEvent.dedupeKey` 唯一约束兜底，不靠应用判断；
- 乱序：只接受"状态前进"，回退事件记 `PAYMENT_STATE_CONFLICT` 异常但不改状态；
- 丢失：定时对账任务拉 `queryPayment` 补齐 `pending` 超 15 分钟的单。

---

## 7. 连接测试

后台点"测试连接"：

```text
resolve secretRef → adapter.testConnection()
  → ok: true  → connectionStatus = 'ok'，记 lastCheckedAt
  → ok: false → connectionStatus = 'failed'，返回脱敏原因（不含密钥、不含完整响应体）
```

- 测试连接**不创建真实支付**，用渠道提供的查询/鉴权接口；
- 失败原因脱敏：只回错误码 + 简短说明，禁止回显请求头；
- `enabled=true` 且 `connectionStatus != 'ok'` → 前台不展示该支付方式。

这条是"客户自助配置"的安全阀：配错了不会导致线上下单失败，只会不可见。

---

## 8. 客户自助配置流程（交付视角）

新客户接入自己的收单账号，**不改代码、不重新构建镜像**：

```text
1. 我方：确认该渠道适配器已登记（providers 有 code）
2. 客户：在 AWS Secrets Manager 写入密钥（或我方代写，客户给临时凭证）
3. 客户：后台填 displayName / environment / publicConfig / secretRef
4. 运营：填 approvalReference（类目批复）
5. 客户：点"测试连接" → ok
6. 运营：开启 enabled
7. 我方：跑一笔沙箱支付 + 一笔退款 + 一次重复回调验证
```

若客户渠道**不在** `providers` 内，则必须先新增适配器（约 5–10 人日/家），这是 B/C 类增值项，需单独报价。**这是"配置化"的真实边界，必须在售前说清楚。**

---

## 9. 分期

| 阶段 | 范围 | 人日 |
|---|---|---:|
| V1（本期 Must） | 适配器接口 + Registry + SecretResolver + 一个线上渠道 + 回调 + 退款 + 连接测试 | 10–15 |
| V1.5（本期 Should） | 对账任务（拉单补状态）+ 死信队列 + 告警 | 3–5 |
| V2（下一客户前） | 第二个渠道适配器 + 后台通道管理 UI 完善 | 5–10/渠道 |

V1 的抽象层必须一次做对，否则第二个客户会推倒重来。

---

## 10. 风险与坑

| 风险 | 表现 | 应对 |
|---|---|---|
| 收单不允许烟草类目 | 开通即被拒 | 售前先确认类目；备 COD 兜底 |
| 回调验签用了解析后 body | 上线后全部验签失败 | 只接受 rawBody；集成测试覆盖 |
| 密钥进了 `publicConfig` | 泄露到前台/日志 | 白名单键 + 代码审查 + 测试用例 |
| 渠道重试风暴 | 回调 5xx 导致队列堆积 | 找不到单返回 200 + 死信 |
| 金额浮点误差 | 少收/多收一分 | 全程 minor units，`assertPaymentAmount` 复用 |
| 时钟偏差 | 合法回调被判过期 | 时间窗 ±5 分钟，NTP 同步 |
| 沙箱与生产密钥混用 | 生产收到沙箱回调 | `environment` 严格隔离，回调路径带环境校验 |
| 适配器自己写库 | 绕过状态机 | 适配器只返回状态，写库集中在 service |

---

## 11. 验收

- [ ] `providers` 中新增渠道可被 `PATCH /admin/payment-methods` 接受，未登记渠道被拒。
- [ ] `secretRef` 为 `aws-sm` 时能解析；解析失败时启动/配置阶段报错，不静默降级。
- [ ] 沙箱完成：成功支付、失败支付、取消、退款、重复回调、乱序回调各一笔。
- [ ] 重复回调不产生第二条 `Payment`，`PaymentEvent` 不重复。
- [ ] 验签失败返回 400 且不落库；未知单返回 200 且进死信。
- [x] `enabled=true` 但连接未 `ok` 时前台不展示。
- [ ] 日志与错误信息中检索不到密钥明文。
- [ ] 后台修改配置后，**无需重启服务**即生效（配置读取 + 缓存 TTL）。

---

## 12. 落地状态（2026-11-20）

### 12.1 已完成：抽象层 + Mock 适配器（W2）

| 文件 | 内容 |
|---|---|
| `packages/domain/src/payment-adapter.ts` | `PaymentAdapter` 契约、`AdapterContext`、状态归一化、幂等键、金额校验、密钥引用解析、收银台可见性、metadata 防泄漏 |
| `packages/domain/src/payments.ts` | `ProviderDefinition.sandboxOnly`；`providers` 新增 `mock`（仅沙箱）；生产配置命中沙箱渠道返回 `PAYMENT_PROVIDER_SANDBOX_ONLY` |
| `apps/api/src/payments/adapters/registry.ts` | 适配器注册表：未登记渠道不可解析、`mock` 生产拒绝、与领域白名单强校验 |
| `apps/api/src/payments/adapters/mock.ts` | Mock 网关：创建幂等、查询未知→`unknown`、退款封顶、HMAC + 时间窗验签 |
| `apps/api/src/payments/adapters/secret-resolver.ts` | `secret://` 解析：`aws-sm` / `ssm` / `env` / `file`，TTL 缓存、生产禁 `env`/`file`、失败必抛 |
| `tests/payment-adapter.test.ts` | 12 条纯规则用例 |
| `tests/payment-adapters.test.ts` | 16 条适配器/注册表/密钥用例 |

**验证结果：**
- 本机 Node 24：新增 28 条全部通过；全量纯单元 **259/259** 通过，无回归。
- AWS 东京服务器（`node:24-alpine` 容器）：支付与领域用例 **55/55** 通过——确认不是只在 Windows 上能过。

### 12.2 关键实现决策

1. **`normalizeAdapterStatus` 永不抛错**：渠道新增状态应记 `unknown` 并告警，不能让回调 5xx 触发重试风暴。
2. **`mock` 进领域白名单但标 `sandboxOnly`**：否则后台配不出它；标了之后生产 PATCH 直接拒绝，避免假支付混进真实订单。
3. **`aws-sm` 用动态导入**：仓库暂未安装 `@aws-sdk/client-secrets-manager`，未安装时返回 `SECRET_PROVIDER_UNAVAILABLE` 而不是启动崩溃。**W2 接入前需补依赖**：
   ```bash
   pnpm add @aws-sdk/client-secrets-manager @aws-sdk/client-ssm --filter @ezstart/api
   ```
4. **密钥值必须是扁平 JSON 对象**：`{"apiKey":"...","webhookSecret":"..."}`。非 JSON 一律拒绝，避免"值读到了但字段名猜不到"的隐性故障。
5. **`connectionStatus` 取数据库约束值 `ok`，不是规格早期写的 `verified`**：`PaymentMethodConfig_connectionStatus_check` 只接受 `unverified / ok / failed`。改代码对齐约束，不动已上生产的迁移。
6. **适配器调用必须走异步转换器**：`adapterCall()` 用 `await` 包住 rejection。同步 `try/catch` 抓不到 async 抛错，漏了这层验签失败会变成 500，渠道就会无限重试。

### 12.3 已完成：业务编排接入（W3）

| 改动 | 内容 |
|---|---|
| `packages/domain/src/payments.ts` | 状态机新增线上渠道的 `failed` 出口；`failed` 与 `cancelled` 分开记，否则失败率统计失真；failed 强制写原因 |
| `apps/api/src/payments/service.ts` | `onlineIntent`（发起支付）、`handleWebhook`（验签→找单→幂等→金额→状态机→事件）、`testConnection`（写回连接状态） |
| `apps/api/src/checkout/service.ts` | `startOnlinePayment`：用购物袋凭证定位归属，再交给支付服务 |
| `apps/api/src/payment-webhooks/controller.ts` | 公开回调入口，`rawBody` 验签，返回 202 |
| `apps/api/src/payments/controller.ts` | `POST /admin/payment-methods/:code/connection-test` |
| `apps/api/src/app.ts` | `rawBody: true`；线上支付三件依赖按 `PAYMENTS_BASE_URL` 装配，未配置则整体关闭（503） |
| 契约 | 新增 `startOnlinePayment` 与 `testPaymentMethodConnection` 两个 operation；`/webhooks/payments/{provider}` 复用已有定义 |
| `tests/payments-online-http.test.ts` | 端到端：发起 → 幂等复用 → 签名回调入账 → 重放去重 → 篡改拒绝 → 已付不可再付 → 未知单 deferred |

**编排层的关键取舍：**

- **渠道调用在事务外**：外部 IO 不占数据库事务，失败也不留半截状态。
- **未知单号回 202 而不是 404**：回调早于本地事务提交是常态，回 5xx 会引发重试风暴；记 deferred 交给对账补。
- **金额不符不抛错**：记 `WEBHOOK_AMOUNT_MISMATCH` 冲突事件、不推进状态。抛 400 同样会让渠道无限重试。
- **终态再收到前进事件**：记事件、不改状态，供对账解释差异。

### 12.4 尚未完成

- 对账任务（`pending` 超时拉 `queryPayment` 收敛）与死信重放未实现。
- 退款编排未接入 `PaymentsService`（适配器已支持 `refund`，但缺对外接口与售后台账串联）。
- 后台支付通道管理 UI 未接（端点已就绪）。
- 真实渠道适配器未接入；`@aws-sdk/client-secrets-manager` 仍未安装。

**当前验证结果：** 全量测试 **390/390** 通过（含真实 PostgreSQL 的 HTTP 集成测试）；契约校验 54 项通过。
