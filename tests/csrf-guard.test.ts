import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csrfSatisfied } from '../apps/api/src/identity/csrf.js';

/** 真实令牌是 HMAC-SHA256 的 64 位十六进制；用同长度值，避免长度差异掩盖判定本身。 */
const TOKEN = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
const OTHER = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

test('write paths only accept a matching token', () => {
  assert.equal(csrfSatisfied(TOKEN, TOKEN, false), true);
  // 缺头（null）与空头（''）在写路径上都必须拒绝：这正是旧实现靠 '' 长度不等才拦住的两种情况。
  assert.equal(csrfSatisfied(null, TOKEN, false), false);
  assert.equal(csrfSatisfied('', TOKEN, false), false);
  assert.equal(csrfSatisfied(OTHER, TOKEN, false), false);
  // 只差一个字符也必须拒绝，不能只有前缀正确就放行。
  assert.equal(csrfSatisfied(`${TOKEN.slice(0, -1)}x`, TOKEN, false), false);
});

test('read paths allow omission but still reject a wrong token', () => {
  assert.equal(csrfSatisfied(null, TOKEN, true), true);
  assert.equal(csrfSatisfied('', TOKEN, true), true);
  assert.equal(csrfSatisfied(TOKEN, TOKEN, true), true);
  // 只读不代表「带了错令牌也放行」：那会把调用方的实现错误藏起来。
  assert.equal(csrfSatisfied(OTHER, TOKEN, true), false);
});

test('length differences are never accepted in either mode', () => {
  assert.equal(csrfSatisfied(`${TOKEN}a`, TOKEN, false), false);
  assert.equal(csrfSatisfied(TOKEN.slice(0, 32), TOKEN, false), false);
  assert.equal(csrfSatisfied(`${TOKEN}a`, TOKEN, true), false);
});

test('an empty expected token cannot be satisfied by any supplied value', () => {
  assert.equal(csrfSatisfied(TOKEN, '', false), false);
  assert.equal(csrfSatisfied(TOKEN, '', true), false);
  // 期望值为空只可能是配置故障；此时只读路径仍允许省略令牌，写路径必须拒绝。
  assert.equal(csrfSatisfied(null, '', false), false);
});
