'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * 右侧滑动进度条：整页读取进度的细条，随滚动填充。
 *
 * 为什么不用 state 驱动整棵树：滚动每帧都变，只有这条 3px 的 bar 需要重画，
 * 所以进度写进 CSS 变量 + transform（合成层上跑，不触发布局）。
 * 商品是无限滚动加载的，页面高度会自己在长，因此还要盯 body 的尺寸变化。
 */
export function ScrollProgress({ label }: { label: string }) {
  const fill = useRef<HTMLDivElement | null>(null);
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      const ratio = max > 0 ? Math.min(1, Math.max(0, doc.scrollTop / max)) : 0;
      fill.current?.style.setProperty('--p', String(ratio));
      setPercent(Math.round(ratio * 100));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };

    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // 无限滚动追加卡片、图片撑开高度：不盯 ResizeObserver 的话进度会一路显示 100%。
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(document.body);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="scroll-rail" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className="scroll-rail-fill" ref={fill} />
    </div>
  );
}

export default ScrollProgress;
