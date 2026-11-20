/**
 * 密钥解析器。
 *
 * 业务层只认 `secret://<scheme>/<name>`，真实值在这里被取出、短时缓存、用完即弃。
 * 四条规则：
 * 1. 解析失败必须抛错，**绝不返回空对象**——静默空凭据会变成"线上下单永远失败"。
 * 2. 生产禁止 env / file 两种形态：前者 `docker inspect` 可见，后者会进备份包。
 * 3. 缓存有 TTL（默认 5 分钟），既能减少 Secrets Manager 调用，又能让轮换生效。
 * 4. 错误信息不带密钥值、不带完整响应体，只带 code。
 */
import { readFile } from 'node:fs/promises';
import {
  assertSecretSchemeAllowed, type SecretScheme, type SecretTarget, secretRefTarget,
} from '../../../../../packages/domain/src/payment-adapter.js';

export class SecretResolverError extends Error {
  constructor(readonly code: string, readonly field?: string) {
    super(field ? `${code}:${field}` : code);
    this.name = 'SecretResolverError';
  }
}

function fail(code: string, field?: string): never {
  throw new SecretResolverError(code, field);
}

export interface SecretResolver {
  resolve(ref: string): Promise<Readonly<Record<string, string>>>;
  /** 轮换后立刻生效，不必等 TTL。 */
  invalidate(ref?: string): void;
}

export interface SecretResolverOptions {
  readonly environment: 'sandbox' | 'production';
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** 测试注入点：默认读 process.env。 */
  readonly readEnv?: (name: string) => string | undefined;
  /** 测试注入点：默认读本地文件。 */
  readonly readFile?: (path: string) => Promise<string>;
}

interface CacheEntry {
  readonly value: Readonly<Record<string, string>>;
  readonly expiresAt: number;
}

const MAX_ENTRIES = 64;
const MAX_VALUE_LENGTH = 8_192;

/** 密钥值必须是扁平 JSON 对象：`{"apiKey":"...","webhookSecret":"..."}`。 */
function parseSecretPayload(raw: string, ref: string): Record<string, string> {
  if (raw.length > MAX_VALUE_LENGTH) fail('SECRET_VALUE_TOO_LARGE', ref);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('SECRET_VALUE_NOT_JSON', ref);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('SECRET_VALUE_NOT_OBJECT', ref);
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') fail('SECRET_VALUE_NOT_STRING', `${ref}.${key}`);
    if (value.length > MAX_VALUE_LENGTH) fail('SECRET_VALUE_TOO_LARGE', `${ref}.${key}`);
    output[key] = value;
  }
  if (!Object.keys(output).length) fail('SECRET_VALUE_EMPTY', ref);
  return output;
}

/**
 * AWS SDK 是可选依赖：未安装时给出明确错误，而不是让进程在启动时崩掉。
 * 用变量名动态导入，避免 TypeScript 在没装 SDK 的机器上直接编译失败。
 */
async function loadAwsModule(): Promise<{
  SecretsManagerClient: new (config: Record<string, unknown>) => { send: (command: unknown) => Promise<unknown> };
  GetSecretValueCommand: new (input: Record<string, unknown>) => unknown;
}> {
  const moduleName = '@aws-sdk/client-secrets-manager';
  try {
    return await import(moduleName) as never;
  } catch {
    fail('SECRET_PROVIDER_UNAVAILABLE', moduleName);
  }
}

export function createSecretResolver(options: SecretResolverOptions): SecretResolver {
  const ttlMs = options.ttlMs ?? 300_000;
  const now = options.now ?? (() => Date.now());
  const readEnv = options.readEnv ?? ((name: string) => process.env[name]);
  const readFileImpl = options.readFile ?? ((path: string) => readFile(path, 'utf8'));
  const cache = new Map<string, CacheEntry>();

  async function fetchSecret(target: SecretTarget): Promise<Record<string, string>> {
    assertSecretSchemeAllowed(target.scheme, options.environment);
    switch (target.scheme as SecretScheme) {
      case 'env': {
        const value = readEnv(target.name);
        if (value === undefined || value === '') fail('SECRET_NOT_FOUND', target.name);
        return parseSecretPayload(value, target.name);
      }
      case 'file': {
        try {
          return parseSecretPayload(await readFileImpl(target.name), target.name);
        } catch (error) {
          if (error instanceof SecretResolverError) throw error;
          fail('SECRET_NOT_FOUND', target.name);
        }
      }
      case 'aws-sm': {
        const aws = await loadAwsModule();
        const client = new aws.SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-northeast-1' });
        let response: unknown;
        try {
          response = await client.send(new aws.GetSecretValueCommand({ SecretId: target.name }));
        } catch {
          // 不打原始错误：AWS 的报错里可能带回请求上下文。
          fail('SECRET_FETCH_FAILED', target.name);
        }
        const secretString = (response as { SecretString?: string }).SecretString;
        if (typeof secretString !== 'string' || !secretString.length) fail('SECRET_NOT_FOUND', target.name);
        return parseSecretPayload(secretString, target.name);
      }
      case 'ssm': {
        const moduleName = '@aws-sdk/client-ssm';
        let ssm: { SSMClient: new (c: Record<string, unknown>) => { send: (cmd: unknown) => Promise<unknown> }; GetParameterCommand: new (i: Record<string, unknown>) => unknown };
        try {
          ssm = await import(moduleName) as never;
        } catch {
          fail('SECRET_PROVIDER_UNAVAILABLE', moduleName);
        }
        const client = new ssm.SSMClient({ region: process.env.AWS_REGION ?? 'ap-northeast-1' });
        let response: unknown;
        try {
          response = await client.send(new ssm.GetParameterCommand({ Name: target.name, WithDecryption: true }));
        } catch {
          fail('SECRET_FETCH_FAILED', target.name);
        }
        const value = (response as { Parameter?: { Value?: string } }).Parameter?.Value;
        if (typeof value !== 'string' || !value.length) fail('SECRET_NOT_FOUND', target.name);
        return parseSecretPayload(value, target.name);
      }
      default:
        fail('SECRET_REFERENCE_INVALID', target.scheme);
    }
  }

  return {
    async resolve(ref: string) {
      const target = secretRefTarget(ref);
      const key = `${target.scheme}/${target.name}`;
      const cached = cache.get(key);
      const stamp = now();
      if (cached && cached.expiresAt > stamp) return cached.value;

      const value = await fetchSecret(target);
      if (cache.size >= MAX_ENTRIES) {
        // 简单淘汰：删最早插入的一条，够用且不引入 LRU 依赖。
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { value, expiresAt: stamp + ttlMs });
      return value;
    },
    invalidate(ref?: string) {
      if (ref === undefined) {
        cache.clear();
        return;
      }
      const target = secretRefTarget(ref);
      cache.delete(`${target.scheme}/${target.name}`);
    },
  };
}
