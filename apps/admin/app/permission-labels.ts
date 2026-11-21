/**
 * 权限码的中文说明与业务分组。
 *
 * 权限码本身是给服务端看的闭集（见 openapi.yaml 的 x-permission），
 * 但店员在勾权限时必须看到“这条权限能做什么”。分组顺序按日常动作排：
 * 订单 → 售后 → 商品 → 库存 → 顾客 → 营销 → 钱 → 店铺。
 */
export type PermissionItem = { code: string; label: string };
export type PermissionGroup = { title: string; items: PermissionItem[] };

export const PERMISSION_GROUPS: PermissionGroup[] = [
  { title: '订单与履约', items: [
    { code: 'orders.read', label: '查看订单' },
    { code: 'orders.update', label: '改订单与内部备注' },
    { code: 'orders.cancel', label: '取消未付款订单' },
    { code: 'orders.address_change', label: '改收货地址（未发货）' },
    { code: 'shipments.manage', label: '建包裹、发货、登记签收' },
  ] },
  { title: '售后与退款', items: [
    { code: 'aftersales.read', label: '查看售后案件' },
    { code: 'aftersales.manage', label: '受理与处理售后' },
    { code: 'aftersales.approve', label: '审批售后（含取消订单）' },
    { code: 'aftersales.inspect', label: '售后验货' },
    { code: 'refunds.create', label: '发起退款' },
    { code: 'refund.approve', label: '审批退款' },
    { code: 'refund.execute', label: '执行退款' },
  ] },
  { title: '商品与内容', items: [
    { code: 'catalog.read', label: '查看商品' },
    { code: 'catalog.write', label: '新建与编辑商品' },
    { code: 'catalog.publish', label: '上架与下架' },
    { code: 'catalog.import', label: '批量导入商品' },
    { code: 'media.manage', label: '媒体库' },
    { code: 'content.read', label: '查看内容页' },
    { code: 'content.write', label: '编辑内容页' },
    { code: 'content.preview', label: '预览草稿' },
    { code: 'content.publish', label: '发布内容' },
  ] },
  { title: '库存', items: [
    { code: 'inventory.read', label: '查看库存' },
    { code: 'inventory.adjust', label: '调整库存数量' },
    { code: 'inventory.manage', label: '库存与预警阈值设置' },
  ] },
  { title: '顾客与隐私', items: [
    { code: 'customers.read_masked', label: '查看脱敏顾客资料' },
    { code: 'customers.read_pii', label: '查看完整顾客资料（含联系方式）' },
    { code: 'customers.manage', label: '维护顾客资料' },
    { code: 'members.manage', label: '会员与积分' },
    { code: 'points.adjust', label: '调整积分' },
    { code: 'privacy.read', label: '查看资料请求' },
    { code: 'privacy.process', label: '处理资料请求' },
    { code: 'privacy.verify', label: '核验请求人身份' },
    { code: 'privacy.manage', label: '隐私流程设置' },
    { code: 'data.export', label: '导出数据' },
  ] },
  { title: '营销', items: [
    { code: 'coupons.read', label: '查看优惠券' },
    { code: 'coupons.manage', label: '创建与管理优惠券' },
    { code: 'coupons.issue', label: '补发优惠券' },
  ] },
  { title: '收款与报表', items: [
    { code: 'payments.read', label: '查看付款台账' },
    { code: 'payments.collect', label: '登记收款结果' },
    { code: 'payments.reconcile', label: '对账' },
    { code: 'payment.config', label: '支付渠道配置' },
    { code: 'reports.view', label: '查看报表' },
    { code: 'reports.export', label: '导出报表' },
  ] },
  { title: '配送与通知', items: [
    { code: 'shipping.manage', label: '配送方式与运费' },
    { code: 'notifications.read', label: '查看通知' },
    { code: 'notifications.manage', label: '通知设置' },
    { code: 'notifications.retry', label: '重发通知' },
  ] },
  { title: '店铺与系统', items: [
    { code: 'store.settings.manage', label: '店铺设置' },
    { code: 'staff.read', label: '查看员工' },
    { code: 'staff.manage', label: '增删改员工' },
    { code: 'roles.manage', label: '角色与权限分配' },
    { code: 'audit.read', label: '查看审计记录' },
    { code: 'operations.health.read', label: '系统健康检查' },
    { code: 'instance.backup', label: '实例备份' },
  ] },
];

const LABELS = new Map(PERMISSION_GROUPS.flatMap(group => group.items.map(item => [item.code, item.label] as const)));

/** 权限码不在表里时退回原码：宁可露出机器值，也不能把不认识的权限藏起来。 */
export function permissionLabel(code: string) {
  return LABELS.get(code) ?? code;
}

/** 只列调用者自己拥有、并且表里认得的项；未知权限码仍会出现在“其他”分组里。 */
export function visibleGroups(codes: string[]) {
  const known = new Set(LABELS.keys());
  const groups = PERMISSION_GROUPS
    .map(group => ({ ...group, items: group.items.filter(item => codes.includes(item.code)) }))
    .filter(group => group.items.length);
  const others = codes.filter(code => !known.has(code));
  if (others.length) groups.push({ title: '其他权限', items: others.map(code => ({ code, label: code })) });
  return groups;
}
