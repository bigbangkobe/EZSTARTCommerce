import Link from 'next/link';
import { notFound } from 'next/navigation';
import { copy, whatsappLink } from '../../../lib/site';
import { fetchProduct, formatPrice } from '../../../lib/products';

export const revalidate = 60;

export default async function ProductDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await fetchProduct(slug);
  if (!product) notFound();

  return (
    <section className="section">
      <div className="red-line" />
      <div className="section-head">
        <span className="num">弐</span>
        <h2>{product.name}</h2>
        <span className="jp">{copy.products.jp}</span>
      </div>

      <div className="card product-card">
        <div className="product-thumb">{product.name}</div>
        <div className="product-body">
          <div className="product-price">
            {formatPrice(product.price, product.currency)}
            <small> 起</small>
          </div>
          <p>{product.description ?? copy.products.empty}</p>

          <h3>規格</h3>
          <ul>
            {product.variants.map((variant) => (
              <li key={variant.id}>
                {Object.entries(variant.optionValues).map(([key, value]) => `${key} ${value}`).join(' / ') || variant.sku}
                {' — '}
                {formatPrice(variant.price, variant.currency)}
                {variant.available > 0 ? `（現貨 ${variant.available}）` : '（缺貨）'}
              </li>
            ))}
          </ul>

          <div className="cta-row">
            <a className="btn btn-primary" href={whatsappLink} target="_blank" rel="noopener noreferrer">
              {copy.products.inquiry}
            </a>
            <Link className="btn btn-ghost" href="/products">
              返回商品列表
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
