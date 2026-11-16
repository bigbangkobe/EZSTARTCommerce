export interface IdentityConfig {
  instanceId: string;
  allowedOrigin: string;
  encryptionKey: Buffer;
  bootstrapToken?: string;
}

export function identityConfig(env: NodeJS.ProcessEnv): IdentityConfig {
  const instanceId = env['INSTANCE_ID'];
  const origin = env['APP_ORIGIN'];
  const key = env['IDENTITY_ENCRYPTION_KEY'];
  if (!instanceId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(instanceId) || !origin || !key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    throw new Error('Identity configuration is incomplete');
  }
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== 'https:' && !(env['NODE_ENV'] !== 'production' &&
    url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Invalid APP_ORIGIN');
  const encryptionKey = Buffer.from(key, 'base64');
  if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== key) throw new Error('Identity encryption key must be canonical base64 for 32 bytes');
  const bootstrapToken = env['BOOTSTRAP_TOKEN'];
  if (bootstrapToken && (bootstrapToken.length < 32 || bootstrapToken.length > 512)) throw new Error('Invalid bootstrap token');
  return { instanceId, allowedOrigin: origin, encryptionKey, ...(bootstrapToken ? { bootstrapToken } : {}) };
}
