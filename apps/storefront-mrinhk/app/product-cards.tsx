import Link from 'next/link';
import { copyFor, localePath, type Locale } from '../lib/i18n';
import { formatPrice, type Product } from '../lib/products';
import { whatsappLink } from '../lib/site';

/**
 * 商品卡片：首页默认精选、陈列区块与分类页共用一套结构与埋点字段。
 * 埋点字段（data-ez-placement / data-ez-variant）在这里统一，避免某个入口漏掉导致报表缺数。
 */
export function ProductCards({ products, locale }: { products: Product[]; locale: Locale }) {
  const t = copyFor[locale];
  return (
    <div className="cards">
      {products.map((product) => (
        <div className="card product-card" key={product.id}
          data-ez-placement={product.id} data-ez-variant={product.variants[0]?.id ?? undefined}>
          <div className="product-thumb">{product.category ?? t.products.thumbFallback}</div>
          <div className="product-body">
            <h3>
              <Link href={localePath(locale, `/products/${encodeURIComponent(product.slug)}`)}>{product.name}</Link>
            </h3>
            <div className="product-price">
              {formatPrice(product.price, product.currency)}
              <small> {t.common.from}</small>
            </div>
            <a className="btn btn-ghost product-cta" href={whatsappLink} target="_blank" rel="noopener noreferrer">
              {t.products.inquiry}
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

export default ProductCards;
