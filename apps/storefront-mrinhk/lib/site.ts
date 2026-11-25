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

/** 香港本地固话/手机都是 8 位；换成其他市场时改这两个值与默认号码。 */
const HK_COUNTRY_CODE = '852';
const HK_LOCAL_DIGITS = 8;

/**
 * wa.me 只认 E.164（带国家码）的号码。
 *
 * 主题配置里的 `whatsappNumber` 可能是本地 8 位写法（60474794），直接拼进 wa.me 会打开
 * 一个无效对话——前台页头用国际码、首页 Hero 用本地码，两者会指向不同链接。这里统一补齐
 * 香港区号；已经是国际号码的原样使用，配置坏了也不至于拼出半个号码。
 */
export function whatsappHref(number: string | undefined, greeting: string): string {
  // 号码缺失或写坏时退回实例配置的国际码：宁可指向客服号，也不要给出一个空号码的链接。
  const digits = (number || site.whatsappIntl).replace(/\D/g, '');
  const e164 = digits.length === HK_LOCAL_DIGITS ? `${HK_COUNTRY_CODE}${digits}` : digits;
  return `https://wa.me/${e164}?text=${encodeURIComponent(greeting)}`;
}

export const whatsappLink = whatsappHref(site.whatsappIntl, site.whatsappGreeting);
