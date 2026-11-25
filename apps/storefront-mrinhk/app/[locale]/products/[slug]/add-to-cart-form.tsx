'use client';

import Link from 'next/link';
import { useState } from 'react';
import { addToCart, formatMinor, notifyCartUpdated, type CartView } from '../../../../lib/cart-client';
import { trackAddToCart } from '../../../../lib/analytics-client';
import { attributionFor } from '../../../../lib/placement-client';
import { copyFor, fill, localePath, type Locale } from '../../../../lib/i18n';
import type { ProductVariant } from '../../../../lib/products';

type Props = {
  productName: string;
  variants: ProductVariant[];
  locale: Locale;
};

/**
 * 商品加购表单：多规格时渲染单选列表；加购成功给出「查看購物袋」入口。
 * 服务端拒绝的每一种情况（缺货 409、验证 422）都以文案呈现，不静默吞掉。
 */
export default function AddToCartForm({ productName, variants, locale }: Props) {
  const t = copyFor[locale];
  const sellable = variants.filter((variant) => variant.available > 0);
  const [variantId, setVariantId] = useState(sellable[0]?.id ?? '');
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<CartView | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!sellable.length) {
    return <p className="form-note sold-out">{t.productDetail.soldOutNote}</p>;
  }

  const selected = sellable.find((variant) => variant.id === variantId) ?? sellable[0];

  async function submit() {
    setBusy(true);
    setError(null);
    // 24 小时内最后一次区块点击的匿名归因随加购提交；服务端复核窗口与同意状态后才落库。
    const interaction = attributionFor(selected.id);
    const result = await addToCart(selected.id, quantity, interaction ? {
      sectionId: interaction.sectionId, sectionKey: interaction.sectionKey,
      placementId: interaction.placementId, publishVersionId: interaction.publishVersionId,
      interactionId: interaction.interactionId, pageKey: interaction.pageKey,
      occurredAt: new Date(interaction.at).toISOString(),
    } : null);
    setBusy(false);
    if (!result.ok) {
      // NO_CSRF = 页面停留太久/购物袋令牌过期；重新整理就能拿回令牌，别让客人以为商品坏了。
      setError(result.code === 'NO_CSRF'
        ? t.common.sessionStale
        : result.code === 'OUT_OF_STOCK' || result.status === 409
          ? t.productDetail.outOfStockError
          : result.message ?? t.productDetail.addError);
      return;
    }
    setAdded(result.data);
    notifyCartUpdated();
    // 加购成功（服务端已写入购物袋）后才计数，符合"加购仅在服务端成功写入后计数"口径。
    void trackAddToCart(selected.id, `product:${productName}`, locale);
  }

  if (added) {
    return (
      <div className="added-box">
        <p>{fill(t.productDetail.added, {
          count: added.itemCount, total: formatMinor(added.subtotalMinor, added.currency),
        })}</p>
        <div className="cta-row">
          <Link className="btn btn-primary" href={localePath(locale, '/cart')}>{t.productDetail.viewCart}</Link>
          <button className="btn btn-ghost" type="button" onClick={() => setAdded(null)}>{t.common.continueShopping}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="add-to-cart">
      {sellable.length > 1 && (
        <div className="variant-picker" role="radiogroup" aria-label={t.productDetail.specs}>
          {sellable.map((variant) => (
            <label key={variant.id} className={`variant-option${variant.id === selected.id ? ' selected' : ''}`}>
              <input
                type="radio"
                name={`${productName}-variant`}
                value={variant.id}
                checked={variant.id === selected.id}
                onChange={() => setVariantId(variant.id)}
              />
              <span>{Object.entries(variant.optionValues).map(([key, value]) => `${key} ${value}`).join(' / ') || variant.sku}</span>
              <small>{formatMinor(variant.price * 100, variant.currency)}</small>
            </label>
          ))}
        </div>
      )}

      <div className="qty-row">
        <span className="qty-label">{t.productDetail.quantity}</span>
        <div className="qty-stepper">
          <button type="button" aria-label={t.common.decrease}
            onClick={() => setQuantity((value) => Math.max(1, value - 1))}>−</button>
          <input
            type="number" min={1} max={selected.available} value={quantity}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next) && next >= 1) setQuantity(Math.min(next, selected.available));
            }}
          />
          <button type="button" aria-label={t.common.increase}
            onClick={() => setQuantity((value) => Math.min(selected.available, value + 1))}>＋</button>
        </div>
        <span className="qty-limit">{fill(t.productDetail.stock, { count: selected.available })}</span>
      </div>

      {error && <p className="form-note error">{error}</p>}

      <button className="btn btn-primary add-btn" type="button" disabled={busy} onClick={() => void submit()}>
        {busy ? t.productDetail.adding : t.productDetail.addToCart}
      </button>
    </div>
  );
}
