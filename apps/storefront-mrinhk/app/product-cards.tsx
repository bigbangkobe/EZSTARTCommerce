import Link from 'next/link';
import type { CSSProperties } from 'react';
import { copyFor, localePath, type Locale } from '../lib/i18n';
// 展示逻辑走 product-view：那是纯函数模块，客户端组件（product-list）也能安全引用。
import { formatPrice, type Product } from '../lib/product-view';

/**
 * 商品卡片：首页精选、陈列区块、分类页与商品列表共用一套结构与埋点字段。
 * 埋点字段（data-ez-placement / data-ez-variant）在这里统一，避免某个入口漏掉导致报表缺数。
 *
 * 缩略图：商品还没上传照片时，用「名称首字 + 由名称推导的色相」占位。
 * 这比一块灰底「商品圖片」有用得多——客人能一眼分辨卡片，版面也不会塌。
 */
export function productHue(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 360;
  }
  return hash;
}

export function productInitial(name: string) {
  const trimmed = name.trim();
  return trimmed ? Array.from(trimmed)[0] : '·';
}

export function ProductCards({ products, locale }: { products: Product[]; locale: Locale }) {
  const t = copyFor[locale];
  return (
    <div className="product-grid">
      {products.map((product) => {
        const href = localePath(locale, `/products/${encodeURIComponent(product.slug)}`);
        return (
          <article className="product-card" key={product.id}
            data-ez-placement={product.id} data-ez-variant={product.variants[0]?.id ?? undefined}>
            <Link className="product-media" href={href} tabIndex={-1} aria-hidden="true"
              style={{ '--h': String(productHue(product.name)) } as CSSProperties}>
              {product.image
                ? <img src={product.image} alt="" loading="lazy" />
                : <span className="product-media-mark">{productInitial(product.name)}</span>}
              {!product.inStock && <span className="product-flag">{t.common.soldOut}</span>}
            </Link>
            <div className="product-body">
              {product.category && <p className="product-kicker">{product.category}</p>}
              <h3><Link href={href}>{product.name}</Link></h3>
              {product.description && <p className="product-desc">{product.description}</p>}
              <div className="product-foot">
                <span className="product-price">
                  {formatPrice(product.price, product.currency)}
                  <small>{t.common.from}</small>
                </span>
                <span className="product-more">{t.products.viewDetail}<span aria-hidden="true">→</span></span>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export default ProductCards;
