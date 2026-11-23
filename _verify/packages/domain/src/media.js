/**
 * 媒体（M02）纯规则层：上传申请校验、对象 key 生成、图片头解析与摘要核对。
 *
 * 只接受三种图片格式，且必须由文件头确认尺寸——不信任客户端声明的 MIME，
 * 但也不解码像素：解析格式头即可拦下非图片、伪装扩展名与超大画布。
 * 对象 key 由服务端生成，文件名只作为展示元数据，永远不参与路径拼接。
 */
export class MediaRuleError extends Error {
    field;
    constructor(field) {
        super(field);
        this.field = field;
    }
}
function fail(field) { throw new MediaRuleError(field); }
export const MEDIA_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** 与契约 `MediaUploadTargetRequest.sizeBytes.maximum` 保持一致。 */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
/** 上传目标只在短时间内可用：拿到 URL 不等于获得长期写权限。 */
export const MEDIA_UPLOAD_TTL_SECONDS = 900;
export const MAX_MEDIA_EDGE = 12_000;
export const MAX_MEDIA_PIXELS = 80_000_000;
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const EXTENSION_FAMILY = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
function fileNameFor(value) {
    const name = value.trim();
    if (name.length < 1 || name.length > 255)
        fail('fileName');
    // 控制字符与路径分隔符一律拒绝：文件名不是路径，也不能用来伪造日志行。
    if (/[\u0000-\u001f\u007f/\\]/.test(name))
        fail('fileName');
    return name;
}
/** 扩展名与 MIME 必须同族；无扩展名时按 MIME 决定，不因缺扩展名而拒绝。 */
function extensionFor(contentType, fileName) {
    const match = /\.([A-Za-z0-9]{1,5})$/.exec(fileName);
    if (!match)
        return EXTENSIONS[contentType];
    const declared = EXTENSION_FAMILY[match[1].toLowerCase()];
    if (declared !== contentType)
        fail('fileName');
    return EXTENSIONS[contentType];
}
export function assertUploadTarget(input) {
    const fileName = fileNameFor(input.fileName);
    if (!MEDIA_CONTENT_TYPES.includes(input.contentType))
        fail('contentType');
    const contentType = input.contentType;
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_MEDIA_BYTES)
        fail('sizeBytes');
    return { contentType, sizeBytes: input.sizeBytes, extension: extensionFor(contentType, fileName), fileName };
}
/** 对象 key 只由服务端时间与随机 UUID 组成，避免用户输入进入存储路径。 */
export function mediaObjectKey(now, id, extension) {
    if (!UUID.test(id))
        fail('objectKey');
    if (!/^(jpg|png|webp)$/.test(extension))
        fail('objectKey');
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `media/${year}/${month}/${id.toLowerCase()}.${extension}`;
}
export function isMediaObjectKey(value) {
    return /^media\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/.test(value);
}
/**
 * 导入文件的对象键（M05）：与媒体共用一套签名上传通道，但前缀与扩展名独立，
 * 避免 CSV 混进媒体库、也避免媒体确认流程把导入文件当成「未确认图片」。
 */
export function isImportObjectKey(value) {
    return /^imports\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$/.test(value);
}
function uint16be(bytes, offset) { return (bytes[offset] << 8) | bytes[offset + 1]; }
function uint32be(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
function uint16le(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }
function uint32le(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
function pngSize(bytes) {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value))
        return null;
    if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR')
        return null;
    return { width: uint32be(bytes, 16), height: uint32be(bytes, 20) };
}
function jpegSize(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
        return null;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff)
            return null;
        const marker = bytes[offset + 1];
        // 填充字节与无长度的标记可以连续出现，必须逐字节前进。
        if (marker === 0xff) {
            offset += 1;
            continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2;
            continue;
        }
        if (marker === 0xd9 || marker === 0xda)
            return null;
        const length = uint16be(bytes, offset + 2);
        if (length < 2 || offset + 2 + length > bytes.length)
            return null;
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame)
            return { height: uint16be(bytes, offset + 5), width: uint16be(bytes, offset + 7) };
        offset += 2 + length;
    }
    return null;
}
function webpSize(bytes) {
    if (bytes.length < 30)
        return null;
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF')
        return null;
    if (String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP')
        return null;
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === 'VP8 ') {
        if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
            return null;
        return { width: uint16le(bytes, 26) & 0x3fff, height: uint16le(bytes, 28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
        if (bytes[20] !== 0x2f)
            return null;
        const packed = uint32le(bytes, 21);
        return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
        return { width: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1,
            height: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1 };
    }
    return null;
}
/** 解析图片头得到画布尺寸；无法识别或尺寸异常时抛错。 */
export function imageDimensions(bytes) {
    const size = pngSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes);
    if (!size)
        fail('contentType');
    if (size.width < 1 || size.height < 1)
        fail('contentType');
    if (size.width > MAX_MEDIA_EDGE || size.height > MAX_MEDIA_EDGE)
        fail('contentType');
    if (size.width * size.height > MAX_MEDIA_PIXELS)
        fail('contentType');
    return size;
}
/** 扩展名/MIME 与实际文件头必须一致，否则改个后缀就能绕过限制。 */
export function assertContentMatches(contentType, bytes) {
    const size = imageDimensions(bytes);
    const kind = contentType === 'image/png' ? pngSize(bytes) : contentType === 'image/jpeg' ? jpegSize(bytes) : webpSize(bytes);
    if (!kind)
        fail('contentType');
    return size;
}
/** 由文件头判断真实类型：存储里的 MIME 以字节为准，不以客户端声明为准。 */
export function detectContentType(bytes) {
    if (pngSize(bytes))
        return 'image/png';
    if (jpegSize(bytes))
        return 'image/jpeg';
    if (webpSize(bytes))
        return 'image/webp';
    return fail('contentType');
}
/**
 * 确认上传：对象必须存在、大小与申请一致、摘要与客户端声称的一致。
 * 摘要按小写十六进制比较，避免大小写差异造成“同一文件被拒”。
 */
export function assertUploadComplete(expected, actual) {
    if (!actual)
        fail('objectKey');
    if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 1 || expected.sizeBytes > MAX_MEDIA_BYTES)
        fail('sizeBytes');
    if (actual.sizeBytes !== expected.sizeBytes)
        fail('sizeBytes');
    const digest = expected.sha256.toLowerCase();
    if (!SHA256.test(digest))
        fail('sha256');
    if (actual.sha256.toLowerCase() !== digest)
        fail('sha256');
}
