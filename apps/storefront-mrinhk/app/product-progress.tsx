'use client';

/**
 * 右侧商品进度条：填多少 = 已经出现的商品数 / 商品总数。
 *
 * 注意这不是滚动进度——客人关心的是「还有多少件没翻到」，
 * 所以分子是已经渲染出来的卡片数，分母来自列表接口的 total（与分页同一套可售过滤，口径一致）。
 *
 * 数字放在右缘中部：滚动时始终在视野里，一眼就知道现在到第几件。
 * 手机屏窄，浮层会和卡片打架，所以窄屏只留 2px 的条，数字改在列表底部显示（见 ProductList）。
 */
export function ProductProgress({ loaded, total, label }: {
  loaded: number;
  total: number | null;
  label: string;
}) {
  const ratio = total && total > 0 ? Math.min(1, loaded / total) : 0;
  return (
    <>
      <div className="product-progress" role="progressbar" aria-label={label}
        aria-valuemin={0} aria-valuemax={total ?? 0} aria-valuenow={loaded}>
        <div className="product-progress-fill" style={{ transform: `scaleY(${ratio})` }} />
      </div>
      {total ? (
        <p className="product-progress-count" aria-hidden="true">
          <b>{loaded}</b>
          <i />
          <span>{total}</span>
        </p>
      ) : null}
    </>
  );
}

export default ProductProgress;
