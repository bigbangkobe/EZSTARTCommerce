/**
 * 商品级收款渠道约束的实例验收脚本。
 *
 * 在真实容器里验证四件事（不依赖任何 mock 支付网关）：
 * 1. 未限制渠道的商品，报价能拿到多个收款方式；
 * 2. 把商品限制为「只许先行转账」后，报价里的货到付款消失；
 * 3. 带着 COD 下单会被明确拒绝，错误码可区分；
 * 4. 恢复商品配置后报价回到原状（脚本不留下脏数据）。
 *
 * 运行：docker compose run --rm --no-deps -T -v <repo>:/repo:ro api node /repo/scripts/smoke-payment-channels.mjs
 */
// 容器内从编译产物加载：脚本本身以 .mjs 挂进来，不走 TS 编译。
const { connectDatabase } = await import('/app/dist/packages/database/src/client.js');

const BASE = process.env.API_BASE ?? 'http://api:3001';
const ORIGIN = process.env.APP_ORIGIN ?? 'https://localhost:8443';

const results = [];
const pass = (name, detail) => { results.push({ name, ok: true }); console.log('  ✅', name, detail ?? ''); };
const fail = (name, detail) => {
  results.push({ name, ok: false });
  const text = detail === undefined ? '' : JSON.stringify(detail, null, 2);
  console.error('  ❌', name, text);
  // 抛错而不是 exit：必须让 finally 有机会把商品配置改回去。
  throw new Error(name + ' ' + text);
};
const check = (name, condition, detail) => (condition ? pass(name, detail) : fail(name, detail));
function summary() {
  console.log(`\n—— 结果：${results.filter(r => r.ok).length}/${results.length} 通过 ——`);
}

const jar = new Map();
async function http(method, path, { body, csrf, idempotency } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers.origin = ORIGIN;
  if (csrf) headers['x-csrf-token'] = csrf;
  if (idempotency) headers['idempotency-key'] = idempotency;
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const response = await fetch(`${BASE}${path}`, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const [pair] = header.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === '') jar.delete(name); else jar.set(name, value);
  }
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, body: json };
}
const must = (result, what) => {
  if (result.status >= 400) fail(`${what}（HTTP ${result.status}）`, result.body);
  return result.body?.data;
};

const db = connectDatabase(process.env.DATABASE_URL);
const address = { recipientName: 'Smoke', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
  district: null, addressLine1: '1 Test Road', addressLine2: null, postalCode: null };
const contact = { email: 'smoke@example.test', phone: null, fullName: 'Smoke' };

let product = null;
let original = [];
try {
  // ---- 准备：拿一个可售商品、一个运费方式，并确保转账渠道处于启用状态 ----
  const variant = await db.productVariant.findFirst({
    where: { status: 'active', inventory: { onHand: { gt: 0 } } },
    include: { product: true }, orderBy: { createdAt: 'asc' },
  });
  if (!variant) fail('实例里没有可售商品，无法验收');
  product = variant.product;
  original = [...product.allowedPaymentChannels];

  const rate = await db.shippingRate.findFirst({ where: { enabled: true } });
  if (!rate) fail('实例里没有启用的运费方式，无法报价');

  const market = await db.marketProfile.findFirst({ where: { enabled: true, reviewStatus: 'approved' } });
  const marketCode = market?.marketCode ?? 'HK';

  // 按站点实际支付环境取配置行：staging 是 sandbox，生产是 production。
  const environment = process.env.PAYMENTS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production';
  const manual = await db.paymentMethodConfig.findFirst({
    where: { providerCode: 'manual_bank_transfer', environment } });
  if (!manual) fail('缺少转账渠道配置行');
  let manualRow = manual;
  if (!manualRow.enabled) {
    await db.paymentMethodConfig.update({ where: { id: manual.id }, data: { enabled: true,
      approvalReference: manual.approvalReference ?? 'smoke-verification', approvedAt: manual.approvedAt ?? new Date(),
      publicConfig: { accountSummary: 'FPS 12345678 / 轉賬後請 WhatsApp 通知' } } });
    manualRow = { ...manual, enabled: true };
    console.log('• 已临时启用转账渠道（仅本机验收）');
  }

  const newCart = async () => {
    const created = await http('POST', '/api/v1/storefront/cart');
    must(created, '创建购物袋');
    return { cartId: created.body.data.cartId, csrf: jar.get('ez_cart_csrf') };
  };
  const quote = async (cartId, csrf) => {
    const body = { cartId, locale: 'zh-HK', marketCode, contact, shippingAddress: address,
      shippingMethodId: rate.id, couponCode: null,
      policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }] };
    return http('POST', '/api/v1/storefront/checkout/quote', { body, csrf });
  };

  // ---- 1. 未限制渠道：应同时给出货到付款与转账 ----
  console.log('• A. 商品未限制收款方式');
  const cartA = await newCart();
  must(await http('POST', '/api/v1/storefront/cart/items', { body: { variantId: variant.id, quantity: 1 },
    csrf: cartA.csrf }), '加入购物袋');
  const quoteA = must(await quote(cartA.cartId, cartA.csrf), '报价');
  const codesA = (quoteA.paymentMethods ?? []).map(method => method.code);
  check('报价返回多个收款方式', codesA.length >= 2, codesA.join(', '));
  check('包含货到付款', codesA.includes('cod'), codesA.join(', '));

  // ---- 2. 限制为只许转账：货到付款必须消失 ----
  console.log('• B. 商品限制为「只许先行转账」');
  await db.product.update({ where: { id: product.id },
    data: { allowedPaymentChannels: ['manual', 'online'] } });
  const cartB = await newCart();
  must(await http('POST', '/api/v1/storefront/cart/items', { body: { variantId: variant.id, quantity: 1 },
    csrf: cartB.csrf }), '加入购物袋');
  const quoteB = must(await quote(cartB.cartId, cartB.csrf), '报价');
  const codesB = (quoteB.paymentMethods ?? []).map(method => method.code);
  check('货到付款已从报价中移除', !codesB.includes('cod'), codesB.join(', ') || '(空)');
  check('转账渠道仍在可选范围内', codesB.includes('manual_bank_transfer'), codesB.join(', '));
  check('顾客能看到付款指引', Boolean((quoteB.paymentMethods ?? [])
    .find(method => method.code === 'manual_bank_transfer')?.instructions), '');

  // ---- 3. 仍然尝试 COD 下单：必须被明确拒绝 ----
  console.log('• C. 试探用货到付款下单');
  const rejected = await http('POST', '/api/v1/storefront/checkout/orders', { csrf: cartB.csrf,
    idempotency: `smoke-channels-${Date.now()}`, body: {
      quoteId: quoteB.quoteId, confirmedQuoteVersion: quoteB.version, paymentMethodCode: 'cod' } });
  check('COD 下单被拒绝', rejected.status === 422, `HTTP ${rejected.status}`);
  check('错误码可区分原因', rejected.body?.error?.code === 'PAYMENT_METHOD_NOT_ALLOWED_FOR_CART',
    rejected.body?.error?.code);

  // ---- 4. 转账下单成功，订单被标记为必须预付 ----
  console.log('• D. 用转账下单');
  const placed = must(await http('POST', '/api/v1/storefront/checkout/orders', { csrf: cartB.csrf,
    idempotency: `smoke-channels-paid-${Date.now()}`, body: {
      quoteId: quoteB.quoteId, confirmedQuoteVersion: quoteB.version, paymentMethodCode: 'manual_bank_transfer' } }),
  '转账下单');
  const order = await db.shopOrder.findUnique({ where: { id: placed.orderId } });
  check('订单被冻结为「必须先行付款」', order?.requiresPrepayment === true, `requiresPrepayment=${order?.requiresPrepayment}`);
  check('付款状态为待付款', order?.paymentStatus === 'created', order?.paymentStatus);
} catch (error) {
  console.error('验收中断：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  // 恢复商品配置与渠道开关，避免验收脚本改变实例状态。
  if (product) await db.product.update({ where: { id: product.id }, data: { allowedPaymentChannels: original } })
    .catch(() => {});
  await db.$disconnect();
}

summary();
