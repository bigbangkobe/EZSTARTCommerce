# 前台配置引擎规格（ThemeConfig + 区块注册表）

> 状态：设计基线 v0.1（待评审）
> 定位：定义前台"配置驱动"的数据模型、发布机制、区块注册表与渲染契约。
> 关联：[重做方案](../06-产品设计逻辑/03-配置化前台与交付体系重做方案.md) · [M02 前台](modules/M02_STOREFRONT.md)

## 1. 设计目标

- 换品牌/配色/字体/首页区块/文案**无需改代码、无需重新构建**。
- 配置发布可灰度、可回滚；配置不是单点故障（不可用回退默认主题）。
- 后台表单由注册表驱动，新增区块类型不改后台代码。

## 2. 数据模型

### ThemeConfig（单行，id=1）

| 字段 | 类型 | 说明 |
|---|---|---|
| `draftConfig` | Json | 当前草稿（品牌 + tokens + 区块编排 + 导航） |
| `publishedSnapshot` | Json | 已发布不可变快照 |
| `version` | Int | 发布版本递增 |
| `publishedAt` | DateTime? | 发布时间 |
| `publishedBy` | String? | 发布者（审计） |

### ThemeVersion（发布历史）

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | Int | 版本号 |
| `snapshot` | Json | 不可变配置快照 |
| `createdAt` / `createdBy` | | 发布记录（审计、回滚来源） |

> 完全仿照现有 `MerchandisingLayout` + `MerchandisingVersion` 的草稿/快照/版本模式，实现与运维方式一致。

## 3. 配置结构（publishedSnapshot / draftConfig 内容）

```json
{
  "brand": {
    "name": "...", "brandLatin": "...", "tagline": "...",
    "logoMediaId": 12, "faviconMediaId": 13,
    "whatsappNumber": "...", "whatsappGreeting": "..."
  },
  "tokens": {
    "primaryColor": "#BC002D", "inkColor": "#1A1A1A",
    "paperColor": "#F7F5F0", "fontPair": "editorial-jp", "radius": 16
  },
  "navigation": ["home", "products", "categories", "contact"],
  "homeSections": [
    { "type": "hero", "params": { "variant": "default" } },
    { "type": "product_grid", "params": { "sectionId": "featured", "limit": 6 } }
  ]
}
```

## 4. 区块注册表（SectionRegistry）

### 4.1 定义

领域层声明式注册表：`区块类型 → { label, 字段 schema, 默认参数, 渲染组件键 }`。

| 区块类型 | 字段 schema（关键） | 默认参数 |
|---|---|---|
| `hero` | variant、titleKey、subKey、cta | variant=default |
| `about` | showCards、cardKeys | showCards=true |
| `product_grid` | sectionId、titleKey、limit、sortMode | limit=6 |
| `rich_text` | contentKey / contentPageId | — |
| `faq` | contentPageId | — |
| `content_card` | titleKey、bodyKey、linkKey | — |

### 4.2 用途

- **后台**：配置台读取注册表，自动生成对应区块的编辑表单（新增区块类型，后台自动适配）。
- **校验**：提交配置时按 schema 校验字段与枚举。
- **前台**：按 `type` 映射到渲染组件；未知类型跳过并记录告警，不影响其他区块。

### 4.3 扩展规则

新增区块类型需：在注册表登记 schema + 实现前台渲染组件 + 发布新 theme-schema 版本。已有客户配置不受影响（未知类型降级跳过）。

## 5. 发布机制

1. 后台编辑 `draftConfig`（草稿不公开）。
2. 点击发布 → 生成不可变 `publishedSnapshot` + `version++` + 写入 `ThemeVersion`。
3. 前台读取 `publishedSnapshot`（带缓存，Cache-Control 30s）。
4. 回滚：指定历史 `ThemeVersion` 重新发布为当前快照。
5. 未发布/接口不可用：前台回退到代码内默认主题，不阻断渲染。

## 6. API 契约

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/v1/storefront/theme` | GET | 返回已发布主题快照；未发布返回 404 + Cache-Control |
| `/api/v1/admin/theme` | GET | 读取草稿与当前版本（需权限） |
| `/api/v1/admin/theme` | PATCH | 保存草稿（含 If-Match 版本并发控制、CSRF、审计） |
| `/api/v1/admin/theme/publish` | POST | 发布草稿为快照 |
| `/api/v1/admin/theme/unpublish` | POST | 撤下（回退默认） |
| `/api/v1/admin/theme/rollback` | POST | 回滚到指定版本 |

同步更新 `packages/contracts/openapi.yaml` 与生成类型；保持现有 envelope `{ data, meta }` 风格。

## 7. 前台渲染契约（改造落地）

- 新增 `lib/theme.ts`：仿 `lib/merchandising.ts` 的 apiBase + envelope + `next:{revalidate:30}` + 404/异常降级。
- `app/[locale]/layout.tsx`：把 tokens 注入为 CSS 变量（服务端 `<style>` 或 style 属性覆盖 `:root`）；品牌名/Logo/WhatsApp/favicon/字体从主题读取；移除硬编码。
- `app/[locale]/page.tsx`：由 `homeSections` 遍历渲染，按注册表 `type` 映射组件；移除写死的 hero/about 顺序。
- `app/globals.css`：`:root` tokens 保留为默认值，运行时由主题覆盖；主色散落的 `rgba(188,0,45,...)` 改为 CSS 变量引用。
- 硬编码收敛：4 处 `SITE_MARKET='HK'` 与货币符号改从 `/storefront/config` 读；`site.ts` 仅保留兜底默认值。

## 8. 验收标准

- 修改主题配置并发布后，前台无需重新构建即显示新品牌/配色/区块。
- 草稿不公开；发布可回滚；接口异常时前台正常显示默认主题。
- 后台表单随注册表变化；新增区块类型无需改后台代码。
- 交易金额仍由服务端裁定，配置无法绕过价格/库存/优惠规则。

> 本规格为产品设计参考，具体实施请结合公司合规与法务要求确认。

## 9. 落地状态（P1 已实现，P2 部分实现）

> 状态：主题配置链路（草稿 → 发布 → 前台渲染）已跑通；内容型区块与字体切换尚未落地。

| 能力 | 落地物 | 状态 |
|---|---|---|
| 主题数据模型 | `ThemeConfig`（单行）+ `ThemeVersion`（不可变历史），第 35 条迁移 | ✅ |
| 域规则 | `packages/domain/src/theme.ts`：区块注册表闭集、颜色白名单、字体预设、参数扁平化、坏快照回退默认 | ✅ |
| 后台接口 | `GET/PUT /admin/theme`、`POST /admin/theme/{publish,unpublish,rollback}`，版本锁 + advisory lock + 审计 | ✅ |
| 后台界面 | `/admin/theme`：品牌/视觉 tokens/首页区块编排/发布历史/回滚 | ✅ |
| 前台接口 | `GET /storefront/theme`：只返回已发布快照，未发布 404，缓存 30 秒 | ✅ |
| 前台渲染 | `layout.tsx` 注入 CSS 变量（主色/文字色/背景色/圆角）、品牌名与 WhatsApp 取自主题；`page.tsx` 按 `homeSections` 渲染 | ✅ |
| 内容型区块 | `rich_text` / `faq` / `content_card` | ⏳ 当前安全跳过，等 CMS 内容绑定 |
| 字体切换 | `fontPair` 已存库并校验 | ⏳ 前台仍用同一套字体 |
| Logo / favicon | `logoMediaId` / `faviconMediaId` 字段已留 | ⏳ 未接媒体库渲染 |
| 市场与货币收敛 | `SITE_MARKET`、货币符号 | ⏳ 仍硬编码，待 `/storefront/config` 接入 |

**设计约定**：主题永远不是单点故障。接口不可达、未发布、快照损坏三种情况，前台都回退到 `site.ts` + 内置默认令牌，外观与改造前一致；后台保存草稿不会改变线上，发布才切换快照，撤下即回到默认。
