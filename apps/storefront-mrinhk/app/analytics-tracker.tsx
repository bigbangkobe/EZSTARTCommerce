'use client';

import { useEffect } from 'react';
import { trackPageView, trackViewItem } from '../lib/analytics-client';

/**
 * 页面浏览埋点：服务端组件里挂一个空渲染的客户端组件，只在挂载时上报一次。
 * 不渲染任何 UI，不影响布局；采集失败静默。
 */
export default function AnalyticsTracker({ pageKey, locale, variantId }: {
  pageKey: string;
  locale?: string;
  variantId?: string;
}) {
  useEffect(() => {
    if (variantId) trackViewItem(variantId, pageKey, locale);
    else trackPageView(pageKey, locale);
    // 只在挂载时上报一次；pageKey/locale/variantId 在路由切换时由 key 变化触发重新挂载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
