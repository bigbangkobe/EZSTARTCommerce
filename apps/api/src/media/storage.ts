/**
 * 媒体存储（M02）：把“浏览器直传 + 服务端确认”落到具体存储上。
 *
 * 两种驱动共用同一份服务端语义（短时上传目标、确认时回读摘要）；
 * 差别只在字节落在哪里。本地驱动用 HMAC 签名 URL 保护目录写入，
 * S3 驱动用 SigV4 预签名把写入交给对象存储自身鉴权。
 * 服务端永远不回读客户端声明的摘要，而是自己算一遍再比对。
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { isImportObjectKey, isMediaObjectKey, MAX_MEDIA_BYTES } from '../../../../packages/domain/src/media.js';
import { presign } from './s3-signature.js';

export interface TargetUrl { url: string; method: 'PUT' | 'GET'; headers: Record<string, string>; expiresAt: string }
export interface StoredObject {
  sizeBytes: number;
  sha256: string;
  contentType: string | null;
  /** 头部字节：足够解析图片尺寸，避免为验尺寸再读一次对象。 */
  prefix: Buffer;
}

const PREFIX_BYTES = 64 * 1024;

export interface MediaStorage {
  readonly driver: 'local' | 's3';
  createUploadTarget(key: string, contentType: string, expiresAt: Date): TargetUrl;
  createReadTarget(key: string, expiresAt: Date): TargetUrl;
  stat(key: string): Promise<StoredObject | null>;
  /** 服务端回读字节：导入解析与摘要复核要用，缺对象返回 null，不抛 ENOENT。 */
  read(key: string): Promise<Buffer | null>;
}

export interface LocalStorageConfig { driver: 'local'; root: string; signingKey: Buffer; basePath: string }
export interface S3StorageConfig {
  driver: 's3'; endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string;
  forcePathStyle: boolean;
}
export type MediaStorageConfig = LocalStorageConfig | S3StorageConfig;

function signature(key: Buffer, method: string, objectKey: string, expires: number): string {
  return createHmac('sha256', key).update(`${method}\n${objectKey}\n${expires}`, 'utf8').digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8'); const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 本地目录驱动：开发与单机部署使用，不引入额外基础设施。
 * URL 以 API 相对路径返回，前端用自己已知的 API 基址解析，避免写死对外域名。
 */
export class LocalMediaStorage implements MediaStorage {
  readonly driver = 'local' as const;
  private readonly root: string;
  constructor(private readonly config: LocalStorageConfig) { this.root = resolve(config.root); }

  private path(key: string): string {
    // 导入用的对象键与媒体键共用这套路径校验：两者都只能落在实例自己的存储根内。
    if (!isMediaObjectKey(key) && !isImportObjectKey(key)) throw new Error('Invalid media object key');
    const target = resolve(this.root, key);
    // 双重校验：key 语法已限定字符集，这里再确认解析结果仍在根目录内。
    if (!target.startsWith(this.root + sep)) throw new Error('Invalid media object key');
    return target;
  }

  private target(method: 'PUT' | 'GET', key: string, expires: Date, contentType?: string): TargetUrl {
    const seconds = Math.floor(expires.getTime() / 1000);
    const value = signature(this.config.signingKey, method, key, seconds);
    const query = new URLSearchParams({ key, expires: String(seconds), signature: value });
    return {
      url: `${this.config.basePath}/objects?${query.toString()}`,
      method,
      headers: method === 'PUT' && contentType ? { 'Content-Type': contentType } : {},
      expiresAt: expires.toISOString(),
    };
  }

  createUploadTarget(key: string, contentType: string, expiresAt: Date) { this.path(key); return this.target('PUT', key, expiresAt, contentType); }
  createReadTarget(key: string, expiresAt: Date) { this.path(key); return this.target('GET', key, expiresAt); }

  /** 存储端点自己校验签名：拿到 URL 也不等于可以长期写入。 */
  authorize(method: 'PUT' | 'GET', key: string, expires: string, value: string, now: Date): void {
    if (!isMediaObjectKey(key) || !/^\d{1,12}$/.test(expires) || !/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid signature');
    if (Number(expires) * 1000 <= now.getTime()) throw new Error('Expired signature');
    if (!safeEqual(signature(this.config.signingKey, method, key, Number(expires)), value)) throw new Error('Invalid signature');
  }

  async write(key: string, bytes: Buffer): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    // 先写临时文件再改名：读方不会看到半截对象。
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  }

  async stat(key: string): Promise<StoredObject | null> {
    try {
      const bytes = await readFile(this.path(key));
      return { sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        contentType: null, prefix: bytes.subarray(0, PREFIX_BYTES) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async read(key: string): Promise<Buffer | null> {
    try { return await readFile(this.path(key)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
}

/** S3 兼容驱动：私有桶 + 短时预签名，不使用公开读。 */
export class S3MediaStorage implements MediaStorage {
  readonly driver = 's3' as const;
  constructor(private readonly config: S3StorageConfig) {}

  private url(method: 'GET' | 'PUT', key: string, expiresAt: Date, contentType?: string): TargetUrl {
    const now = new Date();
    const expiresIn = Math.max(1, Math.min(604_800, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)));
    return {
      url: presign({ method, endpoint: this.config.endpoint, bucket: this.config.bucket, key, region: this.config.region,
        accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey, expiresIn, now,
        forcePathStyle: this.config.forcePathStyle }),
      method,
      headers: method === 'PUT' && contentType ? { 'Content-Type': contentType } : {},
      expiresAt: expiresAt.toISOString(),
    };
  }

  createUploadTarget(key: string, contentType: string, expiresAt: Date) { return this.url('PUT', key, expiresAt, contentType); }
  createReadTarget(key: string, expiresAt: Date) { return this.url('GET', key, expiresAt); }

  /**
   * 对象存储没有“本地文件”概念，摘要只能回读对象计算。
   * 单文件上限 10 MiB，一次完整读取换取可验证的摘要，比信任客户端更值得。
   */
  async stat(key: string): Promise<StoredObject | null> {
    const target = this.url('GET', key, new Date(Date.now() + 60_000));
    const response = await fetch(target.url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Media object read failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES) throw new Error('Media object exceeds limit');
    return { sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? null,
      prefix: bytes.subarray(0, PREFIX_BYTES) };
  }

  /** 与 stat 同一条签名 GET 通路；导入用它取回 CSV 字节，上限同样取媒体上限。 */
  async read(key: string): Promise<Buffer | null> {
    const target = this.url('GET', key, new Date(Date.now() + 60_000));
    const response = await fetch(target.url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Media object read failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES) throw new Error('Media object exceeds limit');
    return bytes;
  }
}

export function createMediaStorage(config: MediaStorageConfig): MediaStorage {
  return config.driver === 's3' ? new S3MediaStorage(config) : new LocalMediaStorage(config);
}
