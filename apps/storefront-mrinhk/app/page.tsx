import Link from 'next/link';
import { copy, site, whatsappLink } from '../lib/site';
import { fetchProducts, formatPrice } from '../lib/products';

function SectionHead({ num, title, jp }: { num: string; title: string; jp: string }) {
  return (
    <>
      <div className="red-line" />
      <div className="section-head">
        <span className="num">{num}</span>
        <h2>{title}</h2>
        <span className="jp">{jp}</span>
      </div>
    </>
  );
}

export default async function HomePage() {
  const result = await fetchProducts();
  const featured = result.ok ? result.products.slice(0, 6) : [];

  return (
    <>
      {/* HERO */}
      <section className="hero">
        <div className="hero-copy">
          <h1>
            {copy.hero.title1}
            <br />
            <span>{copy.hero.title2}</span>
          </h1>
          <p>{copy.hero.sub}</p>
          <div className="cta-row">
            <a className="btn btn-primary" href={whatsappLink} target="_blank" rel="noopener noreferrer">
              {copy.hero.ctaPrimary}
            </a>
            <Link className="btn btn-ghost" href="/products">
              {copy.hero.ctaSecondary}
            </Link>
          </div>
        </div>
        <div className="vertical">{copy.hero.vertical}</div>
        <div className="logo-card">
          <div className="logo-mark">
            <div className="circle" />
            <div className="text">{site.brand}</div>
          </div>
        </div>
      </section>

      {/* ABOUT */}
      <section className="section" id="about">
        <SectionHead num="壱" title={copy.about.heading} jp={copy.about.jp} />
        <div className="cards">
          {copy.about.cards.map((card) => (
            <div className="card" key={card.title}>
              <div className="glyph">{card.glyph}</div>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FEATURED PRODUCTS */}
      <section className="section" id="products">
        <SectionHead num="弐" title={copy.products.heading} jp={copy.products.jp} />
        {!result.ok && featured.length === 0 ? (
          <div className="empty-state">{copy.products.error}</div>
        ) : featured.length === 0 ? (
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
            {featured.map((product) => (
              <div className="card product-card" key={product.id}>
                <div className="product-thumb">{product.category ?? '商品圖片'}</div>
                <div className="product-body">
                  <h3>{product.name}</h3>
                  <div className="product-price">
                    {formatPrice(product.price, product.currency ?? copy.products.currency)}
                    <small> 起</small>
                  </div>
                  <a
                    className="btn btn-ghost product-cta"
                    href={whatsappLink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {copy.products.inquiry}
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
