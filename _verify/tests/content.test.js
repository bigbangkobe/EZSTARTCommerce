import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContentRuleError, assertPageKey, assertPageSlug, assertPublishable, contentReleaseToken, missingLocales, nextVersion, normalizeBlockConfig, normalizeBlocks, normalizePageTranslations, normalizePublishPlan, pageSnapshot, visibleBlocks, } from '../packages/domain/src/content.js';
const LOCALES = ['zh-CN', 'zh-HK', 'en'];
const translation = (locale, slug) => ({ locale, title: `${slug} 標題`, slug, seoTitle: null,
    seoDescription: null, indexable: true });
test('content: page keys and slugs are lowercase stable tokens, never URLs', { timeout: 20_000 }, () => {
    assert.equal(assertPageKey('about'), 'about');
    assert.equal(assertPageKey('shipping-policy'), 'shipping-policy');
    for (const bad of ['About', '1about', 'about us', 'about/us', 'about_us', '', 'a'.repeat(65)]) {
        assert.throws(() => assertPageKey(bad), ContentRuleError, bad);
    }
    assert.equal(assertPageSlug('about-us'), 'about-us');
    for (const bad of ['About', 'about us', 'about--us', 'about/us', '-about', '', '关于我们']) {
        assert.throws(() => assertPageSlug(bad), ContentRuleError, bad);
    }
});
test('content: block registry rejects unknown types and unsafe config instead of storing them', { timeout: 20_000 }, () => {
    const blocks = normalizeBlocks([
        { id: 'intro', type: 'rich_text', visible: true, position: 1, config: { heading: '關於', paragraphs: ['第一段'] } },
        { id: 'hidden', type: 'notice', visible: false, position: 0, config: { tone: 'warning', text: '整修中' } },
    ]);
    // 顺序按 (position,id) 稳定排序：position 0 的提示条排在前面，即使它被隐藏。
    assert.deepEqual(blocks.map(block => block.id), ['hidden', 'intro']);
    assert.deepEqual(visibleBlocks(blocks).map(block => block.id), ['intro']);
    // 未注册的区块类型：直接拒绝，不能存下来后在前台静默消失。
    assert.throws(() => normalizeBlocks([{ id: 'x', type: 'custom_html', visible: true, position: 0, config: {} }]), (error) => error instanceof ContentRuleError && error.code === 'UNSUPPORTED_BLOCK_TYPE');
    // HTML/脚本字符、未知字段、重复 id、超长字段一律拒绝。
    assert.throws(() => normalizeBlockConfig('rich_text', { paragraphs: ['<script>alert(1)</script>'] }), ContentRuleError);
    assert.throws(() => normalizeBlockConfig('rich_text', { paragraphs: ['ok'], html: '<b>x</b>' }), ContentRuleError);
    assert.throws(() => normalizeBlockConfig('notice', { tone: 'loud', text: 'x' }), ContentRuleError);
    assert.throws(() => normalizeBlockConfig('contact_card', { email: 'not-an-email' }), ContentRuleError);
    assert.throws(() => normalizeBlocks([
        { id: 'dup', type: 'notice', visible: true, position: 0, config: { tone: 'info', text: 'a' } },
        { id: 'dup', type: 'notice', visible: true, position: 1, config: { tone: 'info', text: 'b' } },
    ]), (error) => error instanceof ContentRuleError && error.code === 'DUPLICATE_BLOCK');
});
test('content: publishing requires every enabled locale and at least one visible block', { timeout: 20_000 }, () => {
    const translations = normalizePageTranslations([translation('zh-HK', 'about'), translation('en', 'about-en')], LOCALES);
    assert.deepEqual(missingLocales(translations, LOCALES), ['zh-CN']);
    const blocks = normalizeBlocks([{ id: 'intro', type: 'rich_text', visible: true, position: 0,
            config: { paragraphs: ['內容'] } }]);
    // 缺语言时不静默回退到另一种语言：返回缺失清单，由后台补齐。
    assert.deepEqual(assertPublishable(translations, blocks, LOCALES).missingLocales, ['zh-CN']);
    // 三语齐全但没有可见区块也不能发布：空页面等于发布一张白页。
    const complete = normalizePageTranslations(LOCALES.map(locale => translation(locale, `about-${locale.toLowerCase()}`)), LOCALES);
    const hidden = normalizeBlocks([{ id: 'intro', type: 'rich_text', visible: false, position: 0,
            config: { paragraphs: ['內容'] } }]);
    assert.throws(() => assertPublishable(complete, hidden, LOCALES), (error) => error instanceof ContentRuleError && error.code === 'NO_VISIBLE_BLOCK');
    assert.equal(assertPublishable(complete, blocks, LOCALES).visibleBlocks, 1);
    // 只启用两种语言时，没写第三种语言不算缺（发布要求跟随店铺设置，而不是写死三语）。
    assert.deepEqual(assertPublishable(translations, blocks, ['zh-HK', 'en']).missingLocales, []);
    // 语言闭集之外的 locale 直接拒绝（不能自造 zh-Hant 之类变体）。
    assert.throws(() => normalizePageTranslations([translation('zh-Hant', 'about')], LOCALES), ContentRuleError);
    assert.throws(() => normalizePageTranslations([translation('en', 'about'), translation('en', 'about-2')], LOCALES), (error) => error instanceof ContentRuleError && error.code === 'DUPLICATE_LOCALE');
});
test('content: publish plan and snapshots keep server time authoritative and immutable', { timeout: 20_000 }, () => {
    const now = new Date('2026-11-18T10:00:00.000Z');
    assert.deepEqual(normalizePublishPlan(undefined, now), { mode: 'immediate', scheduledAt: null });
    assert.deepEqual(normalizePublishPlan({ mode: 'immediate' }, now), { mode: 'immediate', scheduledAt: null });
    assert.equal(normalizePublishPlan({ mode: 'scheduled', scheduledAt: '2026-11-19T02:00:00.000Z' }, now).scheduledAt?.toISOString(), '2026-11-19T02:00:00.000Z');
    // 立即发布不接受定时时间；已过去的时间、超过一年、没有时区标记的时间一律拒绝。
    assert.throws(() => normalizePublishPlan({ mode: 'immediate', scheduledAt: '2026-11-19T02:00:00.000Z' }, now), ContentRuleError);
    assert.throws(() => normalizePublishPlan({ mode: 'scheduled', scheduledAt: '2026-11-18T09:59:00.000Z' }, now), (error) => error instanceof ContentRuleError && error.code === 'SCHEDULE_IN_PAST');
    assert.throws(() => normalizePublishPlan({ mode: 'scheduled', scheduledAt: '2028-11-19T02:00:00.000Z' }, now), (error) => error instanceof ContentRuleError && error.code === 'SCHEDULE_TOO_FAR');
    assert.throws(() => normalizePublishPlan({ mode: 'scheduled', scheduledAt: '2026-11-19 02:00' }, now), ContentRuleError);
    const translations = normalizePageTranslations(LOCALES.map(locale => translation(locale, `about-${locale.toLowerCase()}`)), LOCALES);
    const blocks = normalizeBlocks([{ id: 'intro', type: 'faq_list', visible: true, position: 0,
            config: { items: [{ question: '問', answer: '答' }] } }]);
    const snapshot = pageSnapshot('about', 'standard', translations, blocks);
    // 快照是冻结副本：之后修改传入数组不会改变已生成的快照。
    blocks[0].config['items'] = [];
    assert.equal(snapshot.blocks[0].config['items'].length, 1);
    assert.deepEqual(snapshot.translations.map(item => item.locale), ['en', 'zh-CN', 'zh-HK']);
});
test('content: release token and version numbers only move forward', { timeout: 20_000 }, () => {
    assert.equal(contentReleaseToken(0), 'cr-0');
    assert.equal(contentReleaseToken(42), 'cr-42');
    assert.match(contentReleaseToken(7), /^cr-[0-9]+$/);
    assert.throws(() => contentReleaseToken(-1), ContentRuleError);
    // 回滚也要建新版本：新版本号必须大于草稿版本与已发布版本。
    assert.equal(nextVersion(3, 2), 4);
    assert.equal(nextVersion(2, 5), 6);
    assert.equal(nextVersion(0, 0), 1);
});
