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
  return { instanceId, allowedOrigin: admin ?? storefront, storefrontOrigin: storefront, encryptionKey,
    ...(bootstrapToken ? { bootstrapToken } : {}) };
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
