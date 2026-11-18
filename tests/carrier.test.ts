import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  canonicalCarrierBody, carrierWebhookSecrets, CarrierRuleError, normalizeCarrierEvent,
  signatureRef, verifyCarrierSignature,
} from '../packages/domain/src/carrier.js';

const SECRET = 'x'.repeat(48);
const NOW = new Date('2026-11-18T10:00:00.000Z');
const SHIPMENT = '12345678-1234-4234-8234-123456789abc';
const event = { eventId: 'carrier-event-000001', shipmentId: SHIPMENT, status: 'in_transit',
  occurredAt: '2026-11-18T09:59:00.000Z' };

function signed(body: unknown, timestamp = String(Math.floor(NOW.getTime() / 1000)), secret = SECRET) {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${canonicalCarrierBody(body)}`).digest('hex')}`;
}

test('carrier: canonical signature accepts exact body and rejects tampering or replay', () => {
  assert.equal(canonicalCarrierBody(event), canonicalCarrierBody({ ...event }));
  const canonical = canonicalCarrierBody(event);
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const signature = signed(event, timestamp);
  assert.doesNotThrow(() => verifyCarrierSignature(SECRET, canonical, signature, timestamp, NOW));
  assert.match(signatureRef(signature), /^v1=[0-9a-f]{16}$/);
  assert.notEqual(signatureRef(signature), signature, '完整 HMAC 不落库');

  assert.throws(() => verifyCarrierSignature(SECRET, canonical, signed({ ...event, status: 'delivered' }, timestamp),
    timestamp, NOW), (error: unknown) => error instanceof CarrierRuleError && error.code === 'INVALID_SIGNATURE');
  assert.throws(() => verifyCarrierSignature(SECRET, canonical, signature,
    String(Math.floor(NOW.getTime() / 1000) - 301), NOW),
  (error: unknown) => error instanceof CarrierRuleError && error.code === 'INVALID_SIGNATURE');
  assert.throws(() => verifyCarrierSignature(SECRET, canonical, null, timestamp, NOW),
    (error: unknown) => error instanceof CarrierRuleError && error.code === 'INVALID_SIGNATURE');
  assert.throws(() => verifyCarrierSignature(SECRET, canonical, 'v1=abc', timestamp, NOW),
    (error: unknown) => error instanceof CarrierRuleError && error.code === 'INVALID_SIGNATURE');
});

test('carrier: normalized events carry identifiers and status only', () => {
  const parsed = normalizeCarrierEvent({ ...event, trackingNumber: '  SF123  ', note: '  leave at door ' }, NOW);
  assert.equal(parsed.eventId, event.eventId);
  assert.equal(parsed.trackingNumber, 'SF123');
  assert.equal(parsed.note, 'leave at door');
  assert.equal(parsed.occurredAt.toISOString(), event.occurredAt);

  for (const bad of [
    { ...event, email: 'buyer@example.com' },
    { ...event, status: 'purchase' },
    { ...event, occurredAt: new Date(NOW.getTime() + 120_000).toISOString() },
    { ...event, eventId: 'short' },
    { ...event, trackingNumber: '' },
    { ...event, note: 'x'.repeat(501) },
  ]) {
    assert.throws(() => normalizeCarrierEvent(bad, NOW), (error: unknown) => error instanceof CarrierRuleError);
  }
});

test('carrier: secrets fail closed when unconfigured or malformed', () => {
  assert.deepEqual(carrierWebhookSecrets({}), {});
  assert.deepEqual(carrierWebhookSecrets({ CARRIER_WEBHOOK_SECRETS: 'not-json' }), {});
  assert.deepEqual(carrierWebhookSecrets({ CARRIER_WEBHOOK_SECRETS: JSON.stringify({ SF: 'too-short' }) }), {});
  assert.deepEqual(carrierWebhookSecrets({ CARRIER_WEBHOOK_SECRETS: JSON.stringify({ 'SF Express': SECRET }) }), {});
  assert.deepEqual(carrierWebhookSecrets({ CARRIER_WEBHOOK_SECRETS: JSON.stringify({ sf: SECRET }) }), { sf: SECRET });
});
