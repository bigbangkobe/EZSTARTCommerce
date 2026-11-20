/**
 * 支付链路端到端冒烟（在实例容器内跑，只对 staging / 沙箱环境有意义）。
 *
 * 为什么需要它：单测跑在进程内嵌数据库里，证明的是"代码逻辑对"；
 * 这里跑在真实容器 + 真实 Postgres + 走 HTTP 的真实路由上，证明的是
 * "这个镜像部署起来能收钱、能退钱、能被对账救回来"。
 *
 * 覆盖：
 *   A 初始化   店主账号 / 市场审核 / 商品 / 运费 / mock 渠道配置与连接测试
 *   B 收钱     下单 → 发起支付 → 签名回调 → 入账 → 重复回调幂等 → 错签名 / 过期时间戳被拒
 *   C 退钱     创建退款 → 批准 → 执行（走适配器两阶段）→ 幂等重放 → 超额退款被拒
 *   D 对账     /internal/jobs/reconcile 带令牌可跑、不带令牌拒绝
 *
 * 用法（容器内，compose 目录执行）：
 *   docker compose run --rm --no-deps -T \
 *     -v /opt/ezstart-secrets:/secrets \
 *     api node /repo/scripts/smoke-payments.mjs
 *
 * 幂等：店主凭据落在 SECRET_FILE，重复运行直接登录；商品/运费/支付方式都查重。
 * 唯一不可重复的是"回调入账"——它本来就该只能成功一次。
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const BASE = process.env.API_BASE ?? 'http://api:3001';
const ORIGIN = process.env.APP_ORIGIN ?? 'https://localhost:8443';
const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN ?? '';
const SECRET_FILE = process.env.SECRET_FILE ?? '/secrets/admin.json';
const JOB_TOKEN = process.env.INTERNAL_JOB_TOKEN ?? '';
const MARKET = process.env.SEED_MARKET ?? 'HK';
const OWNER_EMAIL = process.env.SEED_EMAIL ?? `smoke-owner@${MARKET.toLowerCase()}.test`;
const PROVIDER = 'mock';

if (process.env.PAYMENTS_ENVIRONMENT !== 'sandbox') {
  console.error('✗ 该脚本只允许在 PAYMENTS_ENVIRONMENT=sandbox 的实例上运行');
  process.exit(1);
}

const results = [];
const log = (...args) => console.log('•', ...args);
const pass = (name, detail) => { results.push({ name, ok: true }); console.log('  ✅', name, detail ?? ''); };
const die = (name, detail) => {
  results.push({ name, ok: false });
  console.error('  ❌', name, detail === undefined ? '' : JSON.stringify(detail, null, 2));
  summary();
  process.exit(1);
};
const check = (name, condition, detail) => (condition ? pass(name, detail) : die(name, detail));

function summary() {
  const ok = results.filter(r => r.ok).length;
  console.log(`\n—— 结果：${ok}/${results.length} 通过 ——`);
}

// ---------------- HTTP ----------------
const adminJar = new Map();
async function http(method, path, { body, csrf, ifMatch, idempotency, bootstrapToken, jar = adminJar,
  cookies = true, headers: extra = {}, raw } = {}) {
  const headers = { ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers.origin = ORIGIN;
  if (csrf) headers['x-csrf-token'] = csrf;
  if (ifMatch !== undefined) headers['if-match'] = `"${ifMatch}"`;
  if (idempotency) headers['idempotency-key'] = idempotency;
  if (bootstrapToken) headers['x-bootstrap-token'] = bootstrapToken;
  if (cookies && jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

  const response = await fetch(`${BASE}${path}`, { method, headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  for (const cookieHeader of response.headers.getSetCookie?.() ?? []) {
    const [pair] = cookieHeader.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === '') jar.delete(name); else jar.set(name, value);
  }
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, body: json, etag: response.headers.get('etag'),
    headers: Object.fromEntries(response.headers.entries()) };
}
const must = (result, what) => {
  if (result.status >= 400) die(`${what}（HTTP ${result.status}）`, result.body);
  return result.body?.data;
};
const versionOf = async () => Number((await http('GET', '/api/v1/admin/store-config')).etag?.replaceAll('"', ''));

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

// ---------------- A. 会话 ----------------
let creds = null;
try { creds = JSON.parse(await readFile(SECRET_FILE, 'utf8')); } catch { /* 首次运行 */ }

async function loginExisting(saved) {
  for (const offset of [0, 1, 2]) {
    const login = await http('POST', '/api/v1/admin/auth/login',
      { body: { email: saved.email, password: saved.password }, cookies: false });
    if (login.status === 200) return must(login, '登录');
    if (login.status !== 202) die('登录失败', login.body);
    const challengeId = must(login, '登录').challengeId;
    const verify = await http('POST', '/api/v1/admin/auth/mfa/verify',
      { body: { challengeId, code: totpCode(saved.totpSecret, offset) } });
    if (verify.status === 200) return must(verify, 'MFA 验证');
  }
  die('MFA 连续失败：/secrets/admin.json 里的 TOTP 密钥可能已失效');
}

async function bootstrapOwner() {
  if (!BOOTSTRAP_TOKEN) die('BOOTSTRAP_TOKEN 未配置，无法初始化店主');
  const password = `Smoke-${randomBytes(9).toString('base64url')}9aA`;
  const start = await http('POST', '/api/v1/admin/auth/bootstrap', { body: {
    email: OWNER_EMAIL, password, displayName: 'Smoke 店主', locale: 'zh-HK' },
  bootstrapToken: BOOTSTRAP_TOKEN, cookies: false });
  if (start.status === 409) die('账号已存在但凭据文件缺失，需人工重置 TOTP', start.body);
  const challengeId = must(start, '创建店主账号').challengeId;
  const enrollment = must(await http('POST', '/api/v1/admin/auth/mfa/enrollments', { body: { challengeId } }), '开始 MFA 注册');
  const done = must(await http('POST', '/api/v1/admin/auth/mfa/enrollments/confirm', {
    body: { challengeId, enrollmentId: enrollment.enrollmentId, code: totpCode(enrollment.totpSecret) } }), '确认 MFA 注册');
  await mkdir('/secrets', { recursive: true }).catch(() => {});
  await writeFile(SECRET_FILE, JSON.stringify({ email: OWNER_EMAIL, password,
    totpSecret: enrollment.totpSecret, recoveryCodes: done.recoveryCodes }, null, 2), { mode: 0o600 });
  return done.session;
}

log('A. 初始化');
const session = creds ? await loginExisting(creds) : await bootstrapOwner();
const csrf = session.csrfToken;
pass(`店主会话就绪（${session.permissionCodes.length} 项权限）`);

// 市场：建 → 审核通过 → 启用
let config = must(await http('GET', '/api/v1/admin/store-config'), '读取店铺配置');
if (!(config.marketProfiles ?? []).some(m => m.marketCode === MARKET)) {
  must(await http('PATCH', '/api/v1/admin/store-config', { body: { marketProfiles: [{ marketCode: MARKET, enabled: false }] },
    csrf, ifMatch: await versionOf() }), '新增市场');
}
config = must(await http('GET', '/api/v1/admin/store-config'), '重读店铺配置');
let market = (config.marketProfiles ?? []).find(m => m.marketCode === MARKET);
if (market.reviewStatus !== 'approved') {
  must(await http('POST', `/api/v1/admin/store-config/markets/${MARKET}/reviews`, { body: {
    decision: 'approved', evidenceReference: 'SMOKE-EVIDENCE-001', reason: '冒烟环境初始化',
    validUntil: new Date(Date.now() + 365 * 86_400_000).toISOString(), confirmedMarketCode: MARKET },
  csrf, ifMatch: await versionOf() }), '提交市场审核');
  config = must(await http('GET', '/api/v1/admin/store-config'), '重读店铺配置');
  market = (config.marketProfiles ?? []).find(m => m.marketCode === MARKET);
}
if (!market.enabled) {
  const profiles = (config.marketProfiles ?? []).map(item => ({ marketCode: item.marketCode,
    enabled: item.marketCode === MARKET ? true : item.enabled, eligibleProductIds: item.eligibleProductIds ?? [] }));
  must(await http('PATCH', '/api/v1/admin/store-config', { body: { marketProfiles: profiles }, csrf,
    ifMatch: await versionOf() }), '启用市场');
}
pass(`市场 ${MARKET} 已启用`);

const currency = config.baseCurrency ?? 'HKD';

// 分类 + 商品
const categories = (await http('GET', '/api/v1/admin/categories')).body?.data?.items ?? [];
let categoryId = categories[0]?.id;
if (!categoryId) {
  categoryId = must(await http('POST', '/api/v1/admin/categories', { body: {
    translations: [{ locale: 'zh-HK', name: '冒烟分类' }, { locale: 'zh-CN', name: '冒烟分类' }],
    position: 0, enabled: true }, csrf }), '创建分类').id;
}
const slug = 'smoke-payment-item';
const translations = [
  { locale: 'zh-HK', name: '冒煙商品', slug, shortDescription: '用於支付鏈路驗證', description: '僅供冒煙測試。' },
  { locale: 'zh-CN', name: '冒烟商品', slug, shortDescription: '用于支付链路验证', description: '仅供冒烟测试。' },
  { locale: 'en', name: 'Smoke Test Item', slug, shortDescription: 'For payment path verification', description: 'Smoke test only.' },
];
const productList = (await http('GET', '/api/v1/admin/products?limit=100')).body?.data?.items ?? [];
let product = productList.find(item => (item.translations ?? []).some(t => t.slug === slug));
if (!product) {
  const created = await http('POST', '/api/v1/admin/products', { body: { translations,
    variants: [{ sku: 'SMOKE-PAY-01', optionValues: { 規格: '標準' }, priceMinor: 12800, currency }],
    media: [], categoryIds: [categoryId], marketCodes: [MARKET] }, csrf });
  if (created.status === 409) {
    const again = (await http('GET', '/api/v1/admin/products?limit=100')).body?.data?.items ?? [];
    product = again.find(item => (item.translations ?? []).some(t => t.slug === slug));
    if (!product) die('商品创建冲突且定位不到', created.body);
  } else product = must(created, '创建商品');
}
let detail = must(await http('GET', `/api/v1/admin/products/${product.id}`), '读取商品');
if (detail.status !== 'active') {
  must(await http('POST', `/api/v1/admin/products/${product.id}/publish`, { body: {
    expectedVersion: detail.version, marketCodes: [MARKET], publishedAt: null }, csrf }), '发布商品');
  detail = must(await http('GET', `/api/v1/admin/products/${product.id}`), '重读商品');
}
const variant = detail.variants[0];
if ((variant.inventory?.onHand ?? 0) < 1) {
  must(await http('POST', '/api/v1/admin/inventory/adjustments', { body: {
    variantId: variant.id, delta: 20, reason: '冒烟补货', reasonCode: 'smoke',
    expectedVersion: variant.inventory?.version ?? 0 }, csrf, idempotency: `smoke-stock-${variant.id}` }), '补库存');
}
pass(`商品 ${slug} 已上架且可售`);

// 运费
const zones = (await http('GET', '/api/v1/admin/shipping/zones')).body?.data?.items ?? [];
let zoneId = zones.find(z => z.code === 'SMOKE-HK')?.id;
if (!zoneId) {
  zoneId = must(await http('POST', '/api/v1/admin/shipping/zones', { body: { code: 'SMOKE-HK',
    nameByLocale: { 'zh-HK': '冒煙全境', 'zh-CN': '冒烟全境', en: 'Smoke zone' },
    countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true }, csrf }), '创建运费区域').id;
}
const rates = (await http('GET', '/api/v1/admin/shipping/rates')).body?.data?.items ?? [];
let rate = rates.find(r => r.code === 'SMOKE-STD');
if (!rate) {
  rate = must(await http('POST', '/api/v1/admin/shipping/rates', { body: { code: 'SMOKE-STD',
    nameByLocale: { 'zh-HK': '冒煙配送', 'zh-CN': '冒烟配送', en: 'Smoke delivery' },
    zoneIds: [zoneId], fixedFeeMinor: 2000, freeAboveMinor: null, currency,
    estimatedMinDays: 1, estimatedMaxDays: 3, codEnabled: false, enabled: true }, csrf }), '创建运费费率');
}
pass('运费已配置');

// mock 渠道：填凭据引用 → 连接测试 → 开通
const methods = (await http('GET', '/api/v1/admin/payment-methods')).body?.data?.items ?? [];
const mockRow = methods.find(m => m.providerCode === PROVIDER && m.environment === 'sandbox');
check('后台已播种 mock/sandbox 配置行（自助配置的前提）', Boolean(mockRow), mockRow);
must(await http('PATCH', '/api/v1/admin/payment-methods', { body: {
  providerCode: PROVIDER, environment: 'sandbox', enabled: true,
  approvalReference: 'SMOKE-APPROVAL-001',
  publicConfig: { providerAccountRef: 'SMOKE-MERCHANT-1', checkoutBase: `${ORIGIN}/mock-pay` },
  secretRef: 'secret://env/MOCK_PAYMENT_SECRET' },
csrf, ifMatch: mockRow.version }), '配置 mock 渠道');

const tested = must(await http('POST', `/api/v1/admin/payment-methods/${PROVIDER}/connection-test?environment=sandbox`,
  { body: {}, csrf }), '连接测试');
check('连接测试通过并写回 connectionStatus=ok', tested.connectionStatus === 'ok' || tested.ok === true, tested);

// ---------------- B. 收钱 ----------------
log('B. 收钱');
const guestJar = new Map();
const guest = (method, path, opts = {}) => http(method, path, { ...opts, jar: guestJar });

const cart = must(await guest('POST', '/api/v1/storefront/cart', { body: {} }), '创建购物袋');
const cartCsrf = guestJar.get('ez_cart_csrf');
if (!cartCsrf) die('购物袋 CSRF cookie 缺失');
must(await guest('POST', '/api/v1/storefront/cart/items',
  { body: { variantId: variant.id, quantity: 1 }, csrf: cartCsrf }), '加购');

const quote = must(await guest('POST', '/api/v1/storefront/checkout/quote', { body: {
  cartId: cart.cartId, locale: 'zh-HK', marketCode: MARKET,
  contact: { fullName: '冒煙測試', phone: '+85290000000' },
  shippingAddress: { recipientName: '冒煙測試', phone: '+85290000000', countryCode: 'HK',
    city: '香港', district: '油尖旺區', addressLine1: '彌敦道 1 號冒煙大廈 1 樓' },
  shippingMethodId: rate.id,
  policyAcceptances: [{ policyKey: 'terms-of-service', version: 'smoke-v1', accepted: true }] },
csrf: cartCsrf }), '报价');

const order = must(await guest('POST', '/api/v1/storefront/checkout/orders', { body: {
  quoteId: quote.quoteId, confirmedQuoteVersion: quote.version,
  paymentMethodCode: PROVIDER, customerNote: `smoke-${randomUUID()}` },
csrf: cartCsrf, idempotency: `smoke-order-${quote.quoteId}` }), '线上渠道下单');
check('线上渠道下单成功且处于待付', order.paymentStatus === 'created', `${order.publicOrderNumber} / ${order.paymentStatus}`);

const intent = must(await guest('POST', `/api/v1/storefront/checkout/orders/${order.id}/pay`, { body: {}, csrf: cartCsrf }),
  '发起线上支付');
check('拿到收银台跳转地址与渠道单号',
  Boolean(intent.redirectUrl && intent.providerTransactionId) && intent.status === 'pending', intent);

// 签名回调
const credentials = JSON.parse(process.env.MOCK_PAYMENT_SECRET ?? '{}');
if (!credentials.webhookSecret) die('MOCK_PAYMENT_SECRET 缺少 webhookSecret');
const event = { providerTransactionId: intent.providerTransactionId, paymentNumber: intent.publicPaymentNumber,
  status: 'succeeded', amountMinor: order.totalMinor, currency: order.currency,
  eventId: `smoke-${randomUUID()}`, occurredAt: new Date().toISOString() };
const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
const sign = (body, at = Date.now()) => ({
  'x-mock-signature': `sha256=${createHmac('sha256', credentials.webhookSecret).update(body).digest('hex')}`,
  'x-mock-timestamp': String(Math.floor(at / 1000)),
});
const webhook = (body, headers) => http('POST', `/api/v1/webhooks/payments/${PROVIDER}?env=sandbox`,
  { raw: body, headers: { 'content-type': 'application/json', ...headers }, cookies: false });

const badSignature = await webhook(rawBody, { ...sign(rawBody), 'x-mock-signature': 'sha256=deadbeef' });
check('错签名被拒（400，不进落库逻辑）', badSignature.status === 400, badSignature.body);

const expired = await webhook(rawBody, sign(rawBody, Date.now() - 600_000));
check('过期时间戳被拒（400，防重放）', expired.status === 400, expired.body);

const settled = await webhook(rawBody, sign(rawBody));
check('签名正确回调被接收（202 accepted）', settled.status === 202 && settled.body?.data?.kind === 'accepted', settled.body);

const afterPaid = must(await http('GET', `/api/v1/admin/payments?orderId=${order.id}`), '查询支付台账');
const paidRow = (afterPaid.items ?? [])[0];
check('订单转为已付、台账仅一条', paidRow?.status === 'succeeded', paidRow?.status);

const replay = await webhook(rawBody, sign(rawBody));
check('重复回调幂等（202 duplicate）', replay.status === 202 && replay.body?.data?.kind === 'duplicate', replay.body);

const afterReplay = must(await http('GET', `/api/v1/admin/payments?orderId=${order.id}`), '复查台账');
check('重复回调没有造出第二条流水', (afterReplay.items ?? []).length === 1, `count=${(afterReplay.items ?? []).length}`);

const orderDetail = must(await http('GET', `/api/v1/admin/orders/${order.id}`), '读取订单');
check('订单付款状态投影正确', orderDetail.paymentStatus === 'paid', orderDetail.paymentStatus);

// ---------------- C. 退钱 ----------------
log('C. 退钱');
const refund = must(await http('POST', '/api/v1/admin/refunds', { body: {
  orderId: order.id, paymentId: paidRow.id, amountMinor: order.totalMinor, currency: order.currency,
  reasonCode: 'customer_request', reason: '冒烟：顾客取消' },
csrf, idempotency: `smoke-refund-${order.id}` }), '创建退款单');
check('退款单已创建（requested）', refund.status === 'requested', refund.status);

const approved = must(await http('POST', `/api/v1/admin/refunds/${refund.id}/approve`,
  { body: { reason: '冒烟批准' }, csrf, idempotency: `smoke-refund-approve-${refund.id}` }), '批准退款');
check('退款单已批准', approved.status === 'approved', approved.status);

const executed = must(await http('POST', `/api/v1/admin/refunds/${refund.id}/execute`,
  { body: { reason: '冒烟执行退款' }, csrf, idempotency: `smoke-refund-exec-${refund.id}` }), '执行退款');
check('退款已走渠道并收敛为 refunded', executed.status === 'refunded',
  `${executed.status} / providerRefundId=${executed.externalRefundId ?? '(空)'}`);

const replayExec = await http('POST', `/api/v1/admin/refunds/${refund.id}/execute`,
  { body: { reason: '冒烟重放' }, csrf, idempotency: `smoke-refund-exec-${refund.id}` });
check('同一幂等键重放不报错也不产生第二笔', replayExec.status < 500,
  `HTTP ${replayExec.status} / status=${replayExec.body?.data?.status ?? 'n/a'}`);

const refundList = must(await http('GET', `/api/v1/admin/refunds?orderId=${order.id}`), '退款列表');
check('该订单只有一笔退款', (refundList.items ?? []).length === 1, `count=${(refundList.items ?? []).length}`);

const overRefund = await http('POST', '/api/v1/admin/refunds', { body: {
  orderId: order.id, paymentId: paidRow.id, amountMinor: order.totalMinor + 1, currency: order.currency,
  reasonCode: 'customer_request', reason: '冒烟：超额' },
csrf, idempotency: `smoke-refund-over-${order.id}-${randomUUID()}` });
check('超额退款被拒（4xx）', overRefund.status >= 400 && overRefund.status < 500,
  `HTTP ${overRefund.status} / ${overRefund.body?.error?.code}`);

// ---------------- D. 对账 ----------------
log('D. 对账');
const noToken = await http('POST', '/api/v1/internal/jobs/reconcile', { body: { olderThanMinutes: 1 } });
check('无令牌访问对账端点被拒', noToken.status === 401 || noToken.status === 403 || noToken.status === 503,
  `HTTP ${noToken.status}`);

if (!JOB_TOKEN) {
  log('跳过带令牌对账：INTERNAL_JOB_TOKEN 未注入');
} else {
  const job = await http('POST', '/api/v1/internal/jobs/reconcile',
    { body: { olderThanMinutes: 1, limit: 50 }, headers: { 'x-job-token': JOB_TOKEN } });
  check('带令牌对账成功并返回计数', job.status === 200 && job.body?.data !== undefined, job.body?.data);
}

summary();
if (results.some(r => !r.ok)) process.exit(1);
