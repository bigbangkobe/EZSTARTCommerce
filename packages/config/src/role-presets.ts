/**
 * 默认岗位权限包。
 *
 * 权限矩阵的权威来源是 docs/DEVELOPMENT_SPEC.md 第 7.1 节；本文件是它在代码里的
 * 唯一投影，服务启动时按此创建缺失的预设角色。权限码本身仍以 OpenAPI 契约为闭集：
 * 任一预设引用了契约里不存在的权限码，启动就会失败，而不是静默少给或错给权限。
 *
 * 预设只是“初始授权”，不是不可变策略：拥有 roles.manage 的角色管理者可以增减权限，
 * 但只能授予自己拥有的权限（见 IdentityService.grantable）。owner 角色例外，
 * 由系统维护为全部权限且不可编辑。
 */
export type RolePresetKind = 'owner' | 'admin' | 'preset';

export interface RolePreset {
  /** 稳定标识，写入 AdminRole.presetKey，角色改名后仍能识别。 */
  readonly key: string;
  readonly name: string;
  readonly kind: RolePresetKind;
  readonly description: string;
  /** 'all' 表示始终等于当前契约里的全部权限码（仅 owner）。 */
  readonly permissions: readonly string[] | 'all';
}

const catalog = ['catalog.read', 'catalog.write', 'catalog.publish', 'catalog.import', 'media.manage'];
const content = ['content.read', 'content.write', 'content.preview', 'content.publish'];
const orders = ['orders.read', 'orders.update', 'orders.cancel', 'orders.address_change', 'shipments.manage'];
const inventory = ['inventory.read', 'inventory.adjust', 'inventory.manage'];
const notifications = ['notifications.read', 'notifications.manage', 'notifications.retry'];
const coupons = ['coupons.read', 'coupons.manage', 'coupons.issue'];
const aftersales = ['aftersales.read', 'aftersales.manage', 'aftersales.approve', 'aftersales.inspect'];

export const rolePresets: readonly RolePreset[] = [
  {
    key: 'owner', name: 'Owner', kind: 'owner', permissions: 'all',
    description: '店主：全部业务操作、角色管理与付款配置；审计记录只读，不可改写。',
  },
  {
    key: 'admin', name: '管理员', kind: 'admin',
    permissions: [
      ...catalog, ...content, ...orders, ...inventory, ...notifications, ...coupons, ...aftersales,
      'customers.read_masked', 'customers.manage', 'members.manage', 'points.adjust',
      'payments.read', 'payments.collect', 'payments.reconcile', 'shipping.manage', 'reports.view', 'reports.export',
      'store.settings.manage', 'operations.health.read',
    ],
    description: '管理员：商品、内容、订单、库存、顾客日常管理与店铺设置；不含员工/角色、付款配置、退款、隐私导出与实例级操作。',
  },
  {
    key: 'product_ops', name: '商品运营', kind: 'preset',
    permissions: [...catalog, 'content.read', 'content.write', 'content.preview', 'inventory.read', 'reports.view'],
    description: '商品运营：商品、分类、媒体、导入与内容草稿；不能查看完整订单顾客资料、付款凭证，也不能执行退款。',
  },
  {
    key: 'order_support', name: '订单客服', kind: 'preset',
    permissions: [...orders, 'catalog.read', 'customers.read_masked', 'aftersales.read', 'aftersales.manage',
      'aftersales.inspect', 'notifications.read', 'reports.view'],
    description: '订单客服：订单、未发货地址修改、配送与售后案件受理；只读脱敏顾客资料，售后审批、退款审批与执行需另行授权。',
  },
  {
    key: 'finance', name: '财务', kind: 'preset',
    permissions: ['orders.read', 'payments.read', 'payments.collect', 'payments.reconcile', 'refunds.create', 'refund.approve',
      'refund.execute', 'reports.view', 'reports.export'],
    description: '财务：收款登记、付款、退款审批与执行、对账与财务报表导出；默认不改商品、库存和支付凭证配置。',
  },
  {
    key: 'warehouse', name: '仓库', kind: 'preset',
    permissions: ['orders.read', 'shipments.manage', 'inventory.read', 'inventory.adjust', 'aftersales.inspect', 'catalog.read'],
    description: '仓库：受限订单与商品信息、包裹发货、库存调整与收货质检；无顾客完整档案、退款或支付设置。',
  },
  {
    key: 'reports_readonly', name: '报表只读', kind: 'preset',
    permissions: ['reports.view'],
    description: '报表只读：仅获准的聚合报表；不读顾客/订单明细，不导出 PII。',
  },
  {
    key: 'privacy_specialist', name: '隐私专员', kind: 'preset',
    permissions: ['privacy.read', 'privacy.verify', 'privacy.process', 'customers.read_masked'],
    description: '隐私专员：身份核验、请求队列与更正/匿名化处理；审批与导出分权限，不能审批自己处理的请求。',
  },
];

/** 某预设在某份权限码闭集下应获得的权限；owner 始终等于全部权限码。 */
export function presetPermissions(preset: RolePreset, knownCodes: readonly string[]): string[] {
  if (preset.permissions === 'all') return [...new Set(knownCodes)].sort();
  return [...new Set(preset.permissions)].sort();
}

/**
 * 校验预设只引用契约已登记的权限码。启动时调用，返回解析后的角色定义。
 * 引用未知权限码属于契约漂移（拼写错误或权限码已改名），必须直接失败。
 */
export function resolveRolePresets(knownCodes: readonly string[]): { key: string; name: string; kind: RolePresetKind;
  description: string; permissionCodes: string[] }[] {
  const known = new Set(knownCodes);
  if (!known.size) throw new Error('Permission catalog is empty');
  return rolePresets.map(preset => {
    const codes = presetPermissions(preset, knownCodes);
    const unknown = codes.filter(code => !known.has(code));
    if (unknown.length) throw new Error(`Role preset ${preset.key} references unknown permission codes: ${unknown.join(', ')}`);
    if (!codes.length) throw new Error(`Role preset ${preset.key} grants no permission`);
    return { key: preset.key, name: preset.name, kind: preset.kind, description: preset.description, permissionCodes: codes };
  });
}
