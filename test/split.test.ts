import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeShares, SplitError, type ExpenseSpec } from '../src/split.ts';

const base = (over: Partial<ExpenseSpec>): ExpenseSpec => ({
  description: 'x',
  cost: 100,
  currency: 'INR',
  payers: [{ user_id: 1 }],
  split: { type: 'equal', participants: [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }] },
  ...over,
});

const sum = (xs: string[]) => xs.reduce((a, b) => a + Math.round(Number(b) * 100), 0);

test('equal split distributes leftover paise', () => {
  const s = computeShares(base({}));
  assert.deepEqual(s.map((u) => u.owed_share), ['33.34', '33.33', '33.33']);
  assert.equal(sum(s.map((u) => u.owed_share)), 10000);
  assert.equal(s.find((u) => u.user_id === 1)!.paid_share, '100.00');
});

test('payer not among participants is still included', () => {
  const s = computeShares(base({ payers: [{ user_id: 9 }] }));
  assert.deepEqual(s.find((u) => u.user_id === 9), { user_id: 9, paid_share: '100.00', owed_share: '0.00' });
});

test('multiple payers with amounts', () => {
  const s = computeShares(base({ payers: [{ user_id: 1, amount: 60 }, { user_id: 2, amount: 40 }] }));
  assert.equal(s.find((u) => u.user_id === 2)!.paid_share, '40.00');
});

test('payer amounts must add up', () => {
  assert.throws(() => computeShares(base({ payers: [{ user_id: 1, amount: 60 }] })), SplitError);
});

test('exact, percent, shares, adjustment', () => {
  const p = [{ user_id: 1 }, { user_id: 2 }];
  assert.deepEqual(
    computeShares(base({ split: { type: 'exact', participants: [{ ...p[0], value: 70 }, { ...p[1], value: 30 }] } })).map((u) => u.owed_share),
    ['70.00', '30.00'],
  );
  assert.deepEqual(
    computeShares(base({ split: { type: 'percent', participants: [{ ...p[0], value: 25 }, { ...p[1], value: 75 }] } })).map((u) => u.owed_share),
    ['25.00', '75.00'],
  );
  assert.deepEqual(
    computeShares(base({ split: { type: 'shares', participants: [{ ...p[0], value: 2 }, { ...p[1], value: 3 }] } })).map((u) => u.owed_share),
    ['40.00', '60.00'],
  );
  // Rahul (2) had an extra 20 beer: the other 80 is split evenly.
  assert.deepEqual(
    computeShares(base({ split: { type: 'adjustment', participants: [{ ...p[0] }, { ...p[1], value: 20 }] } })).map((u) => u.owed_share),
    ['40.00', '60.00'],
  );
});

test('zero-decimal currencies', () => {
  const s = computeShares(base({ cost: 1000, currency: 'JPY' }));
  assert.deepEqual(s.map((u) => u.owed_share), ['334', '333', '333']);
});

test('bad percentages rejected', () => {
  assert.throws(
    () => computeShares(base({ split: { type: 'percent', participants: [{ user_id: 1, value: 50 }, { user_id: 2, value: 20 }] } })),
    /100/,
  );
});

test('adjustment extras carry proportional tax/service when subtotal is given', () => {
  // Bill: subtotal 1980, total 2330.46. 360 of beer shared by users 1-3 only (120 each, pre-tax).
  const s = computeShares(
    base({
      cost: 2330.46,
      currency: 'THB',
      split: {
        type: 'adjustment',
        subtotal: 1980,
        participants: [{ user_id: 1, value: 120 }, { user_id: 2, value: 120 }, { user_id: 3, value: 120 }, { user_id: 4 }],
      },
    }),
  );
  const owed = Object.fromEntries(s.map((u) => [u.user_id, Number(u.owed_share)]));
  assert.ok(Math.abs(owed[4] - 476.69) < 0.02, `non-drinker ${owed[4]}`);
  assert.ok(Math.abs(owed[1] - 617.93) < 0.02, `drinker ${owed[1]}`);
  assert.equal(Math.round((owed[1] + owed[2] + owed[3] + owed[4]) * 100), 233046);
});

test('items only some people had are expanded with proportional tax', async () => {
  const { expandItems } = await import('../src/split.ts');
  const spec = expandItems(
    base({
      cost: 2330.46,
      currency: 'THB',
      split: { type: 'equal', subtotal: 1980, participants: [1, 2, 3, 4].map((user_id) => ({ user_id })), items: [{ amount: 360, user_ids: [1, 2, 3] }] },
    }),
  );
  const owed = Object.fromEntries(computeShares(spec).map((u) => [u.user_id, Number(u.owed_share)]));
  assert.ok(Math.abs(owed[4] - 476.69) < 0.02, `non-drinker ${owed[4]}`);
  assert.ok(Math.abs(owed[1] - 617.93) < 0.02, `drinker ${owed[1]}`);
});
