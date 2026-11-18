'use client';

import { useEffect } from 'react';
import { trackSectionClick, trackSectionImpression } from '../lib/analytics-client';
import { newInteractionId, rememberInteraction } from '../lib/placement-client';

type Props = {
  pageKey: string;
  publishVersionId: string;
  locale?: string;
};

/** 曝光判定：至少 50% 进入可视区域并持续 1 秒（M14 P1 口径）。 */
const VISIBLE_RATIO = 0.5;
const VISIBLE_MS = 1000;

/**
 * 区块埋点适配器（标准事件口径）。
 *
 * 主题只需要在区块容器上标 `data-ez-section`（稳定键）、`data-ez-section-id`（实例）、
 * 可选 `data-ez-placement`（展示位）和商品卡上的 `data-ez-variant`，本组件负责：
 * - 曝光：区块 50% 可见持续 1 秒上报一次，同一会话同一页面同一区块不重复；
 * - 点击：上报 section_click，并记住这次交互（随机 interactionId），供 24 小时内加购归因；
 * - 环境：始终 production；预览/员工流量由后台标记，不由主题自行声明。
 * 采集开关与同意门槛由 analytics-client 统一把关，未同意时这里什么也不发。
 */
export default function SectionTracker({ pageKey, publishVersionId, locale }: Props) {
  useEffect(() => {
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const fired = new Set<string>();
    const storageKey = `ez_impressions:${pageKey}`;

    const alreadyFired = (sectionId: string): boolean => {
      if (fired.has(sectionId)) return true;
      try {
        const raw = sessionStorage.getItem(storageKey);
        const list = raw ? (JSON.parse(raw) as unknown) : [];
        return Array.isArray(list) && list.includes(sectionId);
      } catch {
        return false;
      }
    };

    const markFired = (sectionId: string): void => {
      fired.add(sectionId);
      try {
        const raw = sessionStorage.getItem(storageKey);
        const list = raw ? (JSON.parse(raw) as unknown) : [];
        const next = Array.isArray(list) ? [...list.filter(item => typeof item === 'string'), sectionId].slice(-50) : [sectionId];
        sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // 存不了就只在本页去重。
      }
    };

    const report = (element: Element): void => {
      const data = (element as HTMLElement).dataset;
      const sectionKey = data.ezSection;
      if (!sectionKey) return;
      const sectionId = data.ezSectionId ?? `${pageKey}:${sectionKey}`;
      if (alreadyFired(sectionId)) return;
      markFired(sectionId);
      trackSectionImpression({
        pageKey, sectionId, sectionKey, publishVersionId,
        ...(data.ezPlacement ? { placementId: data.ezPlacement } : {}),
        ...(locale ? { locale } : {}),
      });
    };

    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO) {
          if (timers.has(entry.target)) continue;
          timers.set(entry.target, setTimeout(() => {
            timers.delete(entry.target);
            report(entry.target);
          }, VISIBLE_MS));
        } else {
          const timer = timers.get(entry.target);
          if (timer) { clearTimeout(timer); timers.delete(entry.target); }
        }
      }
    }, { threshold: [0, VISIBLE_RATIO, 1] });

    const observeAll = (): void => {
      document.querySelectorAll('[data-ez-section]').forEach(element => observer.observe(element));
    };
    observeAll();

    const onClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const section = target.closest('[data-ez-section]');
      if (!section) return;
      const data = (section as HTMLElement).dataset;
      const sectionKey = data.ezSection;
      if (!sectionKey) return;
      const sectionId = data.ezSectionId ?? `${pageKey}:${sectionKey}`;
      const variantElement = target.closest('[data-ez-variant]') as HTMLElement | null;
      const variantId = variantElement?.dataset.ezVariant ?? null;
      const interactionId = newInteractionId();
      trackSectionClick({
        pageKey, sectionId, sectionKey, publishVersionId, interactionId,
        ...(data.ezPlacement ? { placementId: data.ezPlacement } : {}),
        ...(locale ? { locale } : {}),
        ...(variantId ? { variantId } : {}),
      });
      rememberInteraction({ sectionId, sectionKey, placementId: data.ezPlacement ?? null,
        publishVersionId, pageKey, interactionId, variantId });
    };
    document.addEventListener('click', onClick, true);

    return () => {
      document.removeEventListener('click', onClick, true);
      for (const timer of timers.values()) clearTimeout(timer);
      observer.disconnect();
    };
  }, [pageKey, publishVersionId, locale]);

  return null;
}
