/**
 * 站点支付环境。
 *
 * 只认 `PAYMENTS_ENVIRONMENT`，未配置即生产——**不看 `NODE_ENV`**。
 * 起因：密钥解析器曾用 `NODE_ENV` 判定，而 staging 为了生产级校验保留 `NODE_ENV=production`，
 * 于是站点声明 sandbox、解析器却按生产禁用 `secret://env/`，沙箱渠道一条也起不来。
 * 两者必须来自同一个开关，否则"环境"在系统里就有两个互相矛盾的定义。
 */
export type PaymentEnvironment = 'sandbox' | 'production';

export function paymentEnvironment(env: NodeJS.ProcessEnv = process.env): PaymentEnvironment {
  return env['PAYMENTS_ENVIRONMENT'] === 'sandbox' ? 'sandbox' : 'production';
}
