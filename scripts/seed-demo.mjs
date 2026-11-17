// 演示数据引导脚本：在容器内直接跑，负责
//   1) 用 BOOTSTRAP_TOKEN 建店主账号并完成 TOTP 注册（只用一次）
//   2) 配置店铺 + 开通 HK 市场（含合规审核记录）
//   3) 建一个演示商品、发布到该市场、补库存
//   4) 校验前台接口确实能看到它
//
// 用法（服务器上，compose 目录内）：
//   sudo docker compose run --rm --no-deps -T \
//     -v /opt/ezstart-secrets:/secrets \
//     -v "$PWD/../../..:/repo:ro" \
//     api node /repo/scripts/seed-demo.mjs
//
// 幂等：已建过账号则用 /secrets/admin.json 里的凭据登录；已存在的商品/市场会跳过创建。
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
    if (login.status === 200) return must(login, '登录').session;
    if (login.status !== 202) die('登录失败', login.body);
    const challengeId = must(login, '登录').challengeId;
    const verify = await call('POST', '/api/v1/admin/auth/mfa/verify', { body: { challengeId, code: totpCode(creds.totpSecret, offset) } });
    if (verify.status === 200) return must(verify, 'MFA 验证').session;
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

// 3) 演示商品
const slug = 'demo-matcha-bowl';
const existing = await call('GET', `/api/v1/admin/products?q=${encodeURIComponent(slug)}`);
const exists = (existing.body?.data?.items ?? []).some((item) => (item.translations ?? []).some((t) => t.slug === slug));
let productId;
if (exists) {
  productId = (existing.body.data.items.find((item) => (item.translations ?? []).some((t) => t.slug === slug))).id;
  log(`商品已存在，跳过创建：${productId}`);
} else {
  const created = must(await call('POST', '/api/v1/admin/products', {
    body: {
      translations: [
        { locale: 'zh-HK', name: '手作抹茶碗', slug, shortDescription: '手捏陶土，釉色自然', description: '日本進口陶土手作，每只紋理略有不同。' },
        { locale: 'zh-CN', name: '手作抹茶碗', slug, shortDescription: '手捏陶土，釉色自然', description: '日本进口陶土手作，每只纹理略有不同。' },
      ],
      variants: [{ sku: 'DEMO-MATCHA-01', optionValues: { 容量: '400ml' }, priceMinor: 32800, currency }],
      // 契约要求这四项必填（即使为空数组也要显式给出）
      media: [],
      categoryIds: [],
      marketCodes: [MARKET],
    },
    csrf,
  }), '创建商品');
  productId = created.id;
  log(`商品已创建：${productId}`);
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
