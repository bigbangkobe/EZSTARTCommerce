// 主题配置数据获取：读已发布的店铺主题快照。
// 对应接口：GET /api/v1/storefront/theme（envelope: { data, meta }）
// 契约见 packages/contracts/openapi.yaml 的 getStorefrontTheme。
//
// 关键事实：接口只返回**已发布快照**，未发布时 404。任何异常（未配置、接口不可达、
// 快照损坏）都返回 null，由调用方用内置默认主题兜底——配置永远不是单点故障：
// 换主题配错了也不能把首页打空。

const apiBase = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001';

export type ThemeSection = {
  type:
    | 'hero'
    | 'about'
    | 'category_grid'
    | 'promises'
    | 'product_grid'
    | 'rich_text'
    | 'faq'
    | 'content_card';
  params?: Record<string, string | number | boolean>;
};

export type ThemeTokens = {
  primaryColor: string;
  inkColor: string;
  paperColor: string;
  fontPair: string;
  radius: number;
};

export type ThemeBrand = {
  name: string;
  brandLatin?: string;
  tagline?: string;
  whatsappNumber?: string;
  whatsappGreeting?: string;
};

export type StoreTheme = {
  version: number;
  brand: ThemeBrand;
  tokens: ThemeTokens;
  navigation?: string[];
  homeSections: ThemeSection[];
};

type Envelope<T> = { data?: T };
type ThemeResponse = { version?: number; config?: StoreTheme };

/** 读取已发布主题。未发布/异常返回 null——调用方据此回退默认主题。 */
export async function fetchTheme(): Promise<StoreTheme | null> {
  try {
    const res = await fetch(`${apiBase}/api/v1/storefront/theme`, { next: { revalidate: 30 } });
    if (!res.ok) return null; // 404 未发布、5xx 异常都按未配置处理
    const body = (await res.json()) as Envelope<ThemeResponse>;
    const payload = body.data;
    if (!payload?.config) return null;
    const config = payload.config;
    // 最小结构校验：缺关键字段就当未配置，不把半截数据送进渲染。
    if (!config.brand?.name || !config.tokens?.primaryColor || !Array.isArray(config.homeSections)) return null;
    return { ...config, version: payload.version ?? 1 };
  } catch {
    return null;
  }
}

/** 把 tokens 转成可在服务端注入的 CSS 变量（颜色已在领域层白名单校验，此处直接用）。 */
export function themeCssVariables(theme: StoreTheme): Record<string, string> {
  return {
    '--red': theme.tokens.primaryColor,
    '--ink': theme.tokens.inkColor,
    '--paper': theme.tokens.paperColor,
    '--radius': `${theme.tokens.radius}px`,
  };
}
