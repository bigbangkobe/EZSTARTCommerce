/**
 * 已发布地址重定向纯规则（M04 第二批）。
 *
 * 只回答：什么路径可以登记为重定向、链怎么解析、什么时候拒绝。不碰数据库、不碰网络。
 *
 * 不变量：
 * 1. 只允许站内相对路径：必须以 `/` 开头，不允许协议、域名、查询串、片段、反斜杠与空白。
 *    开放绝对地址等于把店铺变成任意外链跳板。
 * 2. 同址自跳直接拒绝；解析链最多 5 跳，出现环或超深一律按「无重定向」处理（失败即关闭）。
 * 3. 解析结果只认首个命中的记录，链式跳转在服务端一次算完，避免浏览器连续跳多次。
 * 4. 重定向不改变页面内容与索引资格：它只是把旧地址指向新地址。
 */
export class RedirectRuleError extends Error {
    field;
    code;
    constructor(field, code = 'VALIDATION_ERROR') {
        super(field);
        this.field = field;
        this.code = code;
    }
}
function fail(field, code = 'VALIDATION_ERROR') { throw new RedirectRuleError(field, code); }
export const REDIRECT_STATUS_CODES = [301, 308];
export const MAX_REDIRECT_PATH_LENGTH = 300;
export const MAX_REDIRECT_HOPS = 5;
/** 站内路径字符集：显式排除 `%`（避免编码绕过）、空白、反斜杠、查询串与片段。 */
const PATH_PATTERN = /^\/[A-Za-z0-9._~-][A-Za-z0-9._~/-]*$/;
/**
 * 路径规范化：统一去掉尾部斜杠（根路径除外）。
 * 只做形式收敛，不做小写化——URL 大小写敏感，静默改大小写会让旧链接仍然 404。
 */
export function normalizeRedirectPath(value, field = 'path') {
    if (typeof value !== 'string')
        fail(field);
    const text = value.trim();
    if (text.length < 2 || text.length > MAX_REDIRECT_PATH_LENGTH)
        fail(field);
    if (!PATH_PATTERN.test(text))
        fail(field);
    if (text.includes('//'))
        fail(field);
    return text.endsWith('/') ? text.replace(/\/+$/, '') || '/' : text;
}
/** 内容页的公开地址：语言前缀 + /pages/ + slug，必须与前台路由保持一致。 */
export function contentPagePath(locale, slug) {
    if (typeof locale !== 'string' || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale))
        fail('locale');
    if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
        fail('slug');
    return `/${locale}/pages/${slug}`;
}
/**
 * 解析重定向：沿链最多走 MAX_REDIRECT_HOPS 跳，返回最终地址（跳数 >1 时前端只需一次跳转）。
 * 环、超深、自跳、非法目标一律返回 null —— 宁可 404，也不把用户送进无限跳转。
 */
export function resolveRedirect(entries, fromPath) {
    const map = new Map();
    for (const entry of entries) {
        if (!map.has(entry.fromPath))
            map.set(entry.fromPath, entry);
    }
    const seen = new Set();
    let current = fromPath;
    let statusCode = null;
    for (let hops = 1; hops <= MAX_REDIRECT_HOPS; hops += 1) {
        if (seen.has(current))
            return null;
        seen.add(current);
        const entry = map.get(current);
        if (!entry)
            return statusCode === null ? null : { toPath: current, statusCode, hops: hops - 1 };
        if (!REDIRECT_STATUS_CODES.includes(entry.statusCode))
            return null;
        if (entry.toPath === entry.fromPath)
            return null;
        statusCode = entry.statusCode;
        current = entry.toPath;
    }
    // 还在链上说明超过 5 跳：按无重定向处理，避免浏览器被拖进长跳转。
    return null;
}
/** 写入前的链路校验：自跳、以及「新记录让链回到起点」形成的环都要拒绝。 */
export function assertRedirectWritable(entries, fromPath, toPath) {
    if (fromPath === toPath)
        fail('toPath', 'REDIRECT_SELF');
    const map = new Map();
    for (const entry of entries)
        if (!map.has(entry.fromPath))
            map.set(entry.fromPath, entry);
    let current = toPath;
    for (let hops = 0; hops <= MAX_REDIRECT_HOPS; hops += 1) {
        if (current === fromPath)
            fail('toPath', 'REDIRECT_LOOP');
        const next = map.get(current);
        if (!next)
            return;
        current = next.toPath;
    }
    fail('toPath', 'REDIRECT_LOOP');
}
/**
 * slug 变更时的重定向计划（纯函数，便于单测）：
 * - 新地址即将上线，任何「从新地址出发」的旧重定向必须移除，否则它会把线上页面挡掉；
 * - 登记 旧 → 新；
 * - 原本指向旧地址的重定向改为指向新地址，避免多一跳。
 */
export function slugChangePlan(entries, fromPath, toPath) {
    if (fromPath === toPath)
        return { remove: [], upsert: { fromPath, toPath }, retarget: [] };
    const remove = entries.filter(entry => entry.fromPath === toPath).map(entry => entry.fromPath);
    const retarget = entries
        .filter(entry => entry.toPath === fromPath && entry.fromPath !== fromPath && entry.fromPath !== toPath)
        .map(entry => ({ fromPath: entry.fromPath, toPath }));
    return { remove, upsert: { fromPath, toPath }, retarget };
}
