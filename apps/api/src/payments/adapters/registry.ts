/**
 * 支付适配器注册表。
 *
 * 一张表决定"哪些渠道真的能收钱"。约束：
 * 1. 只有在这里注册过的 code 才能被后台配置——后台配不出没有实现的渠道。
 * 2. mock 只在 sandbox 可用，生产环境解析直接拒绝，避免假支付混进真实订单。
 * 3. 注册是编译期的，不做运行时插件加载：能加载的代码就是能执行任意代码，
 *    支付链路上不接受这种自由度。
 */
import {
  type PaymentAdapter, PaymentAdapterError,
} from '../../../../../packages/domain/src/payment-adapter.js';
import { type PaymentChannel, providers as domainProviders } from '../../../../../packages/domain/src/payments.js';
import { MockPaymentAdapter } from './mock.js';

export interface AdapterRegistration {
  readonly adapter: PaymentAdapter;
  /** 仅沙箱可用：生产环境解析时直接拒绝。 */
  readonly sandboxOnly: boolean;
}

function fail(code: string, field?: string): never {
  throw new PaymentAdapterError(code, field);
}

const registry = new Map<string, AdapterRegistration>();

export function registerAdapter(adapter: PaymentAdapter, options: { sandboxOnly?: boolean } = {}): void {
  if (registry.has(adapter.code)) fail('ADAPTER_ALREADY_REGISTERED', adapter.code);
  // 必须与领域层白名单对齐，否则后台永远配不出这个渠道，注册了也是死代码。
  if (!domainProviders.some(entry => entry.code === adapter.code)) {
    fail('ADAPTER_NOT_IN_PROVIDER_WHITELIST', adapter.code);
  }
  registry.set(adapter.code, { adapter, sandboxOnly: options.sandboxOnly === true });
}

export function adapterFor(code: string, environment: 'sandbox' | 'production'): PaymentAdapter {
  const found = registry.get(code);
  if (!found) fail('ADAPTER_NOT_REGISTERED', code);
  if (found.sandboxOnly && environment === 'production') fail('ADAPTER_SANDBOX_ONLY', code);
  return found.adapter;
}

export function adapterCodes(environment?: 'sandbox' | 'production'): string[] {
  const entries = [...registry.entries()];
  const allowed = environment
    ? entries.filter(([, entry]) => !(entry.sandboxOnly && environment === 'production'))
    : entries;
  return allowed.map(([code]) => code).sort();
}

export function requireChannel(code: string): PaymentChannel {
  const found = domainProviders.find(entry => entry.code === code);
  if (!found) fail('UNSUPPORTED_PAYMENT_PROVIDER', code);
  return found.channel;
}

/** 幂等：重复调用不抛错，便于测试与热重载。 */
export function registerBuiltins(): void {
  if (!registry.has('mock')) registerAdapter(new MockPaymentAdapter(), { sandboxOnly: true });
}

registerBuiltins();
