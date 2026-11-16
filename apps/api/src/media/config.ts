/**
 * 媒体配置：默认走本地目录（开发与单机部署），显式配置 S3 兼容存储时切换驱动。
 *
 * 上传签名密钥从实例加密密钥派生，不额外引入必须轮换的秘密；
 * 轮换实例密钥即同时作废旧上传链接，这与“短时目标”的语义一致。
 */

import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import type { MediaStorageConfig } from './storage.js';

export const MEDIA_BASE_PATH = '/api/v1/media';

export function mediaStorageConfig(env: NodeJS.ProcessEnv, secret: Buffer): MediaStorageConfig {
  const driver = env['MEDIA_DRIVER'] ?? (env['S3_BUCKET'] ? 's3' : 'local');
  if (driver === 's3') {
    const endpoint = env['S3_ENDPOINT'];
    const bucket = env['S3_BUCKET'];
    const accessKeyId = env['S3_ACCESS_KEY_ID'];
    const secretAccessKey = env['S3_SECRET_ACCESS_KEY'];
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('S3 media configuration is incomplete');
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !(env['NODE_ENV'] !== 'production' && url.protocol === 'http:')) {
      throw new Error('S3 endpoint must use TLS outside development');
    }
    return { driver: 's3', endpoint: url.origin + url.pathname.replace(/\/$/, ''), bucket, region: env['S3_REGION'] ?? 'us-east-1',
      accessKeyId, secretAccessKey, forcePathStyle: env['S3_FORCE_PATH_STYLE'] !== 'false' };
  }
  if (driver !== 'local') throw new Error('Unsupported MEDIA_DRIVER');
  return { driver: 'local', root: resolve(env['MEDIA_LOCAL_ROOT'] ?? '.data/media'), basePath: MEDIA_BASE_PATH,
    signingKey: createHmac('sha256', secret).update('ezstart.media.upload.v1', 'utf8').digest() };
}
