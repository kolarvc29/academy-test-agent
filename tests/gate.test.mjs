import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, computeGate, finalGate } from '../scripts/gate.mjs';

const base = (findings = [], extra = {}) => ({
  build_id: 'b1', base_url: 'https://x', gate: 'pass', findings,
  coverage: { pages_tested: 1, profiles: ['desktop-chromium'], checks_not_run: [] },
  regression_checks: [], ...extra,
});
const f = (severity, confidence = 'high', status = 'new') => ({ title: 't', evidence: 'e', severity, confidence, status });

test('high finding at high confidence blocks', () => {
  assert.equal(computeGate(base([f('high')])).gate, 'block');
});
test('high finding at low confidence does not block', () => {
  assert.equal(computeGate(base([f('high', 'low')])).gate, 'pass');
});
test('medium finding warns', () => {
  assert.equal(computeGate(base([f('medium'), f('low')])).gate, 'warn');
});
test('fixed findings are ignored', () => {
  assert.equal(computeGate(base([f('blocker', 'high', 'fixed')])).gate, 'pass');
});
test('core check not run cannot pass', () => {
  const r = base([], { coverage: { checks_not_run: [{ check: 'accessibility', reason: 'axe failed' }] } });
  assert.equal(computeGate(r).gate, 'warn');
});
test('agent cannot be more lenient than the rule', () => {
  const v = finalGate(base([f('blocker')], { gate: 'pass' }));
  assert.equal(v.gate, 'block');
  assert.match(v.reason, /overridden/);
});
test('agent may be stricter than the rule', () => {
  assert.equal(finalGate(base([], { gate: 'warn' })).gate, 'warn');
});
test('validation catches bad severity and missing fields', () => {
  assert.ok(validate({}).length >= 5);
  assert.ok(validate(base([{ ...f('urgent'), title: 'x' }])).some((e) => /severity/.test(e)));
});
