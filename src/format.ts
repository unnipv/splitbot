import { config } from './config.ts';
import { computeShares, type ExpenseSpec } from './split.ts';

/** WhatsApp-formatted receipts (*bold*, _italic_). */

export function money(amount: number | string, currency: string) {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount));
  } catch {
    return `${currency} ${amount}`;
  }
}

export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.bot.timezone }).format(new Date());
}

const SPLIT_LABEL: Record<ExpenseSpec['split']['type'], string> = {
  equal: 'Split equally',
  exact: 'Split by amount',
  percent: 'Split by percentage',
  shares: 'Split by shares',
  adjustment: 'Split equally + extras',
};

export type ReceiptStatus = 'added' | 'updated' | 'draft' | 'dry-run';

const STATUS_LINE: Record<ReceiptStatus, (ref: string) => string> = {
  added: (ref) => `✅ Added to Splitwise · ${ref}`,
  updated: (ref) => `✏️ Updated in Splitwise · ${ref}`,
  draft: (ref) => `📝 Draft ${ref} · not added yet`,
  'dry-run': (ref) => `🧪 Dry run ${ref} · nothing sent to Splitwise`,
};

export function formatReceipt(opts: {
  spec: ExpenseSpec;
  names: Map<number, string>;
  /** All members of the Splitwise group, to show who is left out. */
  memberIds: number[];
  status: ReceiptStatus;
  ref: string;
  assumptions?: string[];
  /** Why code wants a human to look at this one (possible duplicate, unusual amount…). */
  checks?: string[];
}) {
  const { spec, names, status } = opts;
  const n = (id: number) => names.get(id) ?? `#${id}`;
  const m = (v: number | string) => money(v, spec.currency);
  const shares = computeShares(spec);
  if (spec.payment) {
    const from = shares.filter((s) => Number(s.paid_share) > 0).map((s) => n(s.user_id)).join(' & ');
    const to = shares.filter((s) => Number(s.owed_share) > 0).map((s) => n(s.user_id)).join(' & ');
    const out = [`💸 *Payment* · *${m(spec.cost)}*`, `*${from}* paid *${to}*`];
    if (spec.date && spec.date.slice(0, 10) !== today()) out.push(`📅 ${shortDate(spec.date)}`);
    if (opts.assumptions?.length) out.push(`ℹ️ _Assumed: ${opts.assumptions.join('; ')}_`);
    if (opts.checks?.length) out.push(`⚠️ _Check: ${opts.checks.join('; ')}_`);
    out.push(STATUS_LINE[status](opts.ref));
    return out.join('\n');
  }
  const payers = shares.filter((s) => Number(s.paid_share) > 0);
  const owers = shares.filter((s) => Number(s.owed_share) > 0);

  const meta = [`💰 *${m(spec.cost)}*`];
  if (spec.category) meta.push(spec.category);
  if (spec.date && spec.date.slice(0, 10) !== today()) {
    meta.push(shortDate(spec.date));
  }

  const paid =
    payers.length === 1
      ? `💳 Paid by *${n(payers[0].user_id)}*`
      : `💳 Paid by ${payers.map((p) => `*${n(p.user_id)}* ${m(p.paid_share)}`).join(' · ')}`;

  const valueOf = new Map(spec.split.participants.map((p) => [p.user_id, p.value]));
  const detail = (id: number) => {
    const v = valueOf.get(id);
    if (v === undefined) return '';
    if (spec.split.type === 'percent') return ` _(${v}%)_`;
    if (spec.split.type === 'shares') return ` _(${v} share${v === 1 ? '' : 's'})_`;
    const factor = spec.split.subtotal ? spec.cost / spec.split.subtotal : 1;
    if (spec.split.type === 'adjustment' && v > 0) return ` _(incl. ${m(v * factor)} for own items${factor !== 1 ? ' + tax' : ''})_`;
    return '';
  };
  const rows = owers.map((o) => `• ${n(o.user_id)} — ${m(o.owed_share)}${detail(o.user_id)}`);

  const included = new Set(owers.map((o) => o.user_id));
  const left = opts.memberIds.filter((id) => !included.has(id));

  const out = [
    `🧾 *${spec.description}*`,
    meta.join(' · '),
    paid,
    '',
    `👥 ${SPLIT_LABEL[spec.split.type]} · ${owers.length} ${owers.length === 1 ? 'person' : 'people'}`,
    ...rows,
  ];
  if (left.length) out.push(`🚫 Not in split: ${left.map(n).join(', ')}`);
  if (spec.notes) out.push(`📝 _${spec.notes.slice(0, 300)}_`);
  if (opts.assumptions?.length) out.push(`ℹ️ _Assumed: ${opts.assumptions.join('; ')}_`);
  if (opts.checks?.length) out.push(`⚠️ _Check: ${opts.checks.join('; ')}_`);
  out.push(STATUS_LINE[status](opts.ref));
  return out.join('\n');
}

function shortDate(date: string) {
  return new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** One line for lists and reminders: "*Dinner* · ₹2,400". */
export function oneLine(spec: Pick<ExpenseSpec, 'description' | 'cost' | 'currency' | 'payment'>) {
  return `*${spec.payment ? 'Payment' : spec.description}* · ${money(spec.cost, spec.currency)}`;
}

export function formatBalances(
  debts: { from: number; to: number; amount: string; currency_code: string }[],
  names: Map<number, string>,
) {
  if (!debts.length) return '🎉 Everyone is settled up.';
  const n = (id: number) => names.get(id) ?? `#${id}`;
  return ['⚖️ *Who owes what*', ...debts.map((d) => `• ${n(d.from)} → ${n(d.to)} · *${money(d.amount, d.currency_code)}*`)].join('\n');
}

/** Totals for a set of expenses: per currency, top categories, biggest one. Payments are left out. */
export function formatSummary(title: string, specs: ExpenseSpec[]) {
  const spent = specs.filter((s) => !s.payment);
  if (!spent.length) return `${title}\nNothing logged yet.`;
  const byCurrency = new Map<string, number>();
  const byCategory = new Map<string, number>();
  for (const s of spent) {
    byCurrency.set(s.currency, (byCurrency.get(s.currency) ?? 0) + s.cost);
    const key = `${s.category ?? 'Other'}|${s.currency}`;
    byCategory.set(key, (byCategory.get(key) ?? 0) + s.cost);
  }
  const top = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const biggest = spent.reduce((a, b) => (b.cost > a.cost ? b : a));
  return [
    title,
    `🧾 ${spent.length} expense${spent.length === 1 ? '' : 's'} · ${[...byCurrency.entries()].map(([c, v]) => `*${money(v, c)}*`).join(' + ')}`,
    ...top.map(([k, v]) => `• ${k.split('|')[0]} — ${money(v, k.split('|')[1])}`),
    `🏆 Biggest: ${oneLine(biggest)}`,
  ].join('\n');
}

export const DRAFT_FOOTER = '👉 React 👍 / ✅ or reply *yes* to add to Splitwise · or reply with what to change';
