import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 购物袋客户端的浏览器语义回归。
 *
 * 为什么需要这一层：`document.cookie` 只返回「cookie-path 是当前文档路径前缀」的 cookie
 * （RFC 6265 5.1.4）。购物袋的 CSRF 令牌若被种在 `/api/v1`，商品页（`/zh-HK/products/...`）
 * 上的脚本就读不到它，加购会在发请求**之前**就判失败——而这个失败在后端 HTTP 测试里
 * 看不见（测试手拼 Cookie 头），在浏览器 E2E 里也看不见（路由被 mock）。
 *
 * 这里用最小实现复刻浏览器的 cookie 可见性与 Set-Cookie 处理，直接驱动真实的
 * `lib/cart-client.ts`，把「页面上能不能拿到令牌」钉成断言。
 */

type Outcome<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; status: number; code?: string; message?: string };

type CartModule = {
  addToCart(variantId: string, quantity: number, attribution?: unknown): Promise<Outcome<{ itemCount: number }>>;
  updateCartItem(itemId: string, quantity: number): Promise<Outcome<unknown>>;
  removeCartItem(itemId: string): Promise<Outcome<null>>;
};

/** 前台源码不在根 tsconfig 的编译范围（由 Next 自己构建），运行时按 .ts 直接载入。 */
const loadCart = async (): Promise<CartModule> =>
  import(pathToFileURL(resolve('apps/storefront-mrinhk/lib/cart-client.ts')).href) as Promise<CartModule>;

type StoredCookie = { name: string; value: string; path: string };

/** RFC 6265 5.1.4 的 path-match：cookie 要被当前文档路径「覆盖」才可见。 */
function pathMatches(cookiePath: string, documentPath: string): boolean {
  if (cookiePath === documentPath) return true;
  if (!documentPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || documentPath.charAt(cookiePath.length) === '/';
}

type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };

type Responder = (call: Call, jar: StoredCookie[]) => { status: number; body?: unknown; cookies?: string[] } | null;

/** 装上假的 document 与 fetch：cookie 可见性、Set-Cookie 落库都按浏览器规则来。 */
function installBrowser(jar: StoredCookie[], documentPath: string, responder: Responder) {
  const calls: Call[] = [];

  const documentShim = {
    get cookie() {
      return jar.filter(cookie => pathMatches(cookie.path, documentPath))
        .map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    },
    // 客户端只读不写（令牌由服务端种下）；真要写时在这里补实现即可。
    set cookie(_value: string) { /* no-op */ },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentShim });

  const fetchShim = async (input: string | URL | Request, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: Call = { method, path, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const result = responder(call, jar) ?? { status: 404, body: { error: { code: 'NOT_FOUND' } } };
    // 服务端下发的 cookie 按「名字 + path」唯一：同名不同 path 是两条独立的 cookie。
    for (const raw of result.cookies ?? []) {
      const [pair = '', ...attributes] = raw.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index); const value = pair.slice(index + 1);
      const pathAttribute = attributes.map(part => part.trim())
        .find(part => part.toLowerCase().startsWith('path='))?.slice('path='.length) ?? '/';
      const maxAge = attributes.map(part => part.trim())
        .find(part => part.toLowerCase().startsWith('max-age='))?.slice('max-age='.length);
      for (let position = jar.length - 1; position >= 0; position -= 1) {
        if (jar[position]!.name === name && jar[position]!.path === pathAttribute) jar.splice(position, 1);
      }
      if (maxAge !== '0' && value) jar.push({ name, value, path: pathAttribute });
    }
    const text = result.body === undefined ? '' : JSON.stringify(result.body);
    return { ok: result.status < 400, status: result.status, text: async () => text };
  };
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchShim });

  return { calls };
}

function uninstallBrowser() {
  Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'fetch');
}

const cartView = (itemCount = 0) => ({ data: { cartId: 'cart-1', currency: 'HKD', locale: 'zh-HK', itemCount,
  subtotalMinor: itemCount * 47_000, items: [], warnings: [], expiresAt: '2026-12-31T00:00:00.000Z' },
  meta: { requestId: 'req-test' } });

/** 服务端真正下发的三个 Set-Cookie：csrf 在 /，购物袋令牌在 /api/v1，并清掉旧作用域的同名 csrf。 */
const cartCreationCookies = () => [
  'ez_guest_cart=guest-token-43-characters-abcdefghijk; Max-Age=2592000; Path=/api/v1; Secure; SameSite=Lax',
  'ez_cart_csrf=csrf-token-43-characters-abcdefghijklm; Max-Age=2592000; Path=/; Secure; SameSite=Lax',
  'ez_cart_csrf=; Max-Age=0; Path=/api/v1; Secure; SameSite=Lax',
];

test('storefront cart: the CSRF token is readable from a product page and the add request is really sent', async t => {
  t.after(uninstallBrowser);
  const jar: StoredCookie[] = [];
  const { calls } = installBrowser(jar, '/zh-HK/products/mev-1247', (call, store) => {
    const hasCart = store.some(cookie => cookie.name === 'ez_guest_cart');
    if (call.method === 'GET' && call.path === '/api/v1/storefront/cart') {
      return hasCart ? { status: 200, body: cartView(0) } : { status: 401, body: { error: { code: 'UNAUTHORIZED' } } };
    }
    if (call.method === 'POST' && call.path === '/api/v1/storefront/cart') {
      return { status: 201, body: cartView(0), cookies: cartCreationCookies() };
    }
    if (call.method === 'POST' && call.path === '/api/v1/storefront/cart/items') {
      // 服务端要求 cookie 里的令牌与请求头一致；这里等价于 assertCsrf。
      const expected = store.find(cookie => cookie.name === 'ez_cart_csrf' && cookie.path === '/')?.value;
      if (!expected || call.headers['x-csrf-token'] !== expected) {
        return { status: 403, body: { error: { code: 'FORBIDDEN' } } };
      }
      return { status: 200, body: cartView(1) };
    }
    return null;
  });

  const cart = await loadCart();
  const result = await cart.addToCart('variant-1', 2);

  assert.equal(result.ok, true, '加购必须成功，否则就是页面读不到令牌');
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [
    'GET /api/v1/storefront/cart',
    'POST /api/v1/storefront/cart',
    'POST /api/v1/storefront/cart/items',
  ]);
  const add = calls[2]!;
  assert.equal(add.headers['x-csrf-token'], 'csrf-token-43-characters-abcdefghijklm');
  assert.deepEqual(add.body, { variantId: 'variant-1', quantity: 2 });
  // 令牌种在 / 上，所以这条页面路径能读到它——这正是修复前读不到的那一步。
  assert.match((globalThis as { document: { cookie: string } }).document.cookie, /ez_cart_csrf=csrf-token/);
});

test('storefront cart: a legacy /api/v1-scoped token is replaced by creating the cart again', async t => {
  t.after(uninstallBrowser);
  // 旧部署留下的两个 cookie：都在 /api/v1，页面脚本读不到 csrf。
  const jar: StoredCookie[] = [
    { name: 'ez_guest_cart', value: 'legacy-guest-token', path: '/api/v1' },
    { name: 'ez_cart_csrf', value: 'legacy-csrf-token', path: '/api/v1' },
  ];
  const { calls } = installBrowser(jar, '/zh-HK/products/mev-1247', (call, store) => {
    const hasCart = store.some(cookie => cookie.name === 'ez_guest_cart');
    if (call.method === 'GET' && call.path === '/api/v1/storefront/cart') {
      return hasCart ? { status: 200, body: cartView(0) } : { status: 401, body: { error: { code: 'UNAUTHORIZED' } } };
    }
    if (call.method === 'POST' && call.path === '/api/v1/storefront/cart') {
      return { status: 201, body: cartView(0), cookies: cartCreationCookies() };
    }
    if (call.method === 'POST' && call.path === '/api/v1/storefront/cart/items') {
      const expected = store.find(cookie => cookie.name === 'ez_cart_csrf' && cookie.path === '/')?.value;
      return expected && call.headers['x-csrf-token'] === expected
        ? { status: 200, body: cartView(1) }
        : { status: 403, body: { error: { code: 'FORBIDDEN' } } };
    }
    return null;
  });

  const cart = await loadCart();
  const result = await cart.addToCart('variant-1', 1);

  assert.equal(result.ok, true);
  // 没有可读令牌时必须重建一次购物袋，而不是直接报「加购失败」。
  assert.ok(calls.some(call => call.method === 'POST' && call.path === '/api/v1/storefront/cart'));
  assert.ok(calls.some(call => call.method === 'POST' && call.path === '/api/v1/storefront/cart/items'));
  assert.equal(jar.filter(cookie => cookie.name === 'ez_cart_csrf').length, 1, '旧作用域的同名 cookie 要被清掉');
});

test('storefront cart: without a readable CSRF token the client reports NO_CSRF instead of firing a doomed write', async t => {
  t.after(uninstallBrowser);
  const jar: StoredCookie[] = [];
  const { calls } = installBrowser(jar, '/zh-HK/products/mev-1247', call => {
    if (call.method === 'GET' && call.path === '/api/v1/storefront/cart') {
      return { status: 401, body: { error: { code: 'UNAUTHORIZED' } } };
    }
    if (call.method === 'POST' && call.path === '/api/v1/storefront/cart') {
      // 建袋成功，但服务端没有下发可读的 CSRF 令牌：这是一条真实的坏配置，
      // 客户端必须当场判失败，而不是发一个注定 403 的写请求。
      return { status: 201, body: cartView(0),
        cookies: ['ez_guest_cart=guest-token-43-characters-abcdefghijk; Max-Age=2592000; Path=/api/v1; Secure; SameSite=Lax'] };
    }
    return null;
  });

  const cart = await loadCart();
  const result = await cart.addToCart('variant-1', 1);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'NO_CSRF');
  assert.equal(calls.filter(call => call.path.endsWith('/cart/items')).length, 0);
});
