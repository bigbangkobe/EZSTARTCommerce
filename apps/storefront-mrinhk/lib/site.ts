// IN先生 店铺配置（mrinhk.com 实例）
// 品牌与文案均集中在此，后续接后台 CMS 后逐步由后台配置替代。

export const site = {
  domain: 'mrinhk.com',
  brand: 'IN先生',
  brandLatin: 'Mr. IN',
  tagline: '心を込めて、凡事認真。',
  whatsappNumber: '60474794',
  whatsappIntl: '85260474794', // 香港 852 + 8 位号码；如非香港号码请修改
  whatsappGreeting: '你好，想向你查詢詳情',
  languages: ['zh-Hant', 'zh-Hans', 'en'],
  defaultLanguage: 'zh-Hant',
} as const;

export const whatsappLink = `https://wa.me/${site.whatsappIntl}?text=${encodeURIComponent(site.whatsappGreeting)}`;

export const copy = {
  nav: { about: '關於', products: '商品', contact: '聯絡' },
  hero: {
    title1: '心を込めて、',
    title2: '凡事認真。',
    sub: '以日式職人精神對待每一件事。想了解更多？透過 WhatsApp 與我聯繫，我會盡快回覆。',
    ctaPrimary: 'WhatsApp 聯絡',
    ctaSecondary: '瀏覽商品',
    vertical: '一期一会',
  },
  about: {
    heading: '關於 IN先生',
    jp: 'ご挨拶',
    cards: [
      { glyph: '誠', title: '誠實可靠', body: '以誠待人，承諾必達。每一次合作都建立於信任之上。' },
      { glyph: '職', title: '職人精神', body: '注重細節，追求極致。凡事親力親為，絕不馬虎。' },
      { glyph: '速', title: '迅速回應', body: 'WhatsApp 直接聯繫，快速回覆，讓溝通簡單高效。' },
    ],
  },
  products: {
    heading: '商品',
    jp: '商品のご案内',
    empty: '商品正在籌備中，歡迎先透過 WhatsApp 查詢。',
    error: '商品暫時無法載入，請稍後再試，或直接透過 WhatsApp 查詢。',
    currency: 'HK$',
    inquiry: 'WhatsApp 查詢',
  },
  contact: {
    heading: '與我聯繫',
    jp: 'お問い合わせ',
    label: 'WhatsApp 聯絡',
    hint: '與我聯繫以獲取詳情',
    cta: '立即 WhatsApp',
  },
  footer: { rights: '版權所有' },
} as const;
