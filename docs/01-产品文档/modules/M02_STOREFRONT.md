# M02 前台主题与店铺体验（配置引擎）

**优先级：**P0
**重做说明：**本模块已从「提供一套参考前台 + 客户另行开发」重做为「配置驱动前台引擎」。方案基线见 [重做方案](../../06-产品设计逻辑/03-配置化前台与交付体系重做方案.md)。交易底座规则不变。

## 产品目标
提供一套**配置驱动、移动端友好**的前台引擎：品牌、配色、字体、首页区块编排、文案、模块开关全部由实例配置决定，换客户无需前端开发。客户可通过配置获得专属前台；确有独特页面结构或交互时按 B/C 类例外定制。

## 首期范围

### 基线页面
首页、导航、分类、搜索结果、商品卡片、商品详情、购物袋入口、语言切换、页脚、客服入口；响应式布局与 SEO。SEO 技术基线涵盖可索引元数据、每语言 canonical/alternate URL、XML sitemap、robots 与 404/重定向；主要落地页元数据需在初始 HTML 或可被搜索引擎正常获取的渲染输出中可见。

### 配置引擎（本次重做核心）
- **主题配置（ThemeConfig）**：品牌（Logo/品牌名/标语/favicon）、视觉 tokens（主色/文字色/背景色/字体/圆角）、联系信息（WhatsApp）、导航、首页区块编排。
- **声明式区块注册表**：每个区块声明 `{type, 字段 schema, 默认参数}`；首期区块 `hero`、`about`、`product_grid`、`rich_text`、`faq`、`content_card`。
- **发布模型**：草稿 → 发布快照（不可变）→ 版本号；前台读取已发布快照，未发布/不可用回退默认主题，配置不是单点故障。
- **配置与代码分离**：实例配置不写进源码，升级不覆盖客户配置。

## 主要数据对象

| 对象 | 状态 | 说明 |
|---|---|---|
| `ThemeConfig` | 本次新增 | 单行配置，`draftConfig` / `publishedSnapshot` / `version` / `publishedAt`；仿 `MerchandisingLayout` 模式 |
| `ThemeVersion` | 本次新增 | 不可变发布快照，支持回滚 |
| `SectionRegistry` | 本次新增（领域层） | 区块类型 → 字段 schema 的声明式注册表 |
| `MerchandisingLayout` | 已有，复用 | 首页/分类/专题商品陈列（草稿/发布/版本） |
| `StoreConfig` | 已有，扩展读取 | `logoMediaId`/`faviconMediaId` 已在库，补齐前台读取与后台上传 |
| `ContentRelease` | 已有，复用 | 内容换代标记 cr-N |
| `StorefrontPreference` / `NavigationItem` | 并入 ThemeConfig | 导航与偏好作为主题配置字段，不单列实体 |

> 注：旧版模块文档列出的 `ThemeConfig`/`HomepageSection`/`NavigationItem` 等此前仅为设计意图，代码中并不存在；本次重做将其中真正需要的部分落地。

## 关键业务规则
- 前台由区块注册表渲染首页：区块类型、顺序、显隐、参数来自已发布主题快照；注册表之外的页面行为走 B/C 类定制。
- 商家可在后台配置台编辑主题与区块参数，发布后前台同步读取；草稿不公开。
- 每个客户前台独立验收/发布；行业图文、广告和销售内容由客户审核。
- 不提供任意代码执行或任意拖拽式页面构建器；只开放注册表声明的区块与字段。
- 交易金额一律服务端裁定，配置化前端不得绕过价格、库存、优惠、付款和市场规则。
- 主题发布生成不可变快照与版本号，升级或误配可一键回滚。

## 验收条件
- 换品牌/配色/字体/首页区块/文案**无需改代码、无需重新构建**即可生效。
- 主题发布生成快照与版本，草稿不公开，可回滚；未发布/接口不可用回退默认主题不阻断渲染。
- 后台配置台表单由区块注册表驱动：新增区块类型后台自动适配，无需改后台代码。
- 商家发布后，桌面与手机前台均展示对应已发布版本；商品/区块排序按配置生效。
- 客户发布不影响其他客户；API 版本兼容关系可追踪。
- SEO：正确 canonical/hreflang、sitemap、robots；个人化页面不被公开索引；slug 更新保留已批准重定向且无循环。

## 依赖
设计系统、M01 语言/店铺配置、M03 商品目录及稳定 API 契约；CMS 内容由前台按发布契约读取；`MerchandisingLayout` 陈列发布机制可复用。

## 代码改造清单（落地位置）
- 数据层：`packages/database/schema.prisma` 新增 `ThemeConfig`/`ThemeVersion` + migration；`packages/domain` 新增主题规则与 `SectionRegistry`。
- API 层：`apps/api/src/storefront/` 新增 `GET /api/v1/storefront/theme`（404 降级 + Cache-Control）；`apps/api/src/admin/` 新增 theme 草稿/发布/撤下端点 + DTO；同步 `packages/contracts/openapi.yaml`。
- 前台：`apps/storefront-mrinhk/lib/theme.ts`（仿 `merchandising.ts`）；`app/[locale]/layout.tsx` 注入 CSS 变量与品牌外壳；`app/[locale]/page.tsx` 由 `homeSections` 驱动渲染。
- 样式：`app/globals.css` 的 `:root` tokens 改为服务端注入覆盖；替换 layout 中硬编码 favicon/字体/WhatsApp。
- 后台：`apps/admin/app/admin/theme/` 配置页 + `apps/admin/app/theme-console.tsx`；补齐 `brandAssets` 上传 UI。

## 项目实施建议
本模块为 P0，分两步：先落地配置引擎骨架（ThemeConfig + 发布 API + 前台读取 + CSS 变量注入），再落地区块编排与后台配置台。每个客户的配置与例外范围单独冻结。

> 本方案为产品设计参考，具体实施请结合公司合规与法务要求确认。
