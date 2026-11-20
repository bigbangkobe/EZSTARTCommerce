# 实例配置规范（Instance Manifest）

> 状态：设计基线 v0.1（待评审）
> 定位：一份机器可读配置，同时驱动部署参数、前台主题与业务规则，取代重复的人工录入。
> 关联：[客户上线参数表](CLIENT_LAUNCH_INPUTS.md)（面向客户的填写视图）· [重做方案](../06-产品设计逻辑/03-配置化前台与交付体系重做方案.md)

## 1. 目标

- **单一配置源**：客户上线参数表填的内容，落为一份版本化配置文件，供部署工具、前台、后台共同读取。
- **一次填写、多处生效**：配置驱动部署（域名/云/备份）、前台（品牌/区块/文案）、业务规则（语言/货币/支付/配送）。
- **可校验、可阻断、可回滚**：schema 校验 + 上线阻断项 + 版本追溯。

## 2. 配置文件格式

采用 YAML（人可读、可 diff、可纳入版本控制），文件名 `instance.yaml`，每个实例一份。

```yaml
schemaVersion: 1
instance:
  id: client-hk-001
  domain: shop.example.com
  market: HK
  currency: HKD
  timezone: Asia/Hong_Kong
  locales: [zh-HK, zh-CN, en]
  defaultLocale: zh-HK
brand:
  name: IN先生
  brandLatin: Mr. IN
  tagline: 心を込めて、凡事認真。
  logo: /media/logo.png          # 引用 media 库，或部署时上传
  favicon: /media/favicon.ico
  whatsapp: "85260474794"
  whatsappGreeting: 你好，想向你查詢詳情
theme:
  primaryColor: "#BC002D"
  inkColor: "#1A1A1A"
  paperColor: "#F7F5F0"
  fontPair: editorial-jp          # 指向字体组合预设
  radius: 16
storefront:
  homeSections:
    - type: hero
      params: { variant: default }
    - type: product_grid
      params: { sectionId: featured, titleKey: home.featured, limit: 6 }
    - type: about
      params: { showCards: true }
  navigation: [home, products, categories, contact]
business:
  payment: [cod, approved_gateway]
  shipping:
    regions: [HK]
    freeThreshold: 500
  features:
    memberCenter: true
    afterSales: true
compliance:
  privacyPolicyUrl: https://shop.example.com/pages/privacy
  ageGateRequired: false
  dataRetentionDays: 365
deploy:
  cloud: { provider: ..., region: ... }
  backup: { frequency: daily, retentionDays: 30 }
```

## 3. 字段分组说明

| 分组 | 去向 | 说明 |
|---|---|---|
| `instance` | 部署 + StoreConfig | 域名、市场、货币、语言（现有 StoreConfig 已覆盖大部分） |
| `brand` | ThemeConfig | 品牌素材与联系信息 |
| `theme` | ThemeConfig | 视觉 tokens 与字体预设 |
| `storefront` | ThemeConfig + MerchandisingLayout | 首页区块编排、导航、陈列 |
| `business` | StoreConfig + 业务模块 | 支付/配送/功能开关（沿用现有规则，不新增业务逻辑） |
| `compliance` | 上线阻断检查 | 隐私政策、资格校验、留存（见客户上线参数表） |
| `deploy` | 交付工具链 | 云、备份、监控参数 |

## 4. 校验规则

- **schema 校验**：字段类型、必填项、枚举值（如 `fontPair` 必须是已注册预设、`homeSections[].type` 必须在区块注册表内）。
- **引用校验**：`logo`/`favicon` 引用的 media 存在；`payment` 指向已获批服务商。
- **市场规则**：`market`、`locales`、`currency` 与后台市场档案一致。
- **上线阻断项**：交易相关未完成项（支付账户、税费口径、隐私责任人、域名/HTTPS、备份演练）未签字则校验不通过，不能进入生产发布。

## 5. 版本与治理

- 配置纳入版本控制，每次变更生成版本号与变更记录。
- 配置与代码版本分离记录：`instance.yaml@vN` + `core@vX` + `theme-schema@vY`。
- 支持 diff、回滚到历史配置；回滚主题配置走 ThemeConfig 发布快照机制。
- 客户可导出自己的配置（数据可携带），退出/迁移时作为交接物之一。

## 6. 与现有文档的关系

- 客户上线参数表（CLIENT_LAUNCH_INPUTS）是面向人的填写视图；本规范是面向机器的落地格式。
- 两者字段保持一致，避免"填了表又填一遍配置"。

## 7. 落地状态（P3 已实现）

> 状态：核心校验已落地为可运行代码（重做方案 P3）；部署初始化与批量升级仍属 P4。

| 能力 | 落地物 | 说明 |
|---|---|---|
| 结构校验 + 闭集枚举 | `packages/domain/src/instance-manifest.ts` | 纯规则层，复用 `store.ts`（语言/市场/时区/功能开关）与 `theme.ts`（字体/区块）注册表，不另起枚举 |
| 上线阻断检查 | 同上 `launchBlockerStatus` / `unsignedBlockers` / `canLaunch` | 10 项阻断与 `CLIENT_LAUNCH_INPUTS` 逐项对应；未签字项一律视为未确认 |
| 单元测试 | `tests/instance-manifest.test.ts` | 11 例，覆盖正常解析、版本/语言/时区/颜色/字体/区块/开关/签字闭集与阻断 |
| 校验 CLI | `scripts/validate-instance-manifest.mjs` | `pnpm instance:validate <file>`；`--require-launch-ready` 在未签字时以退出码 2 阻止发布 |
| 参考配置 | `deploy/merchants/mrinhk/instance.example.yaml` | 以已上线 mrinhk 实例反向编写的第一份 manifest；签字项默认 false |

**设计约定**：结构校验（格式对）与上线判定（可发布）分离——`validate` 默认只做结构校验返回 0；加 `--require-launch-ready` 才执行阻断判定。这保证"配置先落地、签字后上线"的流程不被混淆。

**仍有待办（P4）**：标准部署包、一键起实例、批量升级脚本。Manifest 已定义 `deploy` 段供其消费，但初始化脚本尚未接入。

> 本规范为产品设计参考，具体实施请结合公司合规与法务要求确认。
