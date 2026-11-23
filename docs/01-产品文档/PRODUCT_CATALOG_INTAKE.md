# 商品目录导入信息包（mrinhk 站点）

> **这份文档怎么用**：把它整段丢给 chat（或发给客户），按 §1–§7 填空，回传 CSV。
> 填完就是一次可执行的批量上架，不需要再问第二轮。
> **适用范围**：`admin.mrinhk.com` 后台 ← `mrinhk.com` 前台，实例基准币种 HKD，启用语言 `zh-HK` / `zh-CN` / `en`。
> **最后更新**：2026-11-23 ｜ 对应代码：`apps/api/src/catalog/service.ts`、`packages/domain/src/catalog.ts`

---

## 0. 三条前置事实（决定了为什么要填表）

| # | 事实 | 后果 |
|---|---|---|
| 1 | 后台**没有**批量导入的落地实现；OpenAPI 契约与 `catalog.import` 权限早已定义好，但 `apps/api` 无服务、`prisma` 无表、后台无 UI | 50 个 SKU 要手工点 50 次 × 三语表单，不现实 |
| 2 | **发布门禁**要求每一种启用语言都有 `name` + `slug` | 只有中文的商品能存草稿，**发不出去**；三语齐全是硬门槛 |
| 3 | 商品图片在数据模型里必须先是**媒体库 UUID**，不能直接存 URL | CSV 里放图片链接时，导入器要先下载→入库→换 UUID |

第 3 条纠正我之前的说法：不能"CSV 直接填图 URL 就完事"，正确做法是导入器代做这一步（能力规格见 §8）。

---

## 1. 合规预检（**先过这关，再谈字段**）

不整站复制第三方商品，原因不是技术：同类站点（如 smwfhk.com）主营未完税香烟与加热烟，两者在港都不能卖。

| 品类 | 依据 | 结论 |
|---|---|---|
| 未完税香烟、烟草制品（无完税证明） | 《应课税品条例》Cap. 109 | **不可上架**。销售/为销售而持有未完税烟可处最高罚款 100 万港元及监禁 2 年 |
| 加热烟（IQOS/TEREA 等）、电子烟、草本烟 | 《吸烟（公众卫生）条例》Cap. 371，2022-04-30 起 | **不可上架**。禁止进口/制造/销售/分发/为商业目的持有，最高罚款 5 万港元及监禁 6 个月 |
| 已完税香烟 | Cap. 109 + 烟草相关牌照 | 需附**牌照编号 + 完税证明**，逐项核对后才建 |
| 酒类 | Cap. 109 酒牌制度 | 需附**酒牌**，无牌不可卖 |
| 中成药 / 西药 / 药剂制品 | Cap. 549 / Cap. 138 | 需附**注册编号**；无注册号不建 |
| 保健品、食品 | 视成分 | 需提供成分表与产地，含违禁成分不建 |
| 成人用品 | — | 需**年龄门禁页**，另行配置后才建 |
| 一般商品（家居、器物、礼盒、日用品） | — | 直接可建 |

**请填**（每类一行，没有的写「无」）：

| 品类 | 是否持牌 | 牌照/注册编号 | 有效期至 | 可提供的证明文件 |
|---|---|---|---|---|
|  |  |  |  |  |
|  |  |  |  |  |

> 本表只作初筛，最终结论以律师或香港海关书面意见为准。未列入本表的品类，按「未确认」处理，不建商品。

---

## 2. 单个 SKU 必须提供的信息（字段与校验规则）

字段名就是 §3 CSV 的表头，一个不能改，否则导入器对不上列。`一行 = 一个规格`。

### 2.1 商品主体（同商品多规格重复填相同值）

| 字段 | 必填 | 格式 / 上限 | 校验规则（代码硬约束） | 示例 |
|---|---|---|---|---|
| `product_key` | ✅ | 自定义短码，同商品多规格保持一致 | 仅用于归组，不入库 | `AROMA-001` |
| `base_sku` | ⬜ | 同 SKU 规则 | ≤64，`^[A-Za-z0-9][A-Za-z0-9._-]*$` | `AROMA-001` |
| `category_path` | ✅ | 分类路径，`/` 分隔，须已存在 | 分类须存在且已启用；叶子分类须有 slug | `家居器物/香薰` |
| `brand` | ⬜ | 品牌名，须已存在 | 不存在则报错，不自动建 | `無印` |
| `market_codes` | ✅ | 市场代码，`\|` 分隔 | 必须全部 enabled 且审批通过；mrinhk 现为 `HK` | `HK` |

### 2.2 三语文案（**发布前必须齐全**）

| 字段 | 必填 | 上限 | 说明 |
|---|---|---|---|
| `name_zh_HK` | ✅ | 160 字 | 繁体名，前台默认 |
| `slug_zh_HK` | ✅ | 180 字 | 不含空格/`/`，不以 `-` `_` 开头结尾 |
| `name_zh_CN` | ✅ | 160 字 | 简体名 |
| `slug_zh_CN` | ✅ | 180 字 | 同上 |
| `name_en` | ✅ | 160 字 | 英文名 |
| `slug_en` | ✅ | 180 字 | 同上 |
| `short_zh_HK` | ⬜ | 320 字 | 列表页一句话卖点（前台卡片会显示） |
| `short_zh_CN` | ⬜ | 320 字 |  |
| `short_en` | ⬜ | 320 字 |  |
| `desc_zh_HK` | ⬜ | 50 000 字 | 详情页正文，支持换行，CSV 内用双引号包裹 |
| `desc_zh_CN` / `desc_en` | ⬜ | 同上 |  |

> **只出一种语言怎么办**：可以导入成草稿（`publish_now=N`），其余语言留空。
> 导入器不会拿机器翻译冒充人工翻译——要发布，就得补齐三语或书面确认由谁翻译。

### 2.3 规格与价格

| 字段 | 必填 | 格式 | 校验规则 | 示例 |
|---|---|---|---|---|
| `variant_sku` | ✅ | 每行唯一 | ≤64，`^[A-Za-z0-9][A-Za-z0-9._-]*$`，**不能含中文/空格** | `AROMA-001-100ML` |
| `option1_name` | ✅ | 规格名 | 1–60 字；每个规格**至少 1 组**选项 | `容量` |
| `option1_value` | ✅ | 规格值 | 1–100 字 | `100ml` |
| `option2_name` / `option2_value` | ⬜ | 第二组 | 同上，最多 20 组 | `香型` / `檜木` |
| `price_hkd` | ✅ | 数字，最多 2 位小数 | ≥0；导入器 ×100 存为整数分，**不允许负数** | `168.00` |
| `compare_at_hkd` | ⬜ | 同上 | 划线价，须 ≥ `price_hkd` | `220.00` |
| `currency` | ✅ | 3 位大写 | **必须 `HKD`**（店铺本位币，单币种） | `HKD` |
| `stock_qty` | ✅ | 整数 | ≥0；0 表示售罄但商品仍在架 | `40` |
| `variant_status` | ⬜ | `active` / `inactive` | 默认 `active`；全部 inactive 的商品**无法发布** | `active` |

### 2.4 图片与扩展属性

| 字段 | 必填 | 说明 |
|---|---|---|
| `image_urls` | ⬜ | 直链，多张用 `\|` 分隔，按顺序即展示顺序。导入器会下载→上传媒体库→换成 UUID。留空则前台用首字色块占位（已实现） |
| `alt_zh_HK` | ⬜ | 图片替代文字，≤300 字。**无障碍与 SEO 都需要，建议填** |
| `attr_1_name` / `attr_1_value` | ⬜ | 自定义属性，value ≤200 字。`attr_2_*` 类推，最多 10 组（如 `产地`/`日本`、`材质`/`陶`） |
| `publish_now` | ✅ | `Y` 立即发布 / `N` 只存草稿 |

**图片规格建议**（不是硬校验，但影响前台观感）：主图 1:1、≥1200×1200、<2MB、JPG/PNG/WebP；白底或统一背景。

---

## 3. CSV 模板

模板文件：`docs/01-产品文档/templates/products-import-template.csv`（UTF-8 带 BOM，Excel 双击可直接打开不乱码）。

示例三行（同一商品两个规格 + 一个单规格商品）：

```csv
product_key,base_sku,category_path,brand,market_codes,name_zh_HK,slug_zh_HK,name_zh_CN,slug_zh_CN,name_en,slug_en,short_zh_HK,short_zh_CN,short_en,desc_zh_HK,desc_zh_CN,desc_en,variant_sku,option1_name,option1_value,option2_name,option2_value,price_hkd,compare_at_hkd,currency,stock_qty,variant_status,image_urls,alt_zh_HK,attr_1_name,attr_1_value,publish_now
AROMA-001,AROMA-001,家居器物/香薰,,HK,檜木香薰蠟燭,hinoki-aroma-candle,桧木香薰蜡烛,hinoki-aroma-candle,Hinoki Aroma Candle,hinoki-aroma-candle,檜木與煙燻木質調,桧木与烟熏木质调,Hinoki and smoky wood,手工大豆蠟，燃燒約 45 小時。,手工大豆蜡，燃烧约 45 小时。,Hand-poured soy wax, burns about 45 hours.,AROMA-001-100,容量,100ml,,,168.00,220.00,HKD,40,active,,檜木香薰蠟燭,產地,日本,Y
AROMA-001,AROMA-001,家居器物/香薰,,HK,檜木香薰蠟燭,hinoki-aroma-candle,桧木香薰蜡烛,hinoki-aroma-candle,Hinoki Aroma Candle,hinoki-aroma-candle,檜木與煙燻木質調,桧木与烟熏木质调,Hinoki and smoky wood,手工大豆蠟，燃燒約 45 小時。,手工大豆蜡，燃烧约 45 小时。,Hand-poured soy wax, burns about 45 hours.,AROMA-001-200,容量,200ml,,,288.00,,HKD,25,active,,檜木香薰蠟燭,產地,日本,Y
CUP-014,CUP-014,家居器物/器物,,HK,砥部燒茶杯,toBe-cup,砥部烧茶杯,toBe-cup,ToBe Ware Teacup,toBe-cup,愛媛縣砥部燒,爱媛县砥部烧,ToBe ware from Ehime,手拉坯成型，每只略有差異。,手拉坯成型，每只略有差异。,Hand-thrown, slight variation per piece.,CUP-014-STD,款式,標準,,,128.00,,HKD,12,active,,砥部燒茶杯,材質,陶,N
```

**CSV 三条硬性要求**（踩了就整批失败）：

1. **UTF-8 带 BOM**。用 Excel 另存为「CSV UTF-8（逗号分隔）」，否则中文变乱码。
2. **含逗号/换行的单元格必须用双引号包裹**，内部双引号写两次（`""`）。商品描述最容易中招。
3. **不要把金额写成 `$168` 或 `168元`**，只写数字 `168.00`。

---

## 4. 分类与品牌（挡路的两个数据问题）

| 问题 | 现状 | 处理 |
|---|---|---|
| `家居器物` 分类缺 `slug` | 前台分类条不列出该分类，商品也进不了分类页 | 后台补 slug（如 `homeware`）即可，1 分钟 |
| 分类 slug 只接受 `[a-z0-9-]` | 含中文/空格的 slug 登记后**静默失效**（能存但前台打不开） | 分类 slug 一律用英文小写+连字符 |

**需要客户确认的分类树**（照现状填，缺的补）：

```
（示例结构，请按真实经营调整）
家居器物  homeware
  ├─ 香薰  aroma
  ├─ 器物  tableware
  └─ 织物  textile
礼盒      gift-set
```

品牌若不存在，导入前必须先在后台上架品牌，导入器**不会自动创建品牌**（避免脏数据）。

---

## 5. 价格、库存与市场口径（一次性确认，避免后面逐条改）

| 输入项 | 请填 |
|---|---|
| 展示价含税还是未税 |  |
| 折扣价与实际成交价的展示方式（是否显示划线价） |  |
| 库存来源：手工维护 / Excel 定期覆盖 / 供应商接口 |  |
| 首批 SKU 数量、预计月订单量 |  |
| 是否有商品只在部分区域可售 |  |
| 需要上架到哪个市场（当前仅 `HK`） |  |

---

## 6. 三语文案与素材来源

| 输入项 | 请填 |
|---|---|
| 三语文案由谁提供（客户 / 翻译 / 我方代写） |  |
| 三语文案审校人 |  |
| 商品图由谁提供、是否有使用权 |  |
| 是否允许使用竞品图（**默认不允许，涉版权**） |  |
| SEO 标题/描述是否单独撰写（上限 70 / 320 字） |  |

---

## 7. 交付物清单（填完这些就可以开工）

- [ ] §1 合规预检表（含证照）
- [ ] CSV 文件（按 §3 模板，UTF-8 BOM）
- [ ] 分类树确认（含 slug）
- [ ] 品牌清单
- [ ] §5 价格/库存口径
- [ ] §6 文案与图片来源说明

---

## 8. 后台将提供的批量导入能力（对齐已有契约）

> **重要**：`packages/contracts/openapi.yaml` 里**已经定义**了完整的导入契约（四步任务流），`catalog.import` 权限也已在 `packages/config/src/role-presets.ts` 里发给 Owner/Admin/ProductOps。
> 缺的只是实现：`apps/api/src` 无对应 controller/service，`packages/database/schema.prisma` 无 `ImportJob` 模型，`apps/admin` 无界面。
> 因此**不要另造 `POST /products/import`**，按左下契约实现即可。

### 8.1 API（已在契约中，直接实现）

| 端点 | 作用 | 鉴权 |
|---|---|---|
| `POST /api/v1/admin/import-jobs` | 创建导入任务（引用已上传文件 + 列映射） | `catalog.import` + CSRF |
| `POST /api/v1/admin/import-jobs/{id}/validate` | **只校验**，返回逐行预览，不写商品 | `catalog.import` + CSRF |
| `POST /api/v1/admin/import-jobs/{id}/execute` | 执行已确认的预览 | `catalog.import` + CSRF + `Idempotency-Key` |
| `POST /api/v1/admin/import-jobs/{id}/cancel` | 取消 | `catalog.import` + CSRF |
| `GET  /api/v1/admin/import-jobs/{id}` | 状态与计数 | `catalog.import` |

创建任务的入参（`ImportCreateRequest`，字段名不可改）：

```jsonc
{
  "fileObjectKey": "…",                                  // 先走媒体上传三步拿 objectKey，不是直接传 file
  "fileSha256":   "…64 位十六进制…",                      // 防篡改，执行时还要再确认一次
  "format":       "csv" | "xlsx",
  "mode":         "create_or_update_by_sku" | "create_only" | "update_only",
  "commitMode":   "valid_rows" | "atomic",               // 部分提交 vs 全量事务
  "columnMapping": { "variant_sku": "B", "name_zh_HK": "F" },  // CSV 列 → 目标字段
  "localeSet":    ["zh-HK", "zh-CN", "en"]
}
```

执行时的入参（`ImportExecuteRequest`）：`confirmedFileSha256` + `confirmedMappingVersion` + `expectedValidRows` —— 三者构成"你确认的就是我执行的"这层保护，文件或映射一变就必须重新校验。

### 8.2 实现要点

| 点 | 做法 |
|---|---|
| 幂等 | `mode=create_or_update_by_sku` + `Idempotency-Key`；重跑同一文件 `created=0` |
| 部分成功 | `commitMode=valid_rows` 逐行独立；`atomic` 则全成全败。默认建议 `valid_rows` |
| 两阶段 | 必须 `validate` 通过并拿到 `mappingVersion` 才能 `execute`，跳过校验直接执行应 409 |
| 三语门禁 | `localeSet` 内缺语言的商品强制落草稿，不参与发布 |
| 图片 | `image_urls` → 服务端下载 → 校验 content-type / 尺寸 → 复用媒体三步流程（`/admin/media/upload-target` → 直传 → `/admin/media/complete`）拿 mediaId；单张失败只降级为无图 |
| 事务边界 | 单商品一个事务（多规格一起成功/失败） |
| 审计 | 记录 `import.created / validated / executed`、文件哈希、行数、操作人 |
| 限流 | 单文件 ≤2000 行、≤5MB；超出拒绝并提示拆分 |

### 8.3 后台 UI

`catalog-console.tsx` 增加「批量导入」抽屉，按四步任务流走：选文件（先走媒体上传拿 `fileObjectKey`）→ 列映射（默认按本文档表头自动匹配）→ 校验预览（逐行结果，可筛选失败行）→ 确认执行（显示 `expectedValidRows` 让运营核对数字再点）→ 汇总统计 + 失败行 CSV 下载。

---

## 9. 验收标准

1. 用模板导入 20 行，`validate` 报告 0 error；
2. 正式导入后，后台商品列表出现对应商品，且规格/价格/库存与 CSV 一致；
3. `publish_now=Y` 的商品在前台 `/{locale}/products/{slug}` 三语均可打开，无 404；
4. 同一文件重跑一次，`created=0, updated=20`，无重复商品；
5. 故意造 3 行错误数据（缺 slug、价格负数、SKU 含中文），报告精准定位到行号与字段，其余行正常入库。

---

## 10. 交给 chat 的提示词（直接复制）

```text
你是电商后台运营助手，帮我完成商品批量上架。约束如下，请严格遵守：

1. 目标系统：EZSTARTCommerce 后台，实例 mrinhk，基准币种 HKD，启用语言 zh-HK / zh-CN / en。
2. 输出格式：一行一个规格（variant）的 CSV，UTF-8 带 BOM，表头必须严格等于下面这一行，不得增删列：
product_key,base_sku,category_path,brand,market_codes,name_zh_HK,slug_zh_HK,name_zh_CN,slug_zh_CN,name_en,slug_en,short_zh_HK,short_zh_CN,short_en,desc_zh_HK,desc_zh_CN,desc_en,variant_sku,option1_name,option1_value,option2_name,option2_value,price_hkd,compare_at_hkd,currency,stock_qty,variant_status,image_urls,alt_zh_HK,attr_1_name,attr_1_value,publish_now
3. 硬校验：variant_sku 只能 [A-Za-z0-9._-]，≤64 字符，不能含中文或空格；每行至少一组 option；price_hkd 为纯数字最多两位小数；currency 固定 HKD；slug 不含空格；name ≤160 字；short ≤320 字。
4. 三语必须齐全（name 与 slug 都要），否则该商品只能标 publish_now=N。
5. 不要输出任何烟草、加热烟、电子烟、未完税商品；不要复制第三方网站的商品图与文案，只写你自己的描述。
6. 含逗号或换行的字段用双引号包裹。
7. 最后附一段导入前自检：总行数、去重后的商品数、可能的 slug 冲突、缺图比例。
```

---

**相关文档**：[客户上线参数表](CLIENT_LAUNCH_INPUTS.md) ｜ [实例配置规范](INSTANCE_CONFIG_SPEC.md) ｜ [API 契约](../03-开发文档/API_SPEC.md)
