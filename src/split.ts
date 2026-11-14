/**
 * Deterministic split math. The LLM only decides *who* and *how* (equal / exact / percent / shares / adjustment);
 * the actual paid/owed amounts are computed here in minor units so they always add up to the cost.
 */

export type SplitType = 'equal' | 'exact' | 'percent' | 'shares' | 'adjustment';

export interface ExpenseSpec {
  description: string;
  cost: number;
  currency: string;
  date?: string;
  category?: string;
  notes?: string;
  /** A settle-up ("Rahul paid me back 500"): payers = who sent the money, the one participant = who received it. */
  payment?: boolean;
  /** Who paid. One payer with no amount = paid everything. Several without amounts = paid equally. */
  payers: { user_id: number; amount?: number }[];
  split: {
    type: SplitType;
    /**
     * equal: value ignored · exact: amount owed · percent: % owed · shares: weight
     * adjustment: extra amount on top of an equal share of the remainder (e.g. someone's extra drink)
     */
    participants: { user_id: number; value?: number }[];
    /**
     * Bill subtotal before tax/service. When set, adjustment/exact values are taken as pre-tax item amounts and
     * scaled by cost/subtotal, so each person also carries their proportional share of tax and service.
     */
    subtotal?: number;
    /**
     * Items only some people had ("Dev didn't have beer", "the sea bass was mine"): each item's (pre-tax) amount is
     * shared by its user_ids; the rest of the bill is split equally among all participants. See expandItems().
     */
    items?: { amount: number; user_ids: number[]; name?: string }[];
  };
}

export interface UserShare {
  user_id: number;
  paid_share: string;
  owed_share: string;
}

export class SplitError extends Error {}

export function currencyDecimals(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Split `total` minor units across weights, handing leftover units to the largest remainders. */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new SplitError('Split weights must add up to more than zero');
  if (total === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k].i]++;
  return out;
}

function toMinor(amount: number, scale: number) {
  return Math.round(amount * scale);
}

function need(values: (number | undefined)[], what: string): number[] {
  return values.map((v) => {
    if (v === undefined || !Number.isFinite(v) || v < 0) throw new SplitError(`Every participant needs a non-negative ${what}`);
    return v;
  });
}

export function computeShares(spec: ExpenseSpec): UserShare[] {
  const decimals = currencyDecimals(spec.currency);
  const scale = 10 ** decimals;
  const total = toMinor(spec.cost, scale);
  if (!(total > 0)) throw new SplitError('Cost must be greater than zero');

  // ── Paid ──
  if (!spec.payers.length) throw new SplitError('At least one payer is required');
  let paid: number[];
  const payerAmounts = spec.payers.map((p) => p.amount);
  if (payerAmounts.every((a) => a === undefined)) {
    paid = apportion(total, spec.payers.map(() => 1));
  } else {
    paid = need(payerAmounts, 'paid amount').map((a) => toMinor(a, scale));
    const diff = total - paid.reduce((a, b) => a + b, 0);
    if (Math.abs(diff) > spec.payers.length) {
      throw new SplitError(`Paid amounts add up to ${fmt(total - diff, decimals)}, but the cost is ${fmt(total, decimals)}`);
    }
    paid[paid.length - 1] += diff;
  }

  // ── Owed ──
  const parts = spec.split.participants;
  if (!parts.length) throw new SplitError('At least one participant is required');
  const taxFactor = spec.split.subtotal && spec.split.subtotal > 0 ? spec.cost / spec.split.subtotal : 1;
  const values = parts.map((p) => (p.value === undefined ? undefined : p.value * taxFactor));
  let owed: number[];
  switch (spec.split.type) {
    case 'equal':
      owed = apportion(total, parts.map(() => 1));
      break;
    case 'shares':
      owed = apportion(total, need(values, 'share'));
      break;
    case 'percent': {
      const pct = need(values, 'percentage');
      const sum = pct.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 100) > 0.5) throw new SplitError(`Percentages add up to ${sum}, not 100`);
      owed = apportion(total, pct);
      break;
    }
    case 'exact': {
      owed = need(values, 'amount').map((v) => toMinor(v, scale));
      const diff = total - owed.reduce((a, b) => a + b, 0);
      if (Math.abs(diff) > parts.length) {
        throw new SplitError(`Exact amounts add up to ${fmt(total - diff, decimals)}, but the cost is ${fmt(total, decimals)}`);
      }
      owed[owed.length - 1] += diff;
      break;
    }
    case 'adjustment': {
      // Spread the (tax-scaled) adjustment total by weight, so rounding can never push it past the cost.
      const raw = parts.map((p) => Math.max(0, p.value ?? 0));
      const rawSum = raw.reduce((a, b) => a + b, 0);
      const adjTotal = toMinor(rawSum * taxFactor, scale);
      if (adjTotal > total + parts.length) {
        throw new SplitError(
          `The per-person extras add up to ${fmt(adjTotal, decimals)}, more than the cost of ${fmt(total, decimals)}`,
        );
      }
      const adj = rawSum > 0 ? apportion(Math.min(adjTotal, total), raw) : raw.map(() => 0);
      const base = apportion(total - adj.reduce((a, b) => a + b, 0), parts.map(() => 1));
      owed = base.map((b, i) => b + adj[i]);
      break;
    }
    default:
      throw new SplitError(`Unknown split type: ${spec.split.type as string}`);
  }

  // ── Merge per user ──
  const users = new Map<number, { paid: number; owed: number }>();
  const slot = (id: number) => users.get(id) ?? users.set(id, { paid: 0, owed: 0 }).get(id)!;
  spec.payers.forEach((p, i) => (slot(p.user_id).paid += paid[i]));
  parts.forEach((p, i) => (slot(p.user_id).owed += owed[i]));

  return [...users.entries()].map(([user_id, s]) => ({
    user_id,
    paid_share: fmt(s.paid, decimals),
    owed_share: fmt(s.owed, decimals),
  }));
}

function fmt(minor: number, decimals: number) {
  return (minor / 10 ** decimals).toFixed(decimals);
}

/**
 * Turn split.items into an equivalent 'adjustment' split (per-person extras), which computeShares and the receipt
 * already understand. Item amounts are pre-tax when split.subtotal is set.
 */
export function expandItems(spec: ExpenseSpec): ExpenseSpec {
  const items = spec.split.items;
  if (!items?.length) return spec;
  const decimals = currencyDecimals(spec.currency);
  const scale = 10 ** decimals;
  for (const it of items) {
    if (!(it.amount > 0) || !it.user_ids?.length) {
      throw new SplitError(`Item "${it.name ?? '?'}" needs an amount and at least one person who had it`);
    }
  }
  const itemsTotal = items.reduce((s, it) => s + toMinor(it.amount, scale), 0);
  const cost = toMinor(spec.cost, scale);
  let subtotal = spec.split.subtotal && spec.split.subtotal > 0 ? toMinor(spec.split.subtotal, scale) : undefined;
  // Many bills (e.g. Thai VAT receipts) print tax-inclusive prices next to a pre-tax "net total". Items that only
  // fit the full cost were priced with tax already, so there's nothing left to scale.
  if (subtotal !== undefined && itemsTotal > subtotal && itemsTotal <= cost + items.length) subtotal = undefined;
  const limit = subtotal ?? cost;
  if (itemsTotal > limit + items.length) {
    const names = items.map((it) => `${it.name ?? 'item'} ${fmt(toMinor(it.amount, scale), decimals)}`).join(', ');
    throw new SplitError(
      `The items add up to ${fmt(itemsTotal, decimals)} (${names}), but the bill ${subtotal !== undefined ? 'subtotal' : 'total'} is ` +
        `${fmt(limit, decimals)} — ${fmt(itemsTotal - limit, decimals)} too much. An item price or quantity is probably misread or counted twice.`,
    );
  }
  // Each item is divided among its people in minor units, so the per-person extras add up exactly.
  // Items with the same people are pooled first, so leftover minor units don't land on the same person twice.
  const pools = new Map<string, { ids: number[]; amount: number }>();
  for (const it of items) {
    const ids = [...new Set(it.user_ids)].sort((x, y) => x - y);
    const pool = pools.get(ids.join()) ?? pools.set(ids.join(), { ids, amount: 0 }).get(ids.join())!;
    pool.amount += toMinor(it.amount, scale);
  }
  const extras = new Map<number, number>();
  for (const { ids, amount } of pools.values()) {
    apportion(amount, ids.map(() => 1)).forEach((v, i) => extras.set(ids[i], (extras.get(ids[i]) ?? 0) + v));
  }
  const ids = new Set(spec.split.participants.map((p) => p.user_id));
  for (const id of extras.keys()) ids.add(id);
  return {
    ...spec,
    split: {
      type: 'adjustment',
      subtotal: subtotal === undefined ? undefined : subtotal / scale,
      participants: [...ids].map((user_id) => ({ user_id, value: extras.has(user_id) ? extras.get(user_id)! / scale : undefined })),
    },
  };
}
