// 演示数据引导脚本：在容器内直接跑，负责
//   1) 用 BOOTSTRAP_TOKEN 建店主账号并完成 TOTP 注册（只用一次）
//   2) 配置店铺 + 开通 HK 市场（含合规审核记录）
//   3) 建一个演示商品、发布到该市场、补库存
//   4) 校验前台接口确实能看到它
//   5) 配置运费（HK 区域 + 标准费率，含 COD 开关）
//   6) 游客完整下单链路：购物袋 → 加购 → 报价 → COD 下单，管理端核对
//
// 用法（服务器上，compose 目录内）：
//   sudo docker compose run --rm --no-deps -T \
//     -v /opt/ezstart-secrets:/secrets \
//     -v "$PWD/../../..:/repo:ro" \
//     api node /repo/scripts/seed-demo.mjs
//
// 幂等：已建过账号则用 /secrets/admin.json 里的凭据登录；商品/市场/运费/订单都会查重后跳过。
import { createHmac, randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const BASE = process.env.API_BASE ?? 'http://api:3001';
const ORIGIN = process.env.APP_ORIGIN ?? 'https://mrinhk.com';
const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN ?? '';
const SECRET_FILE = process.env.SECRET_FILE ?? '/secrets/admin.json';
const MARKET = process.env.SEED_MARKET ?? 'HK';
const OWNER_EMAIL = process.env.SEED_EMAIL ?? 'owner@mrinhk.com';

const jar = new Map();
const log = (...args) => console.log('•', ...args);
const die = (message, detail) => {
  console.error('✗', message, detail === undefined ? '' : JSON.stringify(detail, null, 2));
  process.exit(1);
};

// ---------------- HTTP ----------------
async function call(method, path, { body, csrf, ifMatch, idempotency, bootstrapToken, cookies = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  // 写接口会校验 Origin 必须等于 APP_ORIGIN
  if (method !== 'GET') headers.origin = ORIGIN;
  if (csrf) headers['x-csrf-token'] = csrf;
  if (ifMatch !== undefined) headers['if-match'] = `"${ifMatch}"`;
  if (idempotency) headers['idempotency-key'] = idempotency;
  if (bootstrapToken) headers['x-bootstrap-token'] = bootstrapToken;
  if (cookies && jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === '') jar.delete(name); else jar.set(name, value);
  }
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, body: json, etag: response.headers.get('etag') };
}

function must(result, what) {
  if (result.status >= 400) die(`${what} 失败（HTTP ${result.status}）`, result.body);
  return result.body?.data;
}

// ---------------- TOTP ----------------
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error('bad base32');
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

// ---------------- 会话 ----------------
async function loginExisting(creds) {
  // 同一 30 秒窗口内重复登录会撞上 lastUsedStep 去重，因此每个候选步长都重新开一次挑战
  for (const offset of [0, 1, 2]) {
    const login = await call('POST', '/api/v1/admin/auth/login', { body: { email: creds.email, password: creds.password }, cookies: false });
    // 登录/验码成功时 data 本身就是会话对象；注册确认（bootstrap 路径）才是 { session, recoveryCodes }
    if (login.status === 200) return must(login, '登录');
    if (login.status !== 202) die('登录失败', login.body);
    const challengeId = must(login, '登录').challengeId;
    const verify = await call('POST', '/api/v1/admin/auth/mfa/verify', { body: { challengeId, code: totpCode(creds.totpSecret, offset) } });
    if (verify.status === 200) return must(verify, 'MFA 验证');
  }
  die('MFA 验证连续失败：请确认 /secrets/admin.json 里的 TOTP 密钥仍有效，或用恢复码重置');
}

async function bootstrapOwner() {
  const password = `Demo-${randomBytes(9).toString('base64url')}9aA`;
  const start = await call('POST', '/api/v1/admin/auth/bootstrap',
    { body: { email: OWNER_EMAIL, password, displayName: 'IN先生 店主', locale: 'zh-HK' }, bootstrapToken: BOOTSTRAP_TOKEN, cookies: false });
  if (start.status === 409) die('账号已存在但 /secrets/admin.json 缺失，无法继续（需人工恢复 TOTP 或重置）', start.body);
  const challengeId = must(start, '创建店主账号').challengeId;

  const enroll = await call('POST', '/api/v1/admin/auth/mfa/enrollments', { body: { challengeId } });
  const enrollment = must(enroll, '开始 MFA 注册');
  const confirm = await call('POST', '/api/v1/admin/auth/mfa/enrollments/confirm',
    { body: { challengeId, enrollmentId: enrollment.enrollmentId, code: totpCode(enrollment.totpSecret) } });
  const done = must(confirm, '确认 MFA 注册');

  await mkdir('/secrets', { recursive: true }).catch(() => {});
  await writeFile(SECRET_FILE, JSON.stringify({ email: OWNER_EMAIL, password, totpSecret: enrollment.totpSecret,
    recoveryCodes: done.recoveryCodes }, null, 2), { mode: 0o600 });
  log(`店主账号已创建，凭据写入 ${SECRET_FILE}（含 TOTP 密钥与恢复码，权限 600）`);
  return done.session;
}

// ---------------- 主流程 ----------------
let creds = null;
try { creds = JSON.parse(await readFile(SECRET_FILE, 'utf8')); } catch { /* 首次运行 */ }

const session = creds ? await loginExisting(creds) : await bootstrapOwner();
const csrf = session.csrfToken;
log(`会话就绪：${session.user.email}，权限 ${session.permissionCodes.length} 项`);

// 1) 店铺配置（先建市场，但先不启用）
const readConfig = await call('GET', '/api/v1/admin/store-config');
const config = must(readConfig, '读取店铺配置');
const version = Number(readConfig.etag?.replaceAll('"', '') ?? config.version);
const currency = config.baseCurrency ?? 'HKD';
log(`店铺：${config.displayName}，默认语言 ${config.defaultLocale}，基准币种 ${currency}，版本 ${version}`);

if (!(config.marketProfiles ?? []).some((market) => market.marketCode === MARKET)) {
  must(await call('PATCH', '/api/v1/admin/store-config', {
    body: { displayName: 'IN先生 Mr. IN', marketProfiles: [{ marketCode: MARKET, enabled: false }] },
    csrf, ifMatch: version,
  }), '新增市场');
  log(`市场 ${MARKET} 已创建（待审核）`);
}

// 2) 合规审核 → 启用市场
const afterCreate = must(await call('GET', '/api/v1/admin/store-config'), '重读店铺配置');
const market = (afterCreate.marketProfiles ?? []).find((item) => item.marketCode === MARKET);
if (!market) die('市场未创建成功');
if (market.reviewStatus !== 'approved' || !market.enabled) {
  const beforeReview = Number((await call('GET', '/api/v1/admin/store-config')).etag?.replaceAll('"', ''));
  if (market.reviewStatus !== 'approved') {
    must(await call('POST', `/api/v1/admin/store-config/markets/${MARKET}/reviews`, {
      body: { decision: 'approved', evidenceReference: 'SEED-DEMO-EVIDENCE-001', reason: '演示环境初始化',
        validUntil: new Date(Date.now() + 365 * 86_400_000).toISOString(), confirmedMarketCode: MARKET },
      csrf, ifMatch: beforeReview,
    }), '提交市场审核');
    log(`市场 ${MARKET} 审核通过`);
  }
  const latest = await call('GET', '/api/v1/admin/store-config');
  const latestVersion = Number(latest.etag?.replaceAll('"', ''));
  const profiles = (latest.body.data.marketProfiles ?? []).map((item) => ({
    marketCode: item.marketCode, enabled: item.marketCode === MARKET ? true : item.enabled,
    eligibleProductIds: item.eligibleProductIds ?? [],
  }));
  must(await call('PATCH', '/api/v1/admin/store-config', { body: { marketProfiles: profiles }, csrf, ifMatch: latestVersion }), '启用市场');
  log(`市场 ${MARKET} 已启用`);
}

// 3) 演示商品（商品必须有分类：契约与目录规则都不允许空 categoryIds）
const categories = await call('GET', '/api/v1/admin/categories');
let categoryId = (categories.body?.data?.items ?? [])[0]?.id;
if (!categoryId) {
  const created = must(await call('POST', '/api/v1/admin/categories', {
    body: { translations: [{ locale: 'zh-HK', name: '家居器物' }, { locale: 'zh-CN', name: '家居器物' }], position: 0, enabled: true },
    csrf,
  }), '创建分类');
  categoryId = created.id;
  log(`分类已创建：${categoryId}`);
}

const slug = 'demo-matcha-bowl';
// 发布校验要求“所有启用语言都要有翻译”，店铺默认启用 zh-CN / zh-HK / en，三语都必须给。
const translations = [
  { locale: 'zh-HK', name: '手作抹茶碗', slug, shortDescription: '手捏陶土，釉色自然', description: '日本進口陶土手作，每只紋理略有不同。' },
  { locale: 'zh-CN', name: '手作抹茶碗', slug, shortDescription: '手捏陶土，釉色自然', description: '日本进口陶土手作，每只纹理略有不同。' },
  { locale: 'en', name: 'Handmade Matcha Bowl', slug, shortDescription: 'Hand-thrown stoneware with a natural glaze', description: 'Handmade from Japanese clay. Each piece has its own texture.' },
];
const existing = await call('GET', '/api/v1/admin/products?limit=100');
const found = (existing.body?.data?.items ?? []).find((item) => (item.translations ?? []).some((t) => t.slug === slug));
let productId;
if (found) {
  productId = found.id;
  log(`商品已存在，跳过创建：${productId}`);
} else {
  const created = await call('POST', '/api/v1/admin/products', {
    body: {
      translations,
      variants: [{ sku: 'DEMO-MATCHA-01', optionValues: { 容量: '400ml' }, priceMinor: 32800, currency }],
      // 契约要求这四项必填（即使为空数组也要显式给出）
      media: [],
      categoryIds: [categoryId],
      marketCodes: [MARKET],
    },
    csrf,
  });
  if (created.status === 409) {
    // SKU/slug 唯一约束冲突：说明上一轮已经建过，重新定位即可
    const again = await call('GET', '/api/v1/admin/products?limit=100');
    const hit = (again.body?.data?.items ?? []).find((item) => (item.translations ?? []).some((t) => t.slug === slug));
    if (!hit) die('商品创建冲突，但列表里定位不到', created.body);
    productId = hit.id;
    log(`商品已存在（冲突后重新定位）：${productId}`);
  } else {
    productId = must(created, '创建商品').id;
    log(`商品已创建：${productId}`);
  }
}

// 3.5) 补齐缺失语言的翻译（老数据或分步调试时可能缺 en，发布前必须补齐）
const before = must(await call('GET', `/api/v1/admin/products/${productId}`), '读取商品');
const haveLocales = new Set((before.translations ?? []).map((t) => t.locale));
if (translations.some((t) => !haveLocales.has(t.locale))) {
  must(await call('PATCH', `/api/v1/admin/products/${productId}`, { body: { translations }, csrf, ifMatch: before.version }), '补齐翻译');
  log('已补齐三语翻译');
}

// 4) 发布到市场
const draft = must(await call('GET', `/api/v1/admin/products/${productId}`), '读取商品');
if (draft.status !== 'active') {
  must(await call('POST', `/api/v1/admin/products/${productId}/publish`, {
    body: { expectedVersion: draft.version, marketCodes: [MARKET], publishedAt: null }, csrf,
  }), '发布商品');
  log('商品已发布');
} else {
  log('商品已是上架状态');
}

// 5) 补库存（让前台显示可售）——发布后重读，避免用旧版本号
const detail = must(await call('GET', `/api/v1/admin/products/${productId}`), '重读商品');
const variant = detail.variants[0];
if ((variant.inventory?.onHand ?? 0) < 1) {
  must(await call('POST', '/api/v1/admin/inventory/adjustments', {
    body: { variantId: variant.id, delta: 20, reason: '演示数据初始化', reasonCode: 'seed', expectedVersion: variant.inventory?.version ?? 0 },
    csrf, idempotency: `seed-${variant.id}-${createHash('sha256').update('demo').digest('hex').slice(0, 8)}`,
  }), '补库存');
  log('库存已补 20');
} else {
  log(`库存已有 ${variant.inventory.onHand}，跳过`);
}

// 6) 前台校验
const front = await call('GET', '/api/v1/storefront/products?marketCode=' + MARKET, { cookies: false });
must(front, '前台商品列表');
const visible = (front.body.data.items ?? []).find((item) => item.slug === slug);
if (!visible) die('前台看不到演示商品', front.body.data);
log(`✅ 前台可见：${visible.name} / ${visible.variants.length} 个规格 / inStock=${visible.inStock}`);

// 7) 运费配置：HK 区域 + 标准配送费率
//    COD（货到付款）能否在结账时可用，取决于费率上的 codEnabled，必须显式开启。
const zoneList = must(await call('GET', '/api/v1/admin/shipping/zones'), '读取运费区域');
const ZONE_CODE = 'HK-ALL';
let zoneId = (zoneList.items ?? []).find((z) => z.code === ZONE_CODE)?.id;
if (!zoneId) {
  zoneId = must(await call('POST', '/api/v1/admin/shipping/zones', {
    body: {
      code: ZONE_CODE,
      nameByLocale: { 'zh-HK': '香港全境', 'zh-CN': '香港全境', en: 'Hong Kong (all districts)' },
      countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true,
    },
    csrf,
  }), '创建运费区域').id;
  log(`运费区域已创建：${ZONE_CODE}`);
} else {
  log(`运费区域已存在：${ZONE_CODE}`);
}

const RATE_CODE = 'STD-HK';
const rateList = must(await call('GET', '/api/v1/admin/shipping/rates'), '读取运费费率');
let rate = (rateList.items ?? []).find((r) => r.code === RATE_CODE);
if (!rate) {
  rate = must(await call('POST', '/api/v1/admin/shipping/rates', {
    body: {
      code: RATE_CODE,
      nameByLocale: { 'zh-HK': '標準配送（2-5個工作日）', 'zh-CN': '标准配送（2-5个工作日）', en: 'Standard delivery (2-5 business days)' },
      zoneIds: [zoneId],
      fixedFeeMinor: 3000,          // HK$30
      freeAboveMinor: 80000,        // 满 HK$800 免运
      currency,
      estimatedMinDays: 2,
      estimatedMaxDays: 5,
      codEnabled: true,             // COD 依赖这个开关
      enabled: true,
    },
    csrf,
  }), '创建运费费率');
  log(`运费费率已创建：${RATE_CODE}（HK$30，满 HK$800 免运，支持 COD）`);
} else if (!rate.codEnabled) {
  // 已存在但没开 COD：补开，否则结账选不到货到付款
  must(await call('PATCH', `/api/v1/admin/shipping/rates/${rate.id}`, {
    body: { codEnabled: true, enabled: true }, csrf, ifMatch: rate.version,
  }), '开启费率 COD');
  log(`运费费率 ${RATE_CODE} 已补开 COD`);
} else {
  log(`运费费率已存在：${RATE_CODE}`);
}
const rateId = rate.id;

// 8) 游客完整下单链路：建购物袋 → 加购 → 报价 → COD 下单
//    幂等：先查管理端是否已有演示订单（customerNote 唯一标识），有则跳过。
const DEMO_NOTE = 'seed-demo-order';
const existingOrders = must(await call('GET', `/api/v1/admin/orders?q=${encodeURIComponent(DEMO_NOTE)}&limit=10`), '查询演示订单');
const hasDemoOrder = (existingOrders.items ?? []).length > 0;

if (hasDemoOrder) {
  log('演示订单已存在，跳过下单链路');
} else {
  // 游客侧是独立的 cookie 世界，不能混用管理端会话
  const guestJar = new Map();
  async function guest(method, path, { body, csrf, idempotency } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers.origin = ORIGIN;
    if (csrf) headers['x-csrf-token'] = csrf;
    if (idempotency) headers['idempotency-key'] = idempotency;
    if (guestJar.size) headers.cookie = [...guestJar].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') guestJar.delete(name); else guestJar.set(name, value);
    }
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: response.status, body: json };
  }

  // 8.1) 建购物袋（响应里种下 ez_guest_cart + ez_cart_csrf 两个 cookie）
  const cart = must(await guest('POST', '/api/v1/storefront/cart', { body: {} }), '创建购物袋');
  const cartCsrf = guestJar.get('ez_cart_csrf');
  if (!cartCsrf) die('购物袋 CSRF cookie 缺失');
  log(`购物袋已创建：${cart.cartId}（${cart.currency}）`);

  // 8.2) 加购演示商品 ×1（购物袋 CSRF 是双提交：cookie 值原样放请求头）
  const added = must(await guest('POST', '/api/v1/storefront/cart/items', {
    body: { variantId: variant.id, quantity: 1 }, csrf: cartCsrf,
  }), '加购');
  if (!added.items.some((item) => item.variantId === variant.id)) die('加购结果异常', added);
  log(`已加购：${added.items[0].productName} ×1（小计 ${added.subtotalMinor}）`);

  // 8.3) 报价（HK 地址命中 STD-HK 费率；政策同意任意 key，前台上线前应换成真实政策版本）
  const quote = must(await guest('POST', '/api/v1/storefront/checkout/quote', {
    body: {
      cartId: cart.cartId,
      locale: 'zh-HK',
      marketCode: MARKET,
      contact: { fullName: '陳大文', phone: '+85291234567' },
      shippingAddress: {
        recipientName: '陳大文', phone: '+85291234567',
        countryCode: 'HK', city: '香港', district: '油尖旺區',
        addressLine1: '彌敦道 1 號演示大廈 3 樓 301 室',
      },
      shippingMethodId: rateId,
      policyAcceptances: [{ policyKey: 'terms-of-service', version: 'demo-v1', accepted: true }],
    },
    csrf: cartCsrf,
  }), '报价');
  log(`报价完成：小計 ${quote.subtotalMinor} / 運費 ${quote.shippingMinor} / 合計 ${quote.totalMinor}（有效期至 ${quote.expiresAt}）`);

  // 8.4) COD 下单（幂等键防重复提交）
  const order = must(await guest('POST', '/api/v1/storefront/checkout/orders', {
    body: {
      quoteId: quote.quoteId,
      confirmedQuoteVersion: quote.version,
      paymentMethodCode: 'cod',
      customerNote: DEMO_NOTE,
    },
    csrf: cartCsrf,
    idempotency: `seed-demo-${quote.quoteId}`,
  }), '下单');
  log(`✅ 订单已创建：${order.publicOrderNumber}（${order.orderStatus} / ${order.paymentStatus}，HK$${order.totalMinor / 100}）`);
  if (order.paymentAction?.instructions) log(`付款说明：${order.paymentAction.instructions}`);
}

// 9) 管理端核对：订单确实可见
const ordersFinal = must(await call('GET', `/api/v1/admin/orders?q=${encodeURIComponent(DEMO_NOTE)}&limit=10`), '管理端订单核对');
const demoOrders = ordersFinal.items ?? [];
if (demoOrders.length < 1) die('管理端看不到演示订单');
log(`✅ 管理端可见 ${demoOrders.length} 笔演示订单（最新：${demoOrders[0].publicOrderNumber}，${demoOrders[0].paymentStatus}）`);
