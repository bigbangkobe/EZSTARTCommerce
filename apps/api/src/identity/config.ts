export interface IdentityConfig {
  instanceId: string;
  /**
   * 后台的规范浏览器来源。邀请/重设链接与写入来源校验都以它为准。
   * 配置了 ADMIN_ORIGIN 时取后台域名，否则与前台同源（本地与测试环境）。
   */
  allowedOrigin: string;
  /** 前台来源：购物车/结账/会员这些前台写接口的来源校验也放行它。 */
  storefrontOrigin?: string;
  encryptionKey: Buffer;
  bootstrapToken?: string;
  /**
   * 后台是否强制二次验证。默认 true：店主/管理员角色无条件要 MFA。
   * 仅当实例明确设 `ADMIN_REQUIRE_MFA=false` 时关闭 —— 私有部署的店主可能只要
   * 「账号 + 密码」，此时按 AdminUser.mfaRequired 字段为准，不再按角色强制。
   * 省略视为开启：测试与旧调用方不需要改动。
   */
  requireMfa?: boolean;
  /**
   * 可信反向代理层数，默认 0。
   *
   * 0 = 只认直连对端地址，`X-Forwarded-For` 一律不信（安全默认）。
   * 生产经 Caddy/ALB 反代时必须显式配 1：否则 API 看到的 remoteAddress 永远是代理容器 IP，
   * 全站访客共用一个限流桶——每 15 分钟 60 次写操作很快被用完，之后所有人的加购、
   * 改数量、会员登录码请求一起 429（ID 限流规则见 IDENTITY_SECURITY_POLICY）。
   */
  trustedProxyHops?: number;
}

/** 生产只接受 HTTPS；开发允许 localhost 的 HTTP，形式必须与配置值完全一致（不带路径）。 */
function canonicalOrigin(value: string | undefined, env: NodeJS.ProcessEnv, name: string): string {
  if (!value) throw new Error('Identity configuration is incomplete');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${name}`); }
  if (url.origin !== value) throw new Error(`Invalid ${name}`);
  // 本地开发允许 localhost（含 admin.localhost 这类子域）：生产仍然只接受 HTTPS。
  const localHttp = env['NODE_ENV'] !== 'production' && url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !localHttp) throw new Error(`Invalid ${name}`);
  return value;
}

export function identityConfig(env: NodeJS.ProcessEnv): IdentityConfig {
  const instanceId = env['INSTANCE_ID'];
  const key = env['IDENTITY_ENCRYPTION_KEY'];
  if (!instanceId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(instanceId) || !key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    throw new Error('Identity configuration is incomplete');
  }
  const storefront = canonicalOrigin(env['APP_ORIGIN'], env, 'APP_ORIGIN');
  // 后台与前台分属两个域名时，写接口必须同时接受这两个来源：后台页面由 admin 域名提供，
  // 只认前台域名会让登录与所有后台保存得到 403（生产事故）。链接一律使用后台域名。
  const admin = env['ADMIN_ORIGIN'] ? canonicalOrigin(env['ADMIN_ORIGIN'], env, 'ADMIN_ORIGIN') : null;
  const encryptionKey = Buffer.from(key, 'base64');
  if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== key) throw new Error('Identity encryption key must be canonical base64 for 32 bytes');
  const bootstrapToken = env['BOOTSTRAP_TOKEN'];
  if (bootstrapToken && (bootstrapToken.length < 32 || bootstrapToken.length > 512)) throw new Error('Invalid bootstrap token');
  // 默认开启；只有显式写成 false 才关闭，避免拼错变量名把二次验证静默关掉。
  const requireMfa = env['ADMIN_REQUIRE_MFA'] !== 'false';
  // 可信代理层数：留空 = 0（只认直连对端）。上限 5 是防御性约束，配错不该静默放大到任意跳数。
  const hopsRaw = (env['TRUSTED_PROXY_HOPS'] ?? '').trim();
  const trustedProxyHops = hopsRaw === '' ? 0 : Number(hopsRaw);
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 5) throw new Error('Invalid TRUSTED_PROXY_HOPS');
  return { instanceId, allowedOrigin: admin ?? storefront, storefrontOrigin: storefront, encryptionKey, requireMfa, trustedProxyHops,
    ...(bootstrapToken ? { bootstrapToken } : {}) };
}

/** 只接受 IP 字面量：转发头是客户端可写字段，任何别的形状都不能当限流键。 */
function isIpLiteral(value: string): boolean {
  if (value.includes(':')) return /^[0-9a-fA-F:]{2,45}$/.test(value) && !value.includes(':::'); // IPv6（含 IPv4 映射写法）
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * 请求来源地址：限流与审计共用的身份维度。
 *
 * `hops = 0` 时只认直连对端地址——转发头可以被客户端随意伪造，默认永远不信。
 * 配了可信代理层数后取转发链「从右往左第 hops 段」：最外层可信代理追加在最后，
 * 所以 hops=1 就取最后一段，正好是 Caddy 看到的真实访客地址。
 */
export function clientIp(request: { socket: { remoteAddress?: string | null | undefined };
  headers: Record<string, string | string[] | undefined> }, hops = 0): string {
  const direct = request.socket.remoteAddress ?? 'unknown';
  if (hops <= 0) return direct;
  const raw = request.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof header !== 'string' || !header.trim()) return direct;
  const chain = header.split(',').map(part => part.trim()).filter(Boolean);
  const candidate = chain[chain.length - hops];
  return candidate && isIpLiteral(candidate) ? candidate : direct;
}

/**
 * 写入来源校验：只接受已知的自家来源，缺失 Origin 一律拒绝。
 * 这不是 CORS —— 跨站表单会带上受害者站点的 Origin，按名单拒绝才是 CSRF 的第一道闸。
 */
export function originAllowed(config: Pick<IdentityConfig, 'allowedOrigin' | 'storefrontOrigin'>,
  origin: string | undefined): boolean {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  if (origin === config.allowedOrigin) return true;
  return config.storefrontOrigin !== undefined && origin === config.storefrontOrigin;
}
