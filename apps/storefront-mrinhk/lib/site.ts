// IN先生 店铺配置（mrinhk.com 实例）
// 只放「实例相关的固定值」：品牌、联系方式、市场、发布标记。
// 文案不在这个文件里——三语在 lib/i18n.ts，避免同一个句子出现两个来源。

export const site = {
  domain: 'mrinhk.com',
  brand: 'IN先生',
  brandLatin: 'Mr. IN',
  tagline: '心を込めて、凡事認真。',
  whatsappNumber: '60474794',
  whatsappIntl: '85260474794', // 香港 852 + 8 位号码；如非香港号码请修改
  whatsappGreeting: '你好，想向你查詢詳情',
  /** 结账市场（报价必传 marketCode），与后台 store-config 的市场码一致 */
  marketCode: 'HK',
  /** 内容发布版本标记：区块埋点随事件上报，用于按版本对比陈列效果（改版时更新） */
  // 已改由内容 CMS 提供（cr-N，见 lib/content.ts）：写死常量会让报表把两代内容并成一组。
  /** 政策同意：上线前应替换为真实政策的最新版本号；文案按语言在 i18n 里 */
  policies: [{ policyKey: 'terms-of-service', version: 'demo-v1' }],
} as const;

export const whatsappLink = `https://wa.me/${site.whatsappIntl}?text=${encodeURIComponent(site.whatsappGreeting)}`;
