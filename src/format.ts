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
}) {
  const { spec, names, status } = opts;
  const n = (id: number) => names.get(id) ?? `#${id}`;
  const m = (v: number | string) => money(v, spec.currency);
  const shares = computeShares(spec);
  const payers = shares.filter((s) => Number(s.paid_share) > 0);
  const owers = shares.filter((s) => Number(s.owed_share) > 0);

  const meta = [`💰 *${m(spec.cost)}*`];
  if (spec.category) meta.push(spec.category);
  if (spec.date && spec.date.slice(0, 10) !== today()) {
    meta.push(new Date(spec.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));
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
  out.push(STATUS_LINE[status](opts.ref));
  return out.join('\n');
}

export const DRAFT_FOOTER = '👉 React 👍 / ✅ or reply *yes* to add to Splitwise · or reply with what to change';
