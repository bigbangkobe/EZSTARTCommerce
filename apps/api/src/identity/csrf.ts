import { timingSafeEqual } from 'node:crypto';

/**
 * CSRF 判定的唯一出口。
 *
 * 规则：写路径必须带与预期完全一致的令牌；只读路径（GET，无副作用）允许省略。
 *
 * 为什么要有这个文件：原来的判定写在 authenticated() 里，形如
 * `if (csrfValue !== null && !equal(csrfValue, expected)) throw ...`。
 * 缺头之所以没被放行，是因为 header() 把缺失的头正规化成了 ''，而 '' 与 64 位期望值
 * 长度不等所以比较失败——这是巧合，不是设计。任何新接口只要传 null（而不是 ''），
 * 校验就静默跳过。现在「只读」是显式参数：写路径传 null 铁定 403。
 *
 * 判定被抽成纯函数，八种组合由 tests/csrf-guard.test.ts 钉住，不依赖数据库。
 */
export function csrfSatisfied(supplied: string | null, expected: string, readOnly: boolean): boolean {
  // 缺头或空头：只读路径视为合法，写路径一律拒绝。
  if (supplied === null || supplied === '') return readOnly;
  const left = Buffer.from(supplied); const right = Buffer.from(expected);
  // 长度先比（timingSafeEqual 对不等长会抛错）；长度一致再定长比较，避免按字节提前返回。
  return left.length === right.length && timingSafeEqual(left, right);
}
