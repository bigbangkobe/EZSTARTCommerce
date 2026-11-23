#!/usr/bin/env node
// 批量新增商品（在 M05 导入 API 落地前的可用通道）。
//
// 背景：目录 API 只有「单商品创建 → 发布 → 库存调整」三段式，没有导入任务接口。
// 这个脚本把 CSV/JSON 逐条走完这三步，等价于一次批量导入：
//   POST /api/v1/admin/products            建草稿（translations/variants/attributes 一次给全）
//   POST /api/v1/admin/products/:id/publish 上架（发布门禁：启用语言齐全 + 至少一个 active 规格）
//   POST /api/v1/admin/inventory/adjustments 初始库存（带原因的库存流水，不直接改现存量）
//
// 用法（在仓库根或服务器 /opt/ezstart-mrinhk 内）：
//   node scripts/import-products.mjs --file products.csv --plan          # 离线：只解析+校验
//   node scripts/import-products.mjs --file products.csv --market HK --dry-run   # 登录后打印将提交的 body
//   node scripts/import-products.mjs --file products.csv --market HK             # 真写
//
// 凭据：默认读 /secrets/admin.json（seed-demo.mjs 生成，含 email/password/totpSecret），
// 也可用 --creds 指定；没有 TOTP 的场景请先在后台建一个「服务账号」并关掉 MFA 要求。
//
// 注意：写接口校验 Origin 必须等于 APP_ORIGIN，所以本地跑要带 --origin https://mrinhk.com。
import { readFile, writeFile } from 'node:fs/promises';
import { createHmac, createHash } from 'node:crypto';
import { groupProducts, groupFromJson, validateDrafts, toProductBody, stockTargets, parseCsv } from './lib/product-import.mjs';

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function option(name, fallback = undefined) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

if (flag('help')) {
  console.log(`批量新增商品

  --file <path>            CSV（deploy 模板列）或 JSON（API 形状数组），必填
  --market <code>          表格没写 market_codes 时的默认市场，如 HK
  --creds <path>           管理员凭据 JSON，默认 /secrets/admin.json
  --api <base>             API 地址，默认 $API_BASE 或 http://127.0.0.1:3001
  --origin <url>           写入请求的 Origin，默认 $APP_ORIGIN 或 https://mrinhk.com
  --plan                   离线：只解析与校验，不登录、不写库
  --dry-run                登录并解析分类/市场，打印将提交的 body，不写库
  --limit <n>              只处理前 n 个商品（试跑用）
  --fill-missing-locale    缺失语言用 --fallback-locale 的内容补齐（否则跳过发布）
  --fallback-locale <l>    复制来源语言，默认 zh-HK
  --default-option "名=值"  无 option 的商品兜底规格，默认 規格=標準
  --publish / --no-publish 覆盖表格里的 publish_now
  --restock                商品已存在时也把库存调整到 stock_qty 目标值
  --delay <ms>             每条之间的间隔，默认 150
  --retry-wait <秒>        撞到限流 429 后等多久再续跑，默认 905（后端窗口 15 分钟）
  --max-retries <n>        429 最多续跑几次，默认 40
  --report <path>          写出行级 JSON 报告
  --allow-ragged           CSV 列数不一致时仍然继续（默认拒绝）
  --help                   显示本帮助
`);
  process.exit(0);
}

const file = option('file');
if (!file || file === true) { console.error('缺少 --file（可先 --help）'); process.exit(2); }

const API = String(option('api', process.env.API_BASE ?? 'http://127.0.0.1:3001')).replace(/\/$/, '');
const ORIGIN = String(option('origin', process.env.APP_ORIGIN ?? 'https://mrinhk.com'));
const CREDS = String(option('creds', process.env.SECRET_FILE ?? '/secrets/admin.json'));
const MARKET = option('market', null);
const PLAN_ONLY = flag('plan');
const DRY_RUN = flag('dry-run');
const LIMIT = Number(option('limit', 0)) || 0;
const FILL_MISSING = flag('fill-missing-locale');
const FALLBACK_LOCALE = String(option('fallback-locale', 'zh-HK'));
const DELAY = Number(option('delay', 150)) || 0;
const RETRY_WAIT = Number(option('retry-wait', 905)) || 905;
const MAX_RETRIES = Number(option('max-retries', 40)) || 40;
const RESTOCK = flag('restock');
const REPORT_PATH = option('report', null);
const PUBLISH_OVERRIDE = flag('publish') ? true : flag('no-publish') ? false : null;
const DEFAULT_OPTION = (() => {
  const raw = String(option('default-option', '規格=標準'));
  const [name, ...rest] = raw.split('=');
  return { [name.trim() || '規格']: (rest.join('=') || '標準').trim() };
})();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...args) => console.log('•', ...args);
const warn = (...args) => console.warn('!', ...args);
const fail = (...args) => console.error('✗', ...args);

// ---------------- HTTP ----------------
const jar = new Map();
async function call(method, path, { body, csrf, idempotency, cookies = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  // 写接口会校验 Origin 必须等于 APP_ORIGIN
  if (method !== 'GET') headers.origin = ORIGIN;
  if (csrf) headers['x-csrf-token'] = csrf;
  if (idempotency) headers['idempotency-key'] = idempotency;
  if (cookies && jar.size) headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');

  const request = () => fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

  let response = await request();
  // 身份限流：每个 IP 每 15 分钟只允许 60 次写（identityIpAttemptsPerWindow / accountFailureWindowSeconds）。
  // 批量导入必然撞到 429，这里等窗口滚动后自动续跑，而不是把整批打成失败。
  for (let attempt = 0; response.status === 429 && method !== 'GET' && attempt < MAX_RETRIES; attempt += 1) {
    warn(`写接口被限流（429），等待 ${RETRY_WAIT}s 后继续（第 ${attempt + 1}/${MAX_RETRIES} 次）`);
    await sleep((RETRY_WAIT + 3) * 1000);
    response = await request();
  }

  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === '') jar.delete(name); else jar.set(name, value);
  }
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, body: json, etag: response.headers.get('etag') };
}

function describe(result) {
  const error = result.body?.error;
  if (!error) return `HTTP ${result.status}`;
  const fields = error.fieldErrors?.length ? ` ${JSON.stringify(error.fieldErrors)}` : '';
  return `HTTP ${result.status} ${error.code ?? ''} ${error.message ?? ''}${fields}`.trim();
}

// ---------------- TOTP ----------------
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const char of String(input).replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error('TOTP 密钥不是合法 base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function totpCode(secret, stepOffset = 0) {
  const counter = Math.floor(Date.now() / 30000) + stepOffset;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

async function login() {
  let creds;
  try { creds = JSON.parse(await readFile(CREDS, 'utf8')); }
  catch { throw new Error(`读不到管理员凭据 ${CREDS}（先用 scripts/seed-demo.mjs 生成，或用 --creds 指定）`); }

  const attempt = async () => {
    const result = await call('POST', '/api/v1/admin/auth/login', {
      body: { email: creds.email, password: creds.password }, cookies: false });
    if (result.status === 200) return result.body.data;
    if (result.status !== 202) throw new Error(`登录失败：${describe(result)}`);
    const challengeId = result.body.data.challengeId;
    if (!creds.totpSecret) throw new Error('账号启用了 MFA，但凭据里没有 totpSecret');
    for (const offset of [0, 1, 2]) {
      const verify = await call('POST', '/api/v1/admin/auth/mfa/verify', { body: { challengeId, code: totpCode(creds.totpSecret, offset) } });
      if (verify.status === 200) return verify.body.data;
    }
    return null;
  };

  for (let round = 0; round < 3; round += 1) {
    const session = await attempt();
    if (session) return session;
    await sleep(1_200);
  }
  throw new Error('MFA 连续失败：确认凭据里的 totpSecret 仍有效，或换一个服务账号');
}

// ---------------- 读取输入 ----------------
const raw = await readFile(file, 'utf8');
const isJson = /\.json$/i.test(file) || raw.trimStart().startsWith('[') || raw.trimStart().startsWith('{');
let drafts;
if (isJson) {
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed) ? parsed : parsed.products ?? [];
  drafts = groupFromJson(items, { defaultMarket: MARKET });
} else {
  const { header, rows, ragged } = parseCsv(raw);
  if (!header.length) { fail('CSV 为空'); process.exit(2); }
  if (ragged.length) {
    fail(`CSV 有 ${ragged.length} 行列数与表头不一致（多为引号/逗号未转义，会让整行错位）：`);
    ragged.slice(0, 10).forEach(row => fail(`  第 ${row.line} 行：${row.actual} 列，表头 ${row.expected} 列`));
    fail('修正后重跑；确认无误可加 --allow-ragged 强制继续。');
    if (!flag('allow-ragged')) process.exit(2);
  }
  const unknown = header.filter(column => !/^(attr_\d+_(name|value)|option[1-4]_(name|value))$/.test(column)
    && !['product_key', 'base_sku', 'category_path', 'brand', 'market_codes', 'variant_sku', 'price_hkd',
      'compare_at_hkd', 'currency', 'stock_qty', 'variant_status', 'image_urls', 'alt_zh_HK', 'publish_now',
      'tax_class_ref', 'allowed_channels'].includes(column)
    && !/^(name|slug|short|desc)_(zh_HK|zh_CN|en)$/.test(column.replace(/-/g, '_')));
  if (unknown.length) warn(`未识别的列（会被忽略）：${unknown.join(', ')}`);
  drafts = groupProducts(rows, { defaultMarket: MARKET, defaultOption: DEFAULT_OPTION });
}
if (PUBLISH_OVERRIDE !== null) drafts.forEach(draft => { draft.publish = PUBLISH_OVERRIDE; });
if (LIMIT > 0) drafts = drafts.slice(0, LIMIT);
if (!drafts.length) { fail('没有解析出任何商品行（检查 product_key / variant_sku 列）'); process.exit(2); }
log(`解析到 ${drafts.length} 个商品、${drafts.reduce((sum, draft) => sum + draft.variants.length, 0)} 个规格`);

// ---------------- --plan：离线校验 ----------------
if (PLAN_ONLY) {
  const report = validateDrafts(drafts, { currency: String(option('currency', 'HKD')), fillMissingLocale: FILL_MISSING });
  let failed = 0;
  for (const row of report) {
    if (row.errors.length) failed += 1;
    console.log(`\n[${row.errors.length ? '✗' : '✓'}] ${row.key}`);
    row.errors.forEach(message => console.log(`    error: ${message}`));
    row.warnings.forEach(message => console.log(`    warn : ${message}`));
  }
  const draft = drafts[0];
  console.log('\n第一个商品的请求体骨架（分类/市场已定后即为此形状）：');
  try {
    console.log(JSON.stringify(toProductBody({ ...draft, publish: false },
      { currency: String(option('currency', 'HKD')), categoryIds: ['<category-uuid>'], brandId: draft.brand ? '<brand-uuid>' : null,
        marketCodes: draft.marketCodes, locales: ['zh-CN', 'zh-HK', 'en'], fillMissingLocale: FILL_MISSING,
        fallbackLocale: FALLBACK_LOCALE }), null, 2));
  } catch (error) {
    console.log(`（无法构建请求体：${error.message}）`);
  }
  console.log(`\n合计：${drafts.length} 个商品，失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}

// ---------------- 登录与上下文 ----------------
const session = await login();
const csrf = session.csrfToken;
log(`已登录：${session.user.email}`);

const configResult = await call('GET', '/api/v1/admin/store-config');
if (configResult.status !== 200) { fail(`读不到店铺配置：${describe(configResult)}`); process.exit(1); }
const config = configResult.body.data;
const currency = config.baseCurrency ?? 'HKD';
const locales = config.locales ?? ['zh-CN', 'zh-HK', 'en'];
const approvedMarkets = new Set((config.marketProfiles ?? [])
  .filter(market => market.enabled && market.reviewStatus === 'approved').map(market => market.marketCode));
log(`店铺：${config.displayName}｜基准币 ${currency}｜启用语言 ${locales.join('/')}｜已审核市场 ${[...approvedMarkets].join(',') || '（无）'}`);

const preflight = validateDrafts(drafts, { currency, locales, fillMissingLocale: FILL_MISSING });
const preflightErrors = new Map(preflight.map(row => [row.key, row.errors]));
for (const draft of drafts) {
  for (const code of draft.marketCodes) {
    if (!approvedMarkets.has(code)) preflightErrors.get(draft.key)?.push(`市场 ${code} 未审核通过或未启用`);
  }
}

// 后端写限流是「每 IP 每 15 分钟 60 次写」，批量导入必然撞到，先算个账让调用方有预期
const estimateWrites = drafts.length
  + new Set(drafts.map(draft => draft.brand).filter(Boolean)).size
  + new Set(drafts.map(draft => draft.categoryPath.join('/'))).size
  + drafts.filter(draft => draft.publish).length
  + drafts.reduce((sum, draft) => sum + stockTargets(draft).length, 0);
log(`预计写请求 ≤ ${estimateWrites} 次（新建商品/品牌/分类 + 发布 + 库存）；按 60 次/15 分钟估算约 ${Math.ceil(estimateWrites / 60) * 15} 分钟`);

// ---------------- 已有商品（幂等靠 SKU/slug 查重）----------------
async function loadExistingProducts() {
  const bySku = new Map();
  const bySlug = new Map();
  let cursor = null;
  for (let page = 0; page < 200; page += 1) {
    const result = await call('GET', `/api/v1/admin/products?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    if (result.status !== 200) throw new Error(`读取商品列表失败：${describe(result)}`);
    const data = result.body.data;
    for (const item of data.items ?? []) {
      for (const variant of item.variants ?? []) bySku.set(variant.sku, item);
      for (const translation of item.translations ?? []) bySlug.set(translation.slug, item);
    }
    if (!data.hasMore) break;
    cursor = data.nextCursor;
  }
  return { bySku, bySlug };
}

// ---------------- 分类：按路径解析，缺失则创建 ----------------
const categoryIndex = new Map();
async function loadCategories() {
  const result = await call('GET', '/api/v1/admin/categories');
  if (result.status !== 200) throw new Error(`读取分类失败：${describe(result)}`);
  categoryIndex.clear();
  for (const item of result.body.data.items ?? []) {
    for (const translation of item.translations ?? []) {
      categoryIndex.set(`${item.parentId ?? 'root'}::${translation.name.trim()}`, item.id);
    }
  }
  return result.body.data.items ?? [];
}

async function ensureCategory(path) {
  let parentId = null;
  for (const name of path) {
    const key = `${parentId ?? 'root'}::${name}`;
    let id = categoryIndex.get(key);
    if (id) { parentId = id; continue; }
    const created = await call('POST', '/api/v1/admin/categories', {
      body: { parentId, position: 0, enabled: true,
        translations: locales.map(locale => ({ locale, name })) },
      csrf,
    });
    if (created.status !== 201) throw new Error(`创建分类「${name}」失败：${describe(created)}`);
    id = created.body.data.id;
    categoryIndex.set(key, id);
    log(`分类已创建：${path.join('/')} → ${id}`);
    parentId = id;
  }
  return parentId;
}

// ---------------- 品牌：按名字解析，缺失则创建 ----------------
const brandIndex = new Map();
async function loadBrands() {
  const result = await call('GET', '/api/v1/admin/brands');
  if (result.status !== 200) throw new Error(`读取品牌失败：${describe(result)}`);
  brandIndex.clear();
  for (const item of result.body.data.items ?? []) {
    for (const translation of item.translations ?? []) {
      const name = translation.name?.trim();
      if (name) brandIndex.set(name, item.id);
    }
  }
}

async function ensureBrand(name) {
  const key = String(name).trim();
  const known = brandIndex.get(key);
  if (known) return known;
  const created = await call('POST', '/api/v1/admin/brands', {
    body: { enabled: true, translations: locales.map(locale => ({ locale, name: key })) }, csrf });
  if (created.status !== 201) throw new Error(`创建品牌「${key}」失败：${describe(created)}`);
  brandIndex.set(key, created.body.data.id);
  log(`品牌已创建：${key} → ${created.body.data.id}`);
  return created.body.data.id;
}

// ---------------- 执行 ----------------
if (DRY_RUN) {
  await loadCategories();
  await loadBrands();
  const existingDry = await loadExistingProducts();
  for (const draft of drafts) {
    const hit = draft.variants.map(variant => existingDry.bySku.get(variant.sku)).find(Boolean)
      ?? draft.translations.map(translation => existingDry.bySlug.get(translation.slug)).find(Boolean);
    const resolved = await resolveCategoryForPreview(draft.categoryPath);
    const categoryIds = Array.isArray(resolved) ? resolved : [resolved];
    const brandId = draft.brand
      ? (brandIndex.get(draft.brand.trim()) ?? `<新建品牌:${draft.brand.trim()}>`)
      : null;
    console.log(`\n=== ${draft.key}${hit ? `（已存在 ${hit.id}，将跳过）` : ''}`);
    const body = toProductBody(draft, { currency, categoryIds, brandId, marketCodes: draft.marketCodes,
      locales, fillMissingLocale: FILL_MISSING, fallbackLocale: FALLBACK_LOCALE });
    console.log(JSON.stringify(body, null, 2));
    console.log(`publish=${draft.publish} stock=${JSON.stringify(stockTargets(draft))}`);
  }
  process.exit(0);
}

async function resolveCategoryForPreview(path) {
  // dry-run 里只查不建：从缺失的那一段起返回占位
  let parentId = null;
  for (const [index, name] of path.entries()) {
    const id = categoryIndex.get(`${parentId ?? 'root'}::${name}`);
    if (!id) return path.slice(index).map(segment => `<新建:${segment}>`);
    parentId = id;
  }
  return parentId;
}

const existing = await loadExistingProducts();
// 必须先载入现有分类/品牌索引：否则 ensureCategory/ensureBrand 会以为库里什么都没有，
// 每批重跑都会再建一棵同名分类树（2026-11-23 生产实测踩到过）。
await loadCategories();
await loadBrands();
log(`已有商品索引：${existing.bySku.size} 个 SKU、${existing.bySlug.size} 个 slug；分类 ${categoryIndex.size} 条、品牌 ${brandIndex.size} 条`);

const results = [];
for (const draft of drafts) {
  const errors = [...(preflightErrors.get(draft.key) ?? [])];
  const record = { key: draft.key, sku: draft.variants.map(variant => variant.sku), action: 'none', errors, warnings: [],
    productId: null, published: false, stock: [] };

  if (errors.length) {
    record.action = 'failed';
    results.push(record);
    fail(`${draft.key}：${errors.join('；')}`);
    continue;
  }

  const hit = draft.variants.map(variant => existing.bySku.get(variant.sku)).find(Boolean)
    ?? draft.translations.map(translation => existing.bySlug.get(translation.slug)).find(Boolean);

  try {
    if (hit) {
      record.productId = hit.id;
      record.action = 'skipped';
      log(`${draft.key}：已存在（${hit.id}），跳过`);
      if (RESTOCK) {
        const targets = stockTargets(draft);
        for (const target of targets) {
          const variant = hit.variants.find(item => item.sku === target.sku);
          if (!variant) { record.warnings.push(`补库存跳过：已有商品里找不到规格 ${target.sku}`); continue; }
          const stockRow = await call('GET', `/api/v1/admin/inventory?q=${encodeURIComponent(target.sku)}&limit=10`);
          const item = (stockRow.body?.data?.items ?? []).find(entry => entry.sku === target.sku);
          const current = item?.onHand ?? 0;
          const delta = target.target - current;
          if (!delta) continue;
          const adjusted = await call('POST', '/api/v1/admin/inventory/adjustments', {
            body: { variantId: variant.id, delta, reason: '批量导入库存校准', reasonCode: 'import',
              expectedVersion: item?.version ?? 0 },
            csrf, idempotency: `import-${target.sku}-${createHash('sha256').update(`${target.target}`).digest('hex').slice(0, 12)}`,
          });
          if (adjusted.status >= 400) record.errors.push(`补库存 ${target.sku} 失败：${describe(adjusted)}`);
          else { record.stock.push({ sku: target.sku, delta }); log(`${draft.key}：库存校准 ${target.sku} ${delta > 0 ? '+' : ''}${delta}`); }
        }
      }
      results.push(record);
      continue;
    }

    // 1) 建草稿
    const categoryIds = await ensureCategory(draft.categoryPath);
    const brandId = draft.brand ? await ensureBrand(draft.brand) : null;
    const body = toProductBody(draft, { currency, categoryIds: [categoryIds], brandId, marketCodes: draft.marketCodes,
      locales, fillMissingLocale: FILL_MISSING, fallbackLocale: FALLBACK_LOCALE });
    const created = await call('POST', '/api/v1/admin/products', { body, csrf });
    if (created.status !== 201) throw new Error(`创建失败：${describe(created)}`);
    const product = created.body.data;
    record.productId = product.id;
    record.action = 'created';
    log(`${draft.key}：已创建 ${product.id}（${body.variants.length} 个规格）`);
    (created.body.data.variants ?? []).forEach(variant => existing.bySku.set(variant.sku, product));
    (product.translations ?? []).forEach(translation => existing.bySlug.set(translation.slug, product));

    // 2) 发布
    if (draft.publish) {
      const published = await call('POST', `/api/v1/admin/products/${product.id}/publish`, {
        body: { expectedVersion: product.version, marketCodes: draft.marketCodes, publishedAt: null }, csrf });
      if (published.status !== 200) record.errors.push(`发布失败：${describe(published)}`);
      else { record.published = true; log(`${draft.key}：已发布到 ${draft.marketCodes.join(',')}`); }
    }

    // 3) 初始库存（新建商品没有 InventoryItem，expectedVersion 用 0）
    for (const target of stockTargets(draft)) {
      const variant = (product.variants ?? []).find(item => item.sku === target.sku);
      if (!variant) { record.warnings.push(`补库存跳过：返回里找不到规格 ${target.sku}`); continue; }
      const adjusted = await call('POST', '/api/v1/admin/inventory/adjustments', {
        body: { variantId: variant.id, delta: target.target, reason: '批量导入初始库存', reasonCode: 'import', expectedVersion: 0 },
        csrf, idempotency: `import-${target.sku}-${createHash('sha256').update(`${target.target}`).digest('hex').slice(0, 12)}`,
      });
      if (adjusted.status >= 400) record.errors.push(`库存 ${target.sku} 失败：${describe(adjusted)}`);
      else { record.stock.push({ sku: target.sku, delta: target.target }); log(`${draft.key}：库存 ${target.sku} +${target.target}`); }
    }
  } catch (error) {
    record.errors.push(error.message);
    record.action = record.action === 'created' ? 'created' : 'failed';
    fail(`${draft.key}：${error.message}`);
  }

  results.push(record);
  if (DELAY) await sleep(DELAY);
}

// ---------------- 汇总 ----------------
const count = action => results.filter(record => record.action === action).length;
const withErrors = results.filter(record => record.errors.length);
console.log('\n================ 汇总 ================');
console.log(`创建 ${count('created')}｜跳过 ${count('skipped')}｜失败 ${count('failed')}｜有错误的记录 ${withErrors.length}`);
for (const record of withErrors) {
  console.log(`  ✗ ${record.key}${record.productId ? ` (${record.productId})` : ''}`);
  record.errors.forEach(message => console.log(`      ${message}`));
}
for (const record of results.filter(item => item.warnings.length)) {
  record.warnings.forEach(message => warn(`${record.key}：${message}`));
}

if (REPORT_PATH && REPORT_PATH !== true) {
  await writeFile(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), api: API, origin: ORIGIN,
    currency, market: MARKET, results }, null, 2), 'utf8');
  log(`行级报告已写入 ${REPORT_PATH}`);
}

process.exit(withErrors.length ? 1 : 0);
