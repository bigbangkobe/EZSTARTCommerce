/**
 * 订单（M07）领域规则。
 *
 * 这里只做判定与规范化，不碰数据库：状态机、包裹数量累计、改址金额不变量、
 * 联系方式遮蔽都在纯函数里，HTTP 层只负责把结果映射成状态码。
 * 关键原则：状态只能由显式 action 推进，任何入口都不接受“直接把 orderStatus 改掉”。
 */
export class OrderRuleError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
const fail = (code) => {
    throw new OrderRuleError(code);
};
/** 控制字符（保留 \t \n \r）：备注与原因要能安全进日志与邮件。 */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const REASON_CODE = /^[a-z0-9][a-z0-9_]{0,79}$/;
const SHIPPED_STATUSES = new Set(['shipped', 'partially_shipped', 'completed']);
const CANCELLABLE = new Set(['pending_payment', 'awaiting_confirmation', 'confirmed', 'processing', 'on_hold']);
const SHIPPABLE = new Set(['awaiting_confirmation', 'confirmed', 'processing', 'partially_shipped']);
/** 遮蔽后的联系方式：`a***@example.com` / `***1234` / `陈**`。 */
export function maskContact(contact) {
    return {
        email: contact.email === null || contact.email === undefined ? null : maskEmail(contact.email),
        phone: contact.phone === null || contact.phone === undefined ? null : maskPhone(contact.phone),
        fullName: contact.fullName === null || contact.fullName === undefined ? null : maskName(contact.fullName),
    };
}
export function maskEmail(value) {
    const at = value.lastIndexOf('@');
    if (at <= 0)
        return '***';
    const local = value.slice(0, at);
    return `${local.slice(0, 1)}***@${value.slice(at + 1)}`;
}
export function maskPhone(value) {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 4)
        return '***';
    return `***${digits.slice(-4)}`;
}
export function maskName(value) {
    const name = value.trim();
    if (!name.length)
        return '***';
    const first = Array.from(name)[0];
    return `${first}**`;
}
/** If-Match 语义的版本核对；不匹配就是别人先改过了。 */
export function assertVersion(expected, actual) {
    if (!Number.isSafeInteger(expected) || expected < 1)
        fail('VALIDATION_ERROR');
    if (expected !== actual)
        fail('VERSION_CONFLICT');
}
/** 已收款订单不能靠取消接口清账：必须走售后退款流程。 */
export function assertCancellable(orderStatus, paymentStatus) {
    if (paymentStatus === 'succeeded' || paymentStatus === 'collected')
        fail('PAID_ORDER_REQUIRES_REFUND');
    if (orderStatus === 'cancelled')
        fail('ORDER_ALREADY_CANCELLED');
    if (SHIPPED_STATUSES.has(orderStatus))
        fail('ORDER_ALREADY_SHIPPED');
    if (!CANCELLABLE.has(orderStatus))
        fail('STATE_CONFLICT');
}
/** 地址只能在未发货前修改；一旦有任何包裹离开仓库，就只能走承运商人工记录。 */
export function assertAddressChangeable(orderStatus, fulfillmentStatus) {
    if (orderStatus === 'cancelled')
        fail('ORDER_ALREADY_CANCELLED');
    if (fulfillmentStatus !== 'unfulfilled' || SHIPPED_STATUSES.has(orderStatus))
        fail('ORDER_ALREADY_SHIPPED');
    if (!CANCELLABLE.has(orderStatus))
        fail('STATE_CONFLICT');
}
export function assertShipmentCreatable(orderStatus) {
    if (orderStatus === 'cancelled')
        fail('ORDER_ALREADY_CANCELLED');
    if (orderStatus === 'completed')
        fail('STATE_CONFLICT');
    if (!SHIPPABLE.has(orderStatus))
        fail('STATE_CONFLICT');
}
export function assertShipmentDispatch(status) {
    if (status === 'dispatched')
        fail('SHIPMENT_ALREADY_DISPATCHED');
    if (status === 'delivered')
        fail('SHIPMENT_ALREADY_DELIVERED');
    if (status === 'cancelled')
        fail('SHIPMENT_CANCELLED');
    if (status !== 'created')
        fail('STATE_CONFLICT');
}
export function assertShipmentDeliver(status) {
    if (status === 'created')
        fail('SHIPMENT_NOT_DISPATCHED');
    if (status === 'delivered')
        fail('SHIPMENT_ALREADY_DELIVERED');
    if (status === 'cancelled')
        fail('SHIPMENT_CANCELLED');
    if (status !== 'dispatched')
        fail('STATE_CONFLICT');
}
/** 全部包裹都发出才算 shipped，否则 partially_shipped。 */
export function orderStatusAfterDispatch(shippedAll) {
    return shippedAll ? 'shipped' : 'partially_shipped';
}
export function fulfillmentAfterDispatch(shippedAll) {
    return shippedAll ? 'fulfilled' : 'partially_fulfilled';
}
/**
 * 包裹行分配：同一订单行可以在多个包裹里分批发出，但累计不得超过订购量。
 * `shipped` 只统计未取消包裹（含尚未发货的包裹），避免先建两个包裹把数量撑爆。
 */
export function allocateShipment(items, shipped, requested) {
    if (!Array.isArray(requested) || !requested.length)
        fail('VALIDATION_ERROR');
    if (requested.length > 200)
        fail('VALIDATION_ERROR');
    const seen = new Set();
    return requested.map(line => {
        if (!line || typeof line.orderItemId !== 'string' || !line.orderItemId.length)
            fail('VALIDATION_ERROR');
        if (seen.has(line.orderItemId))
            fail('VALIDATION_ERROR');
        seen.add(line.orderItemId);
        const item = items.find(entry => entry.id === line.orderItemId) ?? fail('VALIDATION_ERROR');
        if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99)
            fail('VALIDATION_ERROR');
        // 超过订单行总量是输入永远不可能合法的（422）；只是在“已分配”之上超发才是状态冲突（409）。
        if (line.quantity > item.quantity)
            fail('VALIDATION_ERROR');
        const remaining = item.quantity - (shipped.get(item.id) ?? 0);
        if (line.quantity > remaining)
            fail('SHIPMENT_QUANTITY_EXCEEDED');
        return { orderItemId: item.id, quantity: line.quantity };
    });
}
/** 备注只允许内部内容，长度与字符集先收口，避免把整段 HTML 存进数据库再渲染。 */
export function normalizeNote(value) {
    const note = (value ?? '').trim();
    if (!note.length || note.length > 1_000 || CONTROL.test(note))
        fail('VALIDATION_ERROR');
    return note;
}
export function normalizeCancel(input) {
    const reason = (input.reason ?? '').trim();
    if (!reason.length || reason.length > 1_000 || CONTROL.test(reason))
        fail('VALIDATION_ERROR');
    const code = input.reasonCode === undefined || input.reasonCode === null ? null : input.reasonCode.trim();
    if (code !== null && !REASON_CODE.test(code))
        fail('VALIDATION_ERROR');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
        fail('VALIDATION_ERROR');
    if (input.customerNotified !== undefined && typeof input.customerNotified !== 'boolean')
        fail('VALIDATION_ERROR');
    return { reasonCode: code, reason, expectedVersion: input.expectedVersion,
        customerNotified: input.customerNotified ?? false };
}
/** 改址后重算总额：运费变了，总额必须跟着变，且不允许出现负数。 */
export function repriceShipping(order, shippingMinor) {
    if (!Number.isInteger(shippingMinor) || shippingMinor < 0)
        fail('VALIDATION_ERROR');
    const totalMinor = order.subtotalMinor - order.discountMinor + shippingMinor + order.taxMinor;
    if (!Number.isSafeInteger(totalMinor) || totalMinor < 0)
        fail('VALIDATION_ERROR');
    return { shippingMinor, totalMinor };
}
/** 费用发生变化时，必须有顾客确认依据；否则等于后台替顾客多收钱。 */
export function assertAddressChangeConfirmed(before, after, reference) {
    if (before === after)
        return;
    const ref = (reference ?? '').trim();
    if (!ref.length)
        fail('CUSTOMER_CONFIRMATION_REQUIRED');
    if (ref.length > 200 || CONTROL.test(ref))
        fail('VALIDATION_ERROR');
}
/** 顾客确认依据的通用规范化（改址等费用变动场景）。 */
export function normalizeConfirmationRef(value) {
    if (value === undefined || value === null)
        return null;
    const ref = value.trim();
    if (!ref.length)
        return null;
    if (ref.length > 200 || CONTROL.test(ref))
        fail('VALIDATION_ERROR');
    return ref;
}
