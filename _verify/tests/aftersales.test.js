import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AfterSalesRuleError, allocateLineAmount, approvedAmount, assertCancelCaseOrder, assertCaseAction, assertCaseRefundable, assertInspectionQuantity, assertRefundablePayment, assertRefundWithinBalance, caseNumber, normalizeCaseLines, normalizeReason, nextRefundStatus, refundableBalance, refundNumber, refundTransitionFromProvider, restocksStock, statusAfterAction, } from '../packages/domain/src/aftersales.js';
const code = (fn) => {
    try {
        fn();
    }
    catch (error) {
        return error instanceof AfterSalesRuleError ? error.code : 'OTHER';
    }
    return 'NO_ERROR';
};
const lines = [{ id: 'line-1', quantity: 3 }, { id: 'line-2', quantity: 1 }];
test('case lines cannot exceed what is left after other live cases', () => {
    assert.deepEqual(normalizeCaseLines(lines, new Map(), [{ orderItemId: 'line-1', quantity: 2 }]), [{ orderItemId: 'line-1', quantity: 2 }]);
    // 第二件案件的累计量受第一件影响：3 件里已经申请 2 件，就只剩 1 件。
    assert.deepEqual(normalizeCaseLines(lines, new Map([['line-1', 2]]), [{ orderItemId: 'line-1', quantity: 1 }]), [{ orderItemId: 'line-1', quantity: 1 }]);
    assert.equal(code(() => normalizeCaseLines(lines, new Map([['line-1', 2]]), [{ orderItemId: 'line-1', quantity: 2 }])), 'CASE_QUANTITY_EXCEEDED');
    assert.equal(code(() => normalizeCaseLines(lines, new Map(), [{ orderItemId: 'nope', quantity: 1 }])), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeCaseLines(lines, new Map(), [{ orderItemId: 'line-1', quantity: 1 },
        { orderItemId: 'line-1', quantity: 1 }])), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeCaseLines(lines, new Map(), [{ orderItemId: 'line-1', quantity: 0 }])), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeCaseLines(lines, new Map(), [])), 'VALIDATION_ERROR');
});
test('amount allocation floors instead of rounding money up', () => {
    // 100.00 分三件、退两件 → 66.66，向下取整到 6666 分，平台不多退一分。
    assert.equal(allocateLineAmount(10_000, 3, 2), 6_666);
    assert.equal(allocateLineAmount(10_000, 3, 3), 10_000);
    assert.equal(allocateLineAmount(0, 3, 1), 0);
    assert.equal(code(() => allocateLineAmount(10_000, 3, 4)), 'VALIDATION_ERROR');
    assert.equal(code(() => allocateLineAmount(-1, 3, 1)), 'VALIDATION_ERROR');
});
test('refundable balance is settled money minus refunded and in-flight amounts', () => {
    assert.equal(refundableBalance({ collectedMinor: 23_000, refundedMinor: 3_000, pendingMinor: 0 }), 20_000);
    assert.equal(refundableBalance({ collectedMinor: 23_000, refundedMinor: 23_000, pendingMinor: 5_000 }), 0);
    assert.equal(code(() => assertRefundWithinBalance({ availableMinor: 20_000, amountMinor: 20_001,
        currency: 'HKD', orderCurrency: 'HKD' })), 'REFUND_EXCEEDS_BALANCE');
    assert.equal(code(() => assertRefundWithinBalance({ availableMinor: 20_000, amountMinor: 1_000,
        currency: 'USD', orderCurrency: 'HKD' })), 'REFUND_CURRENCY_MISMATCH');
    assert.equal(code(() => assertRefundWithinBalance({ availableMinor: 20_000, amountMinor: 0,
        currency: 'HKD', orderCurrency: 'HKD' })), 'VALIDATION_ERROR');
    assert.equal(code(() => assertRefundWithinBalance({ availableMinor: 0, amountMinor: 1,
        currency: 'HKD', orderCurrency: 'HKD' })), 'REFUND_EXCEEDS_BALANCE');
});
test('only settled money can be refunded', () => {
    assert.equal(code(() => assertRefundablePayment('collected')), 'NO_ERROR');
    assert.equal(code(() => assertRefundablePayment('succeeded')), 'NO_ERROR');
    // COD 未收款、待收、拒收都没有“已收金额”，不能凭空退款。
    for (const status of ['pending', 'authorized', 'rejected', 'cancelled', 'failed', 'unknown']) {
        assert.equal(code(() => assertRefundablePayment(status)), 'NOTHING_TO_REFUND', status);
    }
    assert.equal(code(() => assertRefundablePayment('returned')), 'PAYMENT_ALREADY_RETURNED');
});
test('cancellation cases only fit unshipped, unpaid orders', () => {
    assert.equal(code(() => assertCancelCaseOrder({ orderStatus: 'awaiting_confirmation', paymentStatus: 'cod_due' })), 'NO_ERROR');
    assert.equal(code(() => assertCancelCaseOrder({ orderStatus: 'confirmed', paymentStatus: 'created' })), 'NO_ERROR');
    assert.equal(code(() => assertCancelCaseOrder({ orderStatus: 'shipped', paymentStatus: 'cod_due' })), 'ORDER_ALREADY_SHIPPED');
    assert.equal(code(() => assertCancelCaseOrder({ orderStatus: 'completed', paymentStatus: 'collected' })), 'PAID_ORDER_REQUIRES_REFUND');
    assert.equal(code(() => assertCancelCaseOrder({ orderStatus: 'cancelled', paymentStatus: 'cod_due' })), 'ORDER_ALREADY_CANCELLED');
});
test('case actions follow the documented forward-only timeline', () => {
    assert.equal(code(() => assertCaseAction('submitted', 'approve')), 'NO_ERROR');
    assert.equal(code(() => assertCaseAction('under_review', 'reject')), 'NO_ERROR');
    assert.equal(code(() => assertCaseAction('approved', 'dispatch_return')), 'NO_ERROR');
    assert.equal(code(() => assertCaseAction('return_in_transit', 'receive_return')), 'NO_ERROR');
    assert.equal(code(() => assertCaseAction('received_inspection', 'inspect')), 'NO_ERROR');
    assert.equal(code(() => assertCaseAction('approved', 'request_refund')), 'NO_ERROR');
    assert.equal(code(() => assertCaseAction('refund_pending', 'refund_settled')), 'NO_ERROR');
    assert.equal(code(() => assertCaseAction('refunded', 'close')), 'NO_ERROR');
    // 不能跳步：没批准就收货、没质检就关案、已关案再批准，都必须拒绝。
    assert.equal(code(() => assertCaseAction('submitted', 'receive_return')), 'CASE_STATE_CONFLICT');
    assert.equal(code(() => assertCaseAction('approved', 'inspect')), 'CASE_STATE_CONFLICT');
    assert.equal(code(() => assertCaseAction('completed', 'approve')), 'CASE_STATE_CONFLICT');
    assert.equal(statusAfterAction('receive_return'), 'received_inspection');
    assert.equal(statusAfterAction('close'), 'completed');
});
test('refund state machine only moves forward and never guesses for unknown', () => {
    assert.equal(nextRefundStatus('requested', 'approve'), 'approved');
    assert.equal(nextRefundStatus('requested', 'reject'), 'rejected');
    assert.equal(nextRefundStatus('approved', 'execute'), 'refunded');
    assert.equal(nextRefundStatus('failed', 'approve'), 'approved');
    assert.equal(code(() => nextRefundStatus('requested', 'execute')), 'REFUND_STATE_CONFLICT');
    assert.equal(code(() => nextRefundStatus('refunded', 'approve')), 'REFUND_STATE_CONFLICT');
    // 渠道没给结论时，后台不能把它改成成功或失败。
    assert.equal(code(() => nextRefundStatus('unknown', 'execute')), 'REFUND_STATUS_UNKNOWN_REQUIRES_PROVIDER');
    assert.equal(code(() => nextRefundStatus('unknown', 'approve')), 'REFUND_STATUS_UNKNOWN_REQUIRES_PROVIDER');
});
test('online refunds reserve a processing state before calling the provider', () => {
    // 先落 processing 再调渠道：崩溃后能靠这个状态判断"钱可能已经退出去了"。
    assert.equal(nextRefundStatus('approved', 'start'), 'processing');
    assert.equal(nextRefundStatus('processing', 'execute'), 'refunded');
    assert.equal(nextRefundStatus('processing', 'fail'), 'failed');
    assert.equal(nextRefundStatus('processing', 'mark_unknown'), 'unknown');
    // 线下渠道不该走 processing；已终态不能再发起。
    assert.equal(code(() => nextRefundStatus('refunded', 'start')), 'REFUND_STATE_CONFLICT');
    assert.equal(code(() => nextRefundStatus('cancelled', 'start')), 'REFUND_STATE_CONFLICT');
});
test('unknown refunds converge only with an explicit provider conclusion', () => {
    assert.equal(nextRefundStatus('unknown', 'resolve', 'refunded'), 'refunded');
    assert.equal(nextRefundStatus('unknown', 'resolve', 'failed'), 'failed');
    // resolve 是服务端专用出口：不给目标状态就拒绝，不让调用方"猜一个"。
    assert.equal(code(() => nextRefundStatus('unknown', 'resolve')), 'REFUND_STATE_CONFLICT');
    assert.equal(code(() => nextRefundStatus('unknown', 'resolve', 'unknown')), 'REFUND_STATE_CONFLICT');
    assert.equal(code(() => nextRefundStatus('processing', 'resolve', 'refunded')), 'REFUND_STATE_CONFLICT');
});
test('provider refund status maps to a transition, pending never counts as success', () => {
    assert.deepEqual(refundTransitionFromProvider('succeeded'), { action: 'execute' });
    assert.deepEqual(refundTransitionFromProvider('failed'), { action: 'fail' });
    // pending 不推进状态：没结论就是没结论。
    assert.equal(refundTransitionFromProvider('pending'), null);
});
test('approved amounts are capped by allocation and order total, never by the request alone', () => {
    const base = { orderTotalMinor: 23_000, currency: 'HKD', orderCurrency: 'HKD' };
    assert.equal(approvedAmount({ ...base, caseType: 'refund', requestedMinor: 5_000, allocatedMinor: 10_000 }), 5_000);
    assert.equal(approvedAmount({ ...base, caseType: 'return', requestedMinor: null, allocatedMinor: 10_000 }), 10_000);
    assert.equal(approvedAmount({ ...base, caseType: 'return', requestedMinor: 99_000, allocatedMinor: 10_000 }), 10_000);
    assert.equal(approvedAmount({ ...base, caseType: 'refund', requestedMinor: 99_000, allocatedMinor: 99_000 }), 23_000);
    // 取消与换货不产生支付退款。
    assert.equal(approvedAmount({ ...base, caseType: 'cancel', requestedMinor: 5_000, allocatedMinor: 10_000 }), 0);
    assert.equal(approvedAmount({ ...base, caseType: 'exchange', requestedMinor: 5_000, allocatedMinor: 10_000 }), 0);
});
test('inspection quantities cannot exceed what was received and not yet inspected', () => {
    assert.equal(code(() => assertInspectionQuantity(3, 0, 3)), 'NO_ERROR');
    assert.equal(code(() => assertInspectionQuantity(3, 2, 1)), 'NO_ERROR');
    assert.equal(code(() => assertInspectionQuantity(3, 2, 2)), 'INSPECTION_QUANTITY_EXCEEDED');
    assert.equal(code(() => assertInspectionQuantity(3, 0, 0)), 'VALIDATION_ERROR');
    assert.equal(restocksStock('sellable'), true);
    for (const disposition of ['damaged', 'quarantine', 'scrap'])
        assert.equal(restocksStock(disposition), false);
});
test('refund eligibility by case type and reason text normalisation', () => {
    assert.equal(code(() => assertCaseRefundable('refund', 'approved')), 'NO_ERROR');
    assert.equal(code(() => assertCaseRefundable('return', 'received_inspection')), 'NO_ERROR');
    assert.equal(code(() => assertCaseRefundable('cancel', 'approved')), 'CASE_NOT_REFUNDABLE');
    assert.equal(code(() => assertCaseRefundable('exchange', 'approved')), 'CASE_NOT_REFUNDABLE');
    assert.equal(code(() => assertCaseRefundable('refund', 'submitted')), 'CASE_NOT_APPROVED');
    assert.equal(normalizeReason('  broken item  '), 'broken item');
    assert.equal(code(() => normalizeReason('   ')), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeReason('a\u0000b')), 'VALIDATION_ERROR');
    assert.equal(caseNumber('20261116', 'AB12CD'), 'AS-20261116-AB12CD');
    assert.equal(refundNumber('20261116', 'AB12CD'), 'REF-20261116-AB12CD');
    assert.equal(code(() => caseNumber('2026-11-16', 'AB12CD')), 'VALIDATION_ERROR');
    assert.equal(code(() => refundNumber('20261116', 'ab12cd')), 'VALIDATION_ERROR');
});
