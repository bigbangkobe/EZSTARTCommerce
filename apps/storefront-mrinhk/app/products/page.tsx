import Link from 'next/link';
import { copy, whatsappLink } from '../../lib/site';
import { fetchProducts, formatPrice } from '../../lib/products';
import AnalyticsTracker from '../analytics-tracker';

export const metadata = { title: '商品 | IN先生' };

export default async function ProductsPage() {
  const result = await fetchProducts();
  const products = result.ok ? result.products : [];

  return (
    <section className="section">
      <AnalyticsTracker pageKey="products" />
      <div className="red-line" />
      <div className="section-head">
        <span className="num">壱</span>
        <h2>{copy.products.heading}</h2>
        <span className="jp">{copy.products.jp}</span>
      </div>

      {!result.ok ? (
        <div className="empty-state">{copy.products.error}</div>
      ) : products.length === 0 ? (
        <div className="empty-state">
          {copy.products.empty}
          <div className="cta-row" style={{ justifyContent: 'center', marginTop: 20 }}>
            <a className="btn btn-primary" href={whatsappLink} target="_blank" rel="noopener noreferrer">
              {copy.hero.ctaPrimary}
            </a>
          </div>
        </div>
      ) : (
        <div className="cards">
          {products.map((product) => (
            <div className="card product-card" key={product.id}>
              <div className="product-thumb">{product.name}</div>
              <div className="product-body">
                <h3>
                  <Link href={`/products/${encodeURIComponent(product.slug)}`}>{product.name}</Link>
                </h3>
                <div className="product-price">
                  {formatPrice(product.price, product.currency)}
                  <small> 起</small>
                </div>
                {!product.inStock && <p className="product-stock">暫時缺貨</p>}
                <Link className="btn btn-ghost product-cta" href={`/products/${encodeURIComponent(product.slug)}`}>
                  查看詳情
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
