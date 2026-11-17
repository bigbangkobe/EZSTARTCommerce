import { copy, whatsappLink } from '../../lib/site';

export const metadata = { title: `商品 | IN先生` };

export default function ProductsPage() {
  return (
    <section className="section">
      <div className="red-line" />
      <div className="section-head">
        <span className="num">壱</span>
        <h2>{copy.products.heading}</h2>
        <span className="jp">{copy.products.jp}</span>
      </div>
      <div className="empty-state">
        {copy.products.empty}
        <div className="cta-row" style={{ justifyContent: 'center', marginTop: 20 }}>
          <a className="btn btn-primary" href={whatsappLink} target="_blank" rel="noopener noreferrer">
            {copy.hero.ctaPrimary}
          </a>
        </div>
      </div>
    </section>
  );
}
