/**
 * 配送区与费率（M09 最小切片，供 M06 结账使用）纯规则层。
 *
 * 首期只有“按国家/区域划分 + 固定运费 + 金额门槛免邮”，因此规则里不出现
 * 重量、体积、承运商或阶梯费率的影子字段：契约没有的字段一出现就是 422。
 */

export class ShippingRuleError extends Error {
  constructor(readonly field: string, readonly code = 'VALIDATION_ERROR') { super(field); }
}

function fail(field: string, code?: string): never { throw new ShippingRuleError(field, code); }

const CODE = /^[A-Z0-9][A-Z0-9._-]{0,79}$/;
const COUNTRY = /^[A-Z]{2}$/;
const MAX_COUNTRIES = 60;
const MAX_REGIONS = 200;
const MAX_ZONES_PER_RATE = 20;

export interface ZoneInput {
  code: string; nameByLocale: Record<string, string>; countryCodes: string[]; regionCodes: string[];
  priority: number; enabled: boolean;
}
export interface RateInput {
  code: string; nameByLocale: Record<string, string>; zoneIds: string[]; fixedFeeMinor: number;
  freeAboveMinor: number | null; currency: string; estimatedMinDays: number | null; estimatedMaxDays: number | null;
  codEnabled: boolean; enabled: boolean;
}

/** 编码 trim + uppercase：STANDARD 与 standard 是同一个费率，不能并存。 */
export function normalizeCode(value: string, field: string): string {
  if (typeof value !== 'string') fail(field);
  const code = value.trim().toUpperCase();
  if (!CODE.test(code)) fail(field);
  return code;
}

export function normalizeNames(value: Record<string, string>, localeLimit: number): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('nameByLocale');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > localeLimit) fail('nameByLocale');
  const names: Record<string, string> = {};
  for (const [locale, name] of entries) {
    if (typeof name !== 'string') fail('nameByLocale');
    const trimmed = name.trim();
    if (!trimmed.length || trimmed.length > 120) fail('nameByLocale');
    names[locale] = trimmed;
  }
  return names;
}

function codes(values: string[], field: string, max: number): string[] {
  if (!Array.isArray(values) || values.length > max || values.some(value => typeof value !== 'string')) fail(field);
  return [...new Set(values.map(value => value.trim()))];
}

export function normalizeCountries(values: string[]): string[] {
  // 先去空白再大写，最后去重：'hk' 与 'HK' 是同一个国家，不能各留一条。
  const list = [...new Set(codes(values, 'countryCodes', MAX_COUNTRIES).map(value => value.toUpperCase()))];
  if (!list.length || list.some(value => !COUNTRY.test(value))) fail('countryCodes');
  return list.sort();
}

export function normalizeRegions(values: string[]): string[] {
  const list = codes(values ?? [], 'regionCodes', MAX_REGIONS);
  if (list.some(value => !value.length || value.length > 80)) fail('regionCodes');
  return list.sort();
}

export function normalizePriority(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) fail('priority');
  return value;
}

export function normalizeMoney(value: number | null | undefined, field: string, nullable = false): number | null {
  if (value === null || value === undefined) {
    if (nullable) return null;
    fail(field);
  }
  if (!Number.isInteger(value) || value < 0) fail(field);
  return value;
}

export function normalizeDays(value: number | null, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > 365) fail(field);
  return value;
}

export function normalizeZoneIds(values: string[]): string[] {
  const list = codes(values, 'zoneIds', MAX_ZONES_PER_RATE);
  if (!list.length || list.length !== values.length) fail('zoneIds'); // 重复区 ID 说明客户端在猜结构
  return list;
}

/**
 * 同一国家下两个“全境”区，或区域集合有交集的区，会给出双份运费口径。
 * 这里在写入时拒绝精确重叠；优先级只在“不同区域明细”之间决定，不用来掩盖重复配置。
 */
export function zonesOverlap(left: { countryCodes: readonly string[]; regionCodes: readonly string[] },
  right: { countryCodes: readonly string[]; regionCodes: readonly string[] }): boolean {
  const sharesCountry = left.countryCodes.some(code => right.countryCodes.includes(code));
  if (!sharesCountry) return false;
  if (!left.regionCodes.length && !right.regionCodes.length) return true;
  if (!left.regionCodes.length || !right.regionCodes.length) return false;
  return left.regionCodes.some(code => right.regionCodes.includes(code));
}

export function assertNoOverlap(candidate: ZoneInput, existing: readonly { id: string; enabled: boolean;
  countryCodes: readonly string[]; regionCodes: readonly string[] }[]): void {
  if (!candidate.enabled) return;
  if (existing.some(zone => zone.enabled && zonesOverlap(candidate, zone))) fail('countryCodes', 'ZONE_OVERLAP');
}
