import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertUploadComplete, assertUploadTarget, detectContentType, imageDimensions, isMediaObjectKey, mediaObjectKey, MediaRuleError, MAX_MEDIA_BYTES } from '../packages/domain/src/media.js';
import { presign } from '../apps/api/src/media/s3-signature.js';
const uuid = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
function png(width, height) {
    const bytes = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'ascii');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
}
function jpeg(width, height) {
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function webpVp8x(width, height) {
    const bytes = Buffer.alloc(30);
    bytes.write('RIFF', 0, 'ascii');
    bytes.writeUInt32LE(22, 4);
    bytes.write('WEBP', 8, 'ascii');
    bytes.write('VP8X', 12, 'ascii');
    bytes.writeUInt32LE(10, 16);
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
    return bytes;
}
test('upload target accepts only three image types within the size and name limits', () => {
    const rule = assertUploadTarget({ fileName: ' front.JPG ', contentType: 'image/jpeg', sizeBytes: 2048 });
    assert.deepEqual([rule.contentType, rule.extension, rule.fileName], ['image/jpeg', 'jpg', 'front.JPG']);
    assert.equal(assertUploadTarget({ fileName: 'a.webp', contentType: 'image/webp', sizeBytes: 1 }).extension, 'webp');
    // 无扩展名按 MIME 决定，不因为用户漏写后缀而拒绝。
    assert.equal(assertUploadTarget({ fileName: 'logo', contentType: 'image/png', sizeBytes: 1 }).extension, 'png');
    assert.throws(() => assertUploadTarget({ fileName: 'x.svg', contentType: 'image/svg+xml', sizeBytes: 10 }), MediaRuleError);
    assert.throws(() => assertUploadTarget({ fileName: 'x.gif', contentType: 'image/png', sizeBytes: 10 }), MediaRuleError, '扩展名与 MIME 不同族');
    assert.throws(() => assertUploadTarget({ fileName: '../etc/passwd.png', contentType: 'image/png', sizeBytes: 10 }), MediaRuleError);
    assert.throws(() => assertUploadTarget({ fileName: 'a.png', contentType: 'image/png', sizeBytes: 0 }), MediaRuleError);
    assert.throws(() => assertUploadTarget({ fileName: 'a.png', contentType: 'image/png', sizeBytes: MAX_MEDIA_BYTES + 1 }), MediaRuleError);
    assert.throws(() => assertUploadTarget({ fileName: 'a.png', contentType: 'image/png', sizeBytes: 1.5 }), MediaRuleError);
    assert.throws(() => assertUploadTarget({ fileName: '', contentType: 'image/png', sizeBytes: 1 }), MediaRuleError);
});
test('object keys are server generated and cannot escape the media prefix', () => {
    const key = mediaObjectKey(new Date('2026-11-16T10:00:00.000Z'), uuid, 'png');
    assert.equal(key, 'media/2026/11/7c9e6679-7425-40de-944b-e07fc1f90ae7.png');
    assert.ok(isMediaObjectKey(key));
    assert.ok(!isMediaObjectKey('media/2026/11/../../secret.png'));
    assert.ok(!isMediaObjectKey('media/2026/11/7c9e6679-7425-40de-944b-e07fc1f90ae7.svg'));
    assert.throws(() => mediaObjectKey(new Date(), 'not-a-uuid', 'png'), MediaRuleError);
    assert.throws(() => mediaObjectKey(new Date(), uuid, 'exe'), MediaRuleError);
});
test('image headers are parsed instead of trusting the declared MIME', () => {
    assert.deepEqual(imageDimensions(png(800, 600)), { width: 800, height: 600 });
    assert.deepEqual(imageDimensions(jpeg(1024, 768)), { width: 1024, height: 768 });
    assert.deepEqual(imageDimensions(webpVp8x(320, 240)), { width: 320, height: 240 });
    assert.equal(detectContentType(png(1, 1)), 'image/png');
    assert.equal(detectContentType(jpeg(1, 1)), 'image/jpeg');
    assert.equal(detectContentType(webpVp8x(1, 1)), 'image/webp');
    assert.throws(() => imageDimensions(Buffer.from('<svg onload="alert(1)"></svg>')), MediaRuleError);
    assert.throws(() => detectContentType(Buffer.from('GIF89a')), MediaRuleError);
    // 画布过大按解压炸弹处理，不进入存储。
    assert.throws(() => imageDimensions(png(12_001, 10)), MediaRuleError);
    assert.throws(() => imageDimensions(png(12_000, 12_000)), MediaRuleError);
    assert.throws(() => imageDimensions(Buffer.alloc(0)), MediaRuleError);
});
test('completion compares size and digest, never accepting client-declared values', () => {
    const digest = 'a'.repeat(64);
    assert.doesNotThrow(() => assertUploadComplete({ sizeBytes: 10, sha256: digest }, { sizeBytes: 10, sha256: digest }));
    assert.doesNotThrow(() => assertUploadComplete({ sizeBytes: 10, sha256: digest.toUpperCase() }, { sizeBytes: 10, sha256: digest }), '摘要大小写不应影响比对');
    assert.throws(() => assertUploadComplete({ sizeBytes: 10, sha256: digest }, null), MediaRuleError, '对象不存在');
    assert.throws(() => assertUploadComplete({ sizeBytes: 11, sha256: digest }, { sizeBytes: 10, sha256: digest }), MediaRuleError, '大小不符');
    assert.throws(() => assertUploadComplete({ sizeBytes: 10, sha256: digest }, { sizeBytes: 10, sha256: 'b'.repeat(64) }), MediaRuleError, '摘要不符');
    assert.throws(() => assertUploadComplete({ sizeBytes: 10, sha256: 'short' }, { sizeBytes: 10, sha256: 'short' }), MediaRuleError);
});
test('SigV4 presigning matches the published AWS example', () => {
    const url = presign({ method: 'GET', endpoint: 'https://s3.amazonaws.com', bucket: 'examplebucket', key: 'test.txt',
        region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        expiresIn: 86400, now: new Date('2013-05-24T00:00:00.000Z') });
    assert.equal(url, 'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z' +
        '&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});
