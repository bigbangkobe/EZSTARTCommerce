// 后台 API 的最小客户端：登录（含 TOTP 回退）、带 Origin/CSRF 的请求、429 自动续跑。
// import-products.mjs 里有一份内联实现（那个脚本在生产跑着，不动它）；
// 新的运维脚本统一用这个模块，避免各写一遍登录与限流逻辑。
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

export function totpCode(secret, stepOffset = 0) {
  const counter = Math.floor(Date.now() / 30000) + stepOffset;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

export function describe(result) {
  const error = result?.body?.error;
  if (!error) return `HTTP ${result?.status}`;
  const fields = error.fieldErrors?.length ? ` ${JSON.stringify(error.fieldErrors)}` : '';
  return `HTTP ${result.status} ${error.code ?? ''} ${error.message ?? ''}${fields}`.trim();
}

/**
 * 创建客户端。creds 可以是 {email,password,totpSecret?}，也可以是已登录的会话（{sessionToken,csrfToken}）。
 * 写接口必须带 Origin=APP_ORIGIN，否则服务端直接 403。
 */
export async function createClient({ api, origin, creds, credsPath, retryWait = 905, maxRetries = 40, log = console.log, warn = console.warn }) {
  const jar = new Map();
  let csrf = null;

  async function call(method, path, { body, idempotency, cookies = true, retries } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers.origin = origin;
    if (csrf) headers['x-csrf-token'] = csrf;
    if (idempotency) headers['idempotency-key'] = idempotency;
    if (cookies && jar.size) headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');

    const request = () => fetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let response = await request();
    const budget = retries ?? maxRetries;
    for (let attempt = 0; response.status === 429 && method !== 'GET' && attempt < budget; attempt += 1) {
      warn(`写接口被限流（429），等待 ${retryWait}s 后继续（第 ${attempt + 1}/${budget} 次）`);
      await sleep((retryWait + 3) * 1000);
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

  let resolved = creds;
  if (!resolved && credsPath) {
    try { resolved = JSON.parse(await readFile(credsPath, 'utf8')); }
    catch { throw new Error(`读不到凭据 ${credsPath}`); }
  }
  if (!resolved) throw new Error('缺少凭据（creds 或 credsPath）');

  // 已登录会话直接复用；否则走账号密码（有 factor 且开了强制 MFA 时才需要 TOTP）
  if (resolved.sessionToken) {
    jar.set('ez_admin_session', resolved.sessionToken);
    csrf = resolved.csrfToken;
  } else {
    let session = null;
    for (let round = 0; round < 3 && !session; round += 1) {
      const result = await call('POST', '/api/v1/admin/auth/login', { body: { email: resolved.email, password: resolved.password }, cookies: false });
      if (result.status === 200) { session = result.body.data; break; }
      if (result.status !== 202) throw new Error(`登录失败：${describe(result)}`);
      if (!resolved.totpSecret) throw new Error('账号需要 MFA，但凭据里没有 totpSecret');
      const challengeId = result.body.data.challengeId;
      for (const offset of [0, 1, 2]) {
        const verify = await call('POST', '/api/v1/admin/auth/mfa/verify', { body: { challengeId, code: totpCode(resolved.totpSecret, offset) } });
        if (verify.status === 200) { session = verify.body.data; break; }
      }
      if (!session) await sleep(1200);
    }
    if (!session) throw new Error('MFA 连续失败：确认 totpSecret 仍有效');
    csrf = session.csrfToken;
  }

  return {
    call,
    get: path => call('GET', path),
    post: (path, body, options = {}) => call('POST', path, { body, ...options }),
    patch: (path, body, options = {}) => call('PATCH', path, { body, ...options }),
    session: null,
    describe,
  };
}
