// JSON-LD 结构化数据：让 Google 读懂「这是谁 / 卖什么」，有机会拿到富摘要。
//
// 只输出 schema.org 定义的标准字段，且全部经过 JSON.stringify 转义后由
// dangerouslySetInnerHTML 注入——商品名/简介来自后台，不能拼进 HTML 造成 XSS。
// 价格用商品主单位（已经是元，不是最小货币单位），与前台展示一致。

import { site } from './site';
import type { Locale } from './i18n';
import type { Product } from './product-view';

/** 把结构化数据渲染成 <script>：交给调用方放进 JSX。 */
export function jsonLdScript(data: Record<string, unknown>): { __html: string } {
  return { __html: JSON.stringify(data).replace(/</g, '\\u003c') };
}

/** 全站组织信息 + 网站搜索入口，放在每个语言的首页。 */
export function organizationJsonLd(locale: Locale): Record<string, unknown> {
  const base = `https://${site.domain}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${base}/#organization`,
        name: `${site.brand} ${site.brandLatin}`.trim(),
        alternateName: site.brandLatin,
        description: '香港香煙速遞服務，提供 IQOS 加熱煙系列、免稅及完稅香煙，自家車隊送貨、貨到付款、正貨保證。',
        url: base,
        slogan: site.tagline,
        areaServed: { '@type': 'AdministrativeArea', name: '香港' },
      },
      {
        '@type': 'WebSite',
        '@id': `${base}/#website`,
        url: base,
        name: `${site.brand} ${site.brandLatin}`.trim(),
        publisher: { '@id': `${base}/#organization` },
        inLanguage: locale === 'zh-HK' ? 'zh-Hant-HK' : locale === 'zh-CN' ? 'zh-Hans-CN' : 'en',
      },
    ],
  };
}

/** 商品详情：名称、图片、描述、SKU、品牌、报价与库存。 */
export function productJsonLd(product: Product, canonicalUrl: string): Record<string, unknown> {
  const base = `https://${site.domain}`;
  const graph: Record<string, unknown>[] = [
    {
      '@type': 'Product',
      '@id': `${canonicalUrl}#product`,
      name: product.name,
      description: product.description ?? undefined,
      sku: product.variants[0]?.sku ?? undefined,
      brand: { '@type': 'Brand', name: product.category ?? site.brandLatin },
      url: canonicalUrl,
      image: product.image ? `${base}${product.image}` : undefined,
      offers: {
        '@type': 'AggregateOffer',
        priceCurrency: product.currency,
        lowPrice: product.price,
        offerCount: product.variants.length,
        availability: product.inStock
          ? 'https://schema.org/InStock'
          : 'https://schema.org/OutOfStock',
        url: canonicalUrl,
      },
    },
  ];
  // 清理 undefined 字段：JSON.stringify 会丢掉它们，但 Array 里的对象留着更清晰。
  const clean = (obj: Record<string, unknown>) => Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined));
  return { '@context': 'https://schema.org', '@graph': graph.map(clean) };
}
