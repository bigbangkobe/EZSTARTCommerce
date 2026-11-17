# @ezstart/storefront-mrinhk — IN先生 顾客前台

IN先生（mrinhk.com）专属前台，属于 EZSTARTCommerce「一个商家 = 一个独立实例」私有部署模式的客户前台应用（见 docs/CUSTOMIZATION_MODEL.md 第 2 类 C 级定制）。

## 设计定位

- 日式极简卡片风格：米白纸感底色（#F7F5F0）、卡片圆角阴影、日本红点缀（#BC002D）。
- 品牌视觉来自客户名片：红色圆形 + 衬线「IN先生」字样，首页以倾斜名片卡片呈现。
- 默认语言繁体中文（zh-Hant）；简中/英文文案结构已在 `lib/site.ts` 预留，正式上线前补齐三语（见 docs/CLIENT_LAUNCH_INPUTS.md G 节）。

## 页面清单（当前阶段）

| 页面 | 路径 | 说明 |
|---|---|---|
| 首页 | `/` | 品牌 Hero、关于卡片、精选商品（接 API）、WhatsApp CTA |
| 商品 | `/products` | 商品陈列骨架，当前展示筹备中空态 |
| 联络页 | `/contact` | WhatsApp 联络卡片（60474794） |

购物车 / 结账 / 商品详情 / 会员等页面在商品 API 契约冻结后按批准的页面清单补齐；价格、库存、订单一律走服务端核心，前台不自行计算交易金额。

## 运行

```bash
pnpm install
pnpm --filter @ezstart/storefront-mrinhk dev   # http://127.0.0.1:3002
```

需要本地起 apps/api（默认 3001 端口）才能取到商品；API 不可达时首页自动降级为错误态，不阻断渲染。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `API_INTERNAL_ORIGIN` | `http://127.0.0.1:3001` | 该实例 API 内网地址；生产用实例内网/私网地址，禁止带用户名密码 |

## 实例部署要点（mrinhk.com）

- 该前台与 `apps/api`、`apps/admin`、`apps/worker`、PostgreSQL 组成一个完整独立实例，单独部署在商家云账号（AWS ap-northeast-1 东京）。
- 域名：`mrinhk.com`（前台），`admin.mrinhk.com`（管理后台，建议）；HTTPS 用 Let's Encrypt 或 ACM。
- WhatsApp 号码/区号在 `lib/site.ts` 的 `whatsappIntl` 修改；品牌文案集中在同一文件。
- 上线前须完成 docs/CLIENT_LAUNCH_INPUTS.md 的 F/G 节确认（云账号、域名负责人、备份、三语 SEO 等）。
