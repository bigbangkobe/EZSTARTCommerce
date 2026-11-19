import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePreviewPlan, previewPath, isPreviewLive, PreviewRuleError } from '../packages/domain/src/preview.js';
import {
  assertRedirectWritable, contentPagePath, normalizeRedirectPath, RedirectRuleError, resolveRedirect,
  slugChangePlan, type RedirectEntry,
} from '../packages/domain/src/redirect.js';

const LOCALES = ['zh-CN', 'zh-HK', 'en'];

test('preview links are bound to locale, viewport and a bounded lifetime', () => {
  const now = new Date('2026-11-19T03:00:00Z');
  const plan = normalizePreviewPlan({ locale: 'zh-HK', viewport: 'mobile', expectedVersion: 3 }, LOCALES, now);
  assert.equal(plan.locale, 'zh-HK');
  assert.equal(plan.viewport, 'mobile');
  assert.equal(plan.expiresAt.toISOString(), '2026-11-19T04:00:00.000Z');
  assert.equal(previewPath('A'.repeat(43), plan), `/zh-HK/preview/${'A'.repeat(43)}?viewport=mobile`);
  // 有效期上下界：太短来不及复核，超过 24 小时等于长期可用的绕过入口。
  assert.equal(normalizePreviewPlan({ locale: 'en', viewport: 'desktop', expectedVersion: 1, ttlMinutes: 1440 }, LOCALES, now)
    .expiresAt.toISOString(), '2026-11-20T03:00:00.000Z');
  for (const ttl of [4, 1441]) {
    assert.throws(() => normalizePreviewPlan({ locale: 'en', viewport: 'desktop', expectedVersion: 1, ttlMinutes: ttl }, LOCALES, now),
      (error: unknown) => error instanceof PreviewRuleError);
  }
  // 店铺没启用的语言、未注册的视口、未知字段都不能悄悄通过。
  assert.throws(() => normalizePreviewPlan({ locale: 'zh-Hant', viewport: 'desktop', expectedVersion: 1 }, LOCALES, now));
  assert.throws(() => normalizePreviewPlan({ locale: 'en', viewport: 'tablet', expectedVersion: 1 }, LOCALES, now));
  assert.throws(() => normalizePreviewPlan({ locale: 'en', viewport: 'desktop', expectedVersion: 1, admin: true }, LOCALES, now));
  assert.throws(() => previewPath('short', plan), (error: unknown) => error instanceof PreviewRuleError);
  // 失效只看服务端时间。
  assert.equal(isPreviewLive(plan.expiresAt, new Date('2026-11-19T03:59:59Z')), true);
  assert.equal(isPreviewLive(plan.expiresAt, plan.expiresAt), false);
});

test('redirect paths stay on site and chains are resolved or refused as a whole', () => {
  assert.equal(normalizeRedirectPath('/zh-HK/pages/about/'), '/zh-HK/pages/about');
  for (const bad of ['https://evil.example.test', '//evil.example.test', '/a?b=1', '/a#x', '/a b', '/%2e%2e/x',
    'zh-HK/pages/about', '']) {
    assert.throws(() => normalizeRedirectPath(bad), (error: unknown) => error instanceof RedirectRuleError, bad);
  }
  assert.equal(contentPagePath('zh-HK', 'about-us'), '/zh-HK/pages/about-us');

  const entries: RedirectEntry[] = [
    { fromPath: '/zh-HK/pages/a', toPath: '/zh-HK/pages/b', statusCode: 301 },
    { fromPath: '/zh-HK/pages/b', toPath: '/zh-HK/pages/c', statusCode: 301 },
  ];
  // 链在服务端一次走完：前端只跳一次，最终目标是 c。
  assert.deepEqual(resolveRedirect(entries, '/zh-HK/pages/a'), { toPath: '/zh-HK/pages/c', statusCode: 301, hops: 2 });
  assert.equal(resolveRedirect(entries, '/zh-HK/pages/unknown'), null);

  const loop: RedirectEntry[] = [
    { fromPath: '/x', toPath: '/y', statusCode: 301 },
    { fromPath: '/y', toPath: '/x', statusCode: 301 },
  ];
  // 成环时解析失败而不是把浏览器拖进无限跳转。
  assert.equal(resolveRedirect(loop, '/x'), null);
  assert.throws(() => assertRedirectWritable(loop, '/z', '/x'), (error: unknown) => error instanceof RedirectRuleError);
  assert.throws(() => assertRedirectWritable([], '/a', '/a'));
  assert.doesNotThrow(() => assertRedirectWritable(entries, '/zh-HK/pages/old', '/zh-HK/pages/a'));

  // 深度超过上限也按无重定向处理。
  const deep: RedirectEntry[] = Array.from({ length: 7 }, (_, index) => ({
    fromPath: `/p${index}`, toPath: `/p${index + 1}`, statusCode: 301 }));
  assert.equal(resolveRedirect(deep, '/p0'), null);
});

test('changing a published slug retargets inbound links and clears the new path', () => {
  const entries: RedirectEntry[] = [
    { fromPath: '/zh-HK/pages/older', toPath: '/zh-HK/pages/old', statusCode: 301 },
    { fromPath: '/zh-HK/pages/new', toPath: '/zh-HK/pages/elsewhere', statusCode: 301 },
  ];
  const plan = slugChangePlan(entries, '/zh-HK/pages/old', '/zh-HK/pages/new');
  // 新地址即将上线：任何「从新地址出发」的旧重定向必须移除，否则会把线上页面挡掉。
  assert.deepEqual(plan.remove, ['/zh-HK/pages/new']);
  assert.deepEqual(plan.upsert, { fromPath: '/zh-HK/pages/old', toPath: '/zh-HK/pages/new' });
  // 原本指向旧地址的记录改为直接指向新地址，少一跳。
  assert.deepEqual(plan.retarget, [{ fromPath: '/zh-HK/pages/older', toPath: '/zh-HK/pages/new' }]);
  // 没有变化时不制造噪声。
  assert.deepEqual(slugChangePlan(entries, '/zh-HK/pages/same', '/zh-HK/pages/same').retarget, []);
});
