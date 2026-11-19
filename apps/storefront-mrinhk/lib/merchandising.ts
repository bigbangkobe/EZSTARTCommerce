// 首页陈列（M04 第三批）：读后台发布的版面快照，商品资格由服务端在读取时复验。
// 未配置或接口不可用都返回 ok:false，首页据此退回主题默认陈列——陈列是增强，不是单点故障。

import { toProduct, type Product } from './products';

export type MerchSection = {
  sectionId: string;
  title: string;
  sortMode: string;
  products: Product[];
};

export type MerchResult =
  | { ok: true; sections: MerchSection[] }
  | { ok: false; error: 'not_configured' | 'unavailable' };

const apiBase = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001';
/** 与商品目录一致：陈列里的商品也必须在同一个可售市场下复验。 */
const SITE_MARKET = 'HK';

type ApiSection = { sectionId?: string; title?: string; sortMode?: string; products?: Parameters<typeof toProduct>[0][] };

export async function fetchMerchandising(locale: string): Promise<MerchResult> {
  const query = new URLSearchParams({ locale, marketCode: SITE_MARKET });
  try {
    const response = await fetch(`${apiBase}/api/v1/storefront/merchandising/home?${query.toString()}`, {
      next: { revalidate: 30 },
    });
    // 404 = 还没发布过陈列（或已撤下），不是错误：首页用主题默认布局。
    if (response.status === 404) return { ok: false, error: 'not_configured' };
    if (!response.ok) return { ok: false, error: 'unavailable' };
    const body = (await response.json()) as { data?: { sections?: ApiSection[] } };
    const sections = (body.data?.sections ?? []).map(section => ({
      sectionId: String(section.sectionId ?? ''), title: String(section.title ?? ''),
      sortMode: String(section.sortMode ?? 'manual'),
      products: (section.products ?? []).map(item => toProduct(item)),
    })).filter(section => section.sectionId && section.products.length > 0);
    return { ok: true, sections };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}
