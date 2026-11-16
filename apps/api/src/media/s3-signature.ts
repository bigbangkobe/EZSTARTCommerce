/**
 * S3 兼容对象存储的 SigV4 预签名 URL（查询参数签名，无 SDK 依赖）。
 *
 * 只用 `UNSIGNED-PAYLOAD`：浏览器直传的字节由对象存储自己校验长度与 MIME，
 * 我们随后再用 `stat` 取回实际摘要做二次核对，因此不需要在签名时预知内容散列。
 * 这里的实现按 AWS 文档的签名步骤逐项展开，便于用官方测试向量验证。
 */

import { createHash, createHmac } from 'node:crypto';

export interface PresignInput {
  method: 'GET' | 'PUT';
  /** 形如 `https://s3.example.com`，可带路径前缀。 */
  endpoint: string;
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresIn: number;
  now: Date;
  /** 虚拟主机式访问（默认）或路径式访问；本地 MinIO 通常用路径式。 */
  forcePathStyle?: boolean;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest();

/** RFC 3986 编码：S3 的规范请求要求保留 `-_.~`，其余一律百分号编码。 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 对象 key 逐段编码：`/` 是分隔符，不能整体编码成一个段。 */
function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

export function presign(input: PresignInput): string {
  const timestamp = `${input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const endpoint = new URL(input.endpoint);
  const host = input.forcePathStyle ? endpoint.host : `${input.bucket}.${endpoint.host}`;
  const basePath = endpoint.pathname.replace(/\/$/, '');
  const path = input.forcePathStyle ? `${basePath}/${input.bucket}/${encodeKeyPath(input.key)}`
    : `${basePath}/${encodeKeyPath(input.key)}`;

  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', timestamp],
    ['X-Amz-Expires', String(input.expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = query.map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0).join('&');
  const canonicalRequest = [input.method, path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  return `${endpoint.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
