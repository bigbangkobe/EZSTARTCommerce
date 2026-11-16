import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allocateShipment, assertAddressChangeConfirmed, assertAddressChangeable, assertCancellable,
  assertShipmentCreatable, assertShipmentDeliver, assertShipmentDispatch, assertVersion,
  fulfillmentAfterDispatch, maskContact, maskEmail, maskName, maskPhone, normalizeCancel,
  normalizeConfirmationRef, normalizeNote, orderStatusAfterDispatch, OrderRuleError, repriceShipping,
} from '../packages/domain/src/orders.js';

const code = (fn: () => unknown) => {
  try { fn(); } catch (error) { return error instanceof OrderRuleError ? error.code : 'OTHER'; }
  return 'NO_ERROR';
};

test('contact masking never leaks the full value', () => {
  assert.equal(maskEmail('buyer@example.com'), 'b***@example.com');
  assert.equal(maskEmail('a@b.co'), 'a***@b.co');
  assert.equal(maskEmail('not-an-email'), '***');
  assert.equal(maskPhone('+852 9123 4567'), '***4567');
  assert.equal(maskPhone('12'), '***');
  assert.equal(maskName('陳大文'), '陳**');
  assert.deepEqual(maskContact({ email: 'buyer@example.com', phone: '+85291234567', fullName: 'Buyer' }),
    { email: 'b***@example.com', phone: '***4567', fullName: 'B**' });
  assert.deepEqual(maskContact({ email: null, phone: null, fullName: null }), { email: null, phone: null, fullName: null });
});

test('cancel eligibility follows payment and fulfillment state', () => {
  assert.equal(code(() => assertCancellable('awaiting_confirmation', 'cod_due')), 'NO_ERROR');
  assert.equal(code(() => assertCancellable('processing', 'cod_due')), 'NO_ERROR');
  assert.equal(code(() => assertCancellable('shipped', 'cod_due')), 'ORDER_ALREADY_SHIPPED');
  assert.equal(code(() => assertCancellable('completed', 'collected')), 'PAID_ORDER_REQUIRES_REFUND');
  assert.equal(code(() => assertCancellable('awaiting_confirmation', 'succeeded')), 'PAID_ORDER_REQUIRES_REFUND');
  assert.equal(code(() => assertCancellable('cancelled', 'cod_due')), 'ORDER_ALREADY_CANCELLED');
});

test('address change stops once anything left the warehouse', () => {
  assert.equal(code(() => assertAddressChangeable('awaiting_confirmation', 'unfulfilled')), 'NO_ERROR');
  assert.equal(code(() => assertAddressChangeable('confirmed', 'preparing')), 'ORDER_ALREADY_SHIPPED');
  assert.equal(code(() => assertAddressChangeable('shipped', 'fulfilled')), 'ORDER_ALREADY_SHIPPED');
  assert.equal(code(() => assertAddressChangeable('cancelled', 'unfulfilled')), 'ORDER_ALREADY_CANCELLED');
});

test('shipment state machine refuses skipping dispatch', () => {
  assert.equal(code(() => assertShipmentCreatable('awaiting_confirmation')), 'NO_ERROR');
  assert.equal(code(() => assertShipmentCreatable('completed')), 'STATE_CONFLICT');
  assert.equal(code(() => assertShipmentCreatable('cancelled')), 'ORDER_ALREADY_CANCELLED');

  assert.equal(code(() => assertShipmentDispatch('created')), 'NO_ERROR');
  assert.equal(code(() => assertShipmentDispatch('dispatched')), 'SHIPMENT_ALREADY_DISPATCHED');
  assert.equal(code(() => assertShipmentDispatch('delivered')), 'SHIPMENT_ALREADY_DELIVERED');

  assert.equal(code(() => assertShipmentDeliver('dispatched')), 'NO_ERROR');
  assert.equal(code(() => assertShipmentDeliver('created')), 'SHIPMENT_NOT_DISPATCHED');
  assert.equal(code(() => assertShipmentDeliver('cancelled')), 'SHIPMENT_CANCELLED');
});

test('order status only reaches shipped when every unit is allocated', () => {
  assert.equal(orderStatusAfterDispatch(true), 'shipped');
  assert.equal(orderStatusAfterDispatch(false), 'partially_shipped');
  assert.equal(fulfillmentAfterDispatch(true), 'fulfilled');
  assert.equal(fulfillmentAfterDispatch(false), 'partially_fulfilled');
});

test('shipment allocation cannot exceed ordered quantities or repeat a line', () => {
  const items = [{ id: 'a', quantity: 3 }, { id: 'b', quantity: 1 }];
  assert.deepEqual(allocateShipment(items, new Map(), [{ orderItemId: 'a', quantity: 2 }]),
    [{ orderItemId: 'a', quantity: 2 }]);
  // 已分配 2 件后只剩 1 件可发。
  assert.equal(code(() => allocateShipment(items, new Map([['a', 2]]), [{ orderItemId: 'a', quantity: 2 }])),
    'SHIPMENT_QUANTITY_EXCEEDED');
  assert.equal(code(() => allocateShipment(items, new Map(), [{ orderItemId: 'a', quantity: 1 },
    { orderItemId: 'a', quantity: 1 }])), 'VALIDATION_ERROR');
  assert.equal(code(() => allocateShipment(items, new Map(), [{ orderItemId: 'ghost', quantity: 1 }])),
    'VALIDATION_ERROR');
  assert.equal(code(() => allocateShipment(items, new Map(), [])), 'VALIDATION_ERROR');
  assert.equal(code(() => allocateShipment(items, new Map(), [{ orderItemId: 'a', quantity: 0 }])),
    'VALIDATION_ERROR');
  assert.equal(code(() => allocateShipment(items, new Map(), [{ orderItemId: 'a', quantity: 1.5 }])),
    'VALIDATION_ERROR');
});

test('notes and cancel reasons reject empty and control characters', () => {
  assert.equal(normalizeNote('  callback requested  '), 'callback requested');
  assert.equal(code(() => normalizeNote('   ')), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizeNote('bad\u0000note')), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizeNote('x'.repeat(1001))), 'VALIDATION_ERROR');

  const cancel = normalizeCancel({ reasonCode: ' customer_request ', reason: ' customer asked ', expectedVersion: 3 });
  assert.deepEqual(cancel, { reasonCode: 'customer_request', reason: 'customer asked', expectedVersion: 3, customerNotified: false });
  assert.equal(code(() => normalizeCancel({ reason: 'x', reasonCode: 'Bad Code', expectedVersion: 1 })), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizeCancel({ reason: 'x' })), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizeCancel({ reason: 'x', expectedVersion: 0 })), 'VALIDATION_ERROR');
});

test('address change repricing keeps the amount invariant and needs confirmation', () => {
  const order = { subtotalMinor: 20_000, discountMinor: 1_000, taxMinor: 500 };
  assert.deepEqual(repriceShipping(order, 4_000), { shippingMinor: 4_000, totalMinor: 23_500 });
  assert.equal(code(() => repriceShipping(order, -1)), 'VALIDATION_ERROR');
  assert.equal(code(() => assertAddressChangeConfirmed(23_500, 23_500, null)), 'NO_ERROR');
  assert.equal(code(() => assertAddressChangeConfirmed(23_500, 24_500, null)), 'CUSTOMER_CONFIRMATION_REQUIRED');
  assert.equal(code(() => assertAddressChangeConfirmed(23_500, 24_500, '  ')), 'CUSTOMER_CONFIRMATION_REQUIRED');
  assert.equal(code(() => assertAddressChangeConfirmed(23_500, 24_500, 'wa-2026-11-16')), 'NO_ERROR');
  assert.equal(normalizeConfirmationRef(' ref '), 'ref');
  assert.equal(normalizeConfirmationRef(''), null);
});

test('versions must match exactly', () => {
  assert.equal(code(() => assertVersion(2, 2)), 'NO_ERROR');
  assert.equal(code(() => assertVersion(1, 2)), 'VERSION_CONFLICT');
  assert.equal(code(() => assertVersion(0, 0)), 'VALIDATION_ERROR');
});
