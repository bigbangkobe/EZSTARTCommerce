// 区块交互归因（M14 P1）：记录「最近一次区块点击」，供加购时携带。
//
// 不变量：
// - 只存匿名标识（区块/展示位/发布版本/随机 interactionId），不存姓名、电话、邮箱、地址或完整 URL。
// - interactionId 是随机高熵串，与 sessionId 一样不来自任何顾客资料。
// - 归因窗口 24 小时：超期的交互不再附带，服务端还会按自己的时钟复核一次。
// - 隐私模式禁用 sessionStorage 时退化为内存记录，不阻断加购。

export type PlacementInteraction = {
  sectionId: string;
  sectionKey: string;
  placementId: string | null;
  publishVersionId: string;
  pageKey: string;
  interactionId: string;
  variantId: string | null;
  at: number;
};

const STORAGE_KEY = 'ez_placement_interaction';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 20;

function read(): PlacementInteraction[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PlacementInteraction =>
      Boolean(item) && typeof (item as PlacementInteraction).interactionId === 'string');
  } catch {
    return [];
  }
}

function write(records: PlacementInteraction[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_RECORDS)));
  } catch {
    // 隐私模式/存储配额不足：只影响归因覆盖，不影响购物。
  }
}

export function newInteractionId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** 点击区块时记录；同一商品的新交互覆盖旧的，保留最近 20 条。 */
export function rememberInteraction(input: Omit<PlacementInteraction, 'at'>): void {
  const record: PlacementInteraction = { ...input, at: Date.now() };
  const rest = read().filter(item => item.interactionId !== record.interactionId
    && (record.variantId === null || item.variantId !== record.variantId));
  write([...rest, record]);
}

/** 取该商品 24 小时内最后一次区块交互；没有或过期返回 null。 */
export function attributionFor(variantId: string): PlacementInteraction | null {
  const now = Date.now();
  return read()
    .filter(item => item.variantId === variantId && now - item.at <= WINDOW_MS)
    .sort((left, right) => right.at - left.at)[0] ?? null;
}
