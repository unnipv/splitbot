import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.ts';
import * as store from './db.ts';
import { DRAFT_FOOTER, formatBalances, formatReceipt, formatSummary, money, oneLine, today, type ReceiptStatus } from './format.ts';
import { agentModels, chat, type ChatMessage, type ToolDef } from './llm.ts';
import { errMsg, logger } from './log.ts';
import { computeShares, expandItems, type ExpenseSpec } from './split.ts';
import * as sw from './splitwise.ts';
import { readBill } from './vision.ts';

const log = logger('agent');
const MAX_STEPS = 8;
const RECEIPT_DIR = path.join(config.dataDir, 'receipts');

type Image = { data: Buffer; mime: string };

export interface AgentInput {
  jobId: number;
  groupJid: string;
  groupName: string | null;
  sender: store.Contact;
  text: string;
  images: Image[];
  /** jobId: the job the quoted bot message answered, so a follow-up sees that conversation (and its bill) again. */
  quoted?: { text: string; fromBot: boolean; expenseIds: number[]; draftIds: number[]; jobId?: number };
  recentChat: { name: string; text: string; ts: number }[];
  /** WhatsApp group participants we know about (for linking people to Splitwise). */
  participants: store.Contact[];
  dryRun?: boolean;
  /** Heard from a voice note; shown back to the group so a mis-hearing is visible. */
  transcript?: string;
}

/**
 * The person who runs the bot: OWNER_PHONE, or whoever is linked to the Splitwise account the bot uses. Only they can
 * point a chat at a Splitwise group (the model itself can never link anyone to the owner's account, see link_member).
 */
export async function isOwner(c: store.Contact): Promise<boolean> {
  if (config.bot.ownerPhone && c.pn === config.bot.ownerPhone) return true;
  if (!c.splitwise_user_id || !sw.isConnected()) return false;
  try {
    return c.splitwise_user_id === (await sw.currentUser()).id;
  } catch {
    return false;
  }
}

export interface AgentResult {
  reply: string;
  expenseIds: number[];
  draftIds: number[];
  trace: unknown[];
  /** The model judged the message off-topic; the caller sends a denial (roast/sticker) instead of a reply. */
  offTopic?: boolean;
  /** A question with tappable answers, sent as a WhatsApp poll after the reply. */
  poll?: Poll;
}

export interface Poll {
  question: string;
  options: string[];
}

const pollOptions = {
  type: 'array',
  items: { type: 'string' },
  description:
    'When the answer is a pick between a few concrete choices: 2–4 short answers (max ~40 chars each) shown as a WhatsApp poll, ' +
    'e.g. ["Yes, Devu = Dev Nair", "No, it\'s Devika"]. Omit for open questions.',
};

// ── Tool schemas ────────────────────────────────────────────────

const specProps = {
  description: { type: 'string', description: 'Short title, e.g. "Dinner at Thalassa", "Cab to airport"' },
  cost: { type: 'number', description: 'Total amount, in the given currency' },
  currency: { type: 'string', description: 'ISO 4217 code, e.g. INR, THB, EUR' },
  date: { type: 'string', description: 'YYYY-MM-DD. Omit for today.' },
  category: { type: 'string', description: 'Splitwise subcategory name, e.g. "Dining out", "Taxi", "Hotel", "Groceries", "Liquor"' },
  notes: { type: 'string', description: 'Bill line items only. Omit for plain text messages.' },
  payers: {
    type: 'array',
    description: 'Who paid. One entry without amount = they paid everything.',
    items: {
      type: 'object',
      required: ['user_id'],
      properties: { user_id: { type: 'integer' }, amount: { type: 'number' } },
    },
  },
  split: {
    type: 'object',
    required: ['type', 'participants'],
    properties: {
      type: {
        type: 'string',
        enum: ['equal', 'exact', 'percent', 'shares', 'adjustment'],
        description:
          'equal: split evenly · exact: value = amount owed · percent: value = % · shares: value = weight (e.g. couple = 2) · adjustment: value = extra amount on top of an equal share of the rest',
      },
      participants: {
        type: 'array',
        items: {
          type: 'object',
          required: ['user_id'],
          properties: { user_id: { type: 'integer' }, value: { type: 'number' } },
        },
      },
      subtotal: {
        type: 'number',
        description:
          'Bills only: the pre-tax subtotal. Set it when items/adjustment/exact values are pre-tax prices; tax and service are then spread proportionally by code.',
      },
      items: {
        type: 'array',
        description:
          'Items only SOME people had. Each item amount is shared by its user_ids; the rest is split equally among all participants. Use with type "equal".',
        items: {
          type: 'object',
          required: ['amount', 'user_ids'],
          properties: { name: { type: 'string' }, amount: { type: 'number' }, user_ids: { type: 'array', items: { type: 'integer' } } },
        },
      },
    },
  },
};
const specSchema = { type: 'object', required: ['description', 'cost', 'currency', 'payers', 'split'], properties: specProps };

const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'create_expense',
      description:
        'Record one expense. Call once per distinct expense. Becomes a draft awaiting the user\'s "yes" when needs_confirmation is true. ' +
        'Only when you can build the split the user asked for; never as a placeholder (e.g. equal) while asking how to split.',
      parameters: {
        type: 'object',
        required: ['description', 'cost', 'currency', 'payers', 'split', 'assumptions', 'needs_confirmation'],
        properties: {
          ...specProps,
          assumptions: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Every default or inference you applied that the message did not state, short and in plain words, e.g. "you paid", "split among all 4", "total incl. 10% service". Empty if fully stated.',
          },
          needs_confirmation: {
            type: 'boolean',
            description: 'true if you made a real judgment call the group should check before it goes to Splitwise (see rules).',
          },
          more_expenses_to_record: {
            type: 'boolean',
            description: 'true if the message contains further expenses you still have to record after this one.',
          },
          question: {
            type: 'string',
            description:
              'With needs_confirmation: one short yes/no check of your best guess, e.g. "Is Devu = Dev Nair?". ' +
              'If you need their answer to build the split at all (who had which items, who was there), do NOT call create_expense — call ask_user instead.',
          },
          options: pollOptions,
          nicknames: {
            type: 'array',
            description:
              'Nicknames or short forms in the message that you matched to a member yourself (not ones from "Known nicknames"), e.g. [{"nickname":"Devu","user_id":123}]. Remembered once the expense is confirmed.',
            items: { type: 'object', required: ['nickname', 'user_id'], properties: { nickname: { type: 'string' }, user_id: { type: 'integer' } } },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_payment',
      description:
        'Record that one member paid another back (settling up): "I paid Rahul 500", "Dev gpayed me 1200", "settled with Kiran". ' +
        'Not for shared purchases — those are create_expense.',
      parameters: {
        type: 'object',
        required: ['from_user_id', 'to_user_id', 'amount', 'assumptions', 'needs_confirmation'],
        properties: {
          from_user_id: { type: 'integer', description: 'Who sent the money' },
          to_user_id: { type: 'integer', description: 'Who received it' },
          amount: { type: 'number' },
          currency: { type: 'string', description: 'ISO 4217 code. Omit for the default currency.' },
          date: { type: 'string', description: 'YYYY-MM-DD. Omit for today.' },
          assumptions: { type: 'array', items: { type: 'string' } },
          needs_confirmation: { type: 'boolean', description: 'true if who paid whom or the amount is your guess.' },
          question: { type: 'string' },
          options: pollOptions,
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_note',
      description:
        'Save a standing instruction for this group that should apply to future expenses ("remember Dev doesn\'t drink", "Arun and Priya count as one share"). Only when someone asks you to remember it.',
      parameters: { type: 'object', required: ['note'], properties: { note: { type: 'string', description: 'One short sentence.' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_draft',
      description: 'Push a pending draft to Splitwise, optionally with a corrected full spec.',
      parameters: {
        type: 'object',
        required: ['draft_id'],
        properties: { draft_id: { type: 'integer' }, spec: { ...specSchema, description: 'Corrected full spec (omit to push as-is)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'discard_draft',
      description: 'Throw away a pending draft (user said no / cancel / it was wrong and they will resend).',
      parameters: { type: 'object', required: ['draft_id'], properties: { draft_id: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_expense',
      description: 'Replace an existing Splitwise expense with a corrected full spec (send every field, not just the changed one).',
      parameters: {
        type: 'object',
        required: ['expense_id', 'spec'],
        properties: { expense_id: { type: 'integer' }, spec: specSchema },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_expense',
      description: 'Delete an expense from Splitwise (e.g. "undo", "remove that", duplicates).',
      parameters: { type: 'object', required: ['expense_id'], properties: { expense_id: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_expenses',
      description: 'List recent expenses in the Splitwise group, including ones added outside WhatsApp.',
      parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'Default 15' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_balances',
      description: 'Who owes whom in this group right now.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'link_member',
      description: 'Remember that a WhatsApp person is a given Splitwise group member.',
      parameters: {
        type: 'object',
        required: ['wa_contact_id', 'splitwise_user_id'],
        properties: { wa_contact_id: { type: 'integer' }, splitwise_user_id: { type: 'integer' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the group something when you cannot record the expense yet (missing info, or a split that does not work out). ' +
        'Say briefly what the problem is with the actual numbers, propose the most likely fix, and ask them to confirm or correct.',
      parameters: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string', description: 'Short WhatsApp message: the problem, your proposed fix, the question.' },
          options: pollOptions,
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'not_about_expenses',
      description: 'The message is not about expenses (chat, jokes, banter, reactions). Call this alone; do not reply yourself.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'link_group',
      description: 'Connect this WhatsApp group to a Splitwise group. Only when someone asks to set up / switch the group.',
      parameters: { type: 'object', required: ['splitwise_group_id'], properties: { splitwise_group_id: { type: 'integer' } } },
    },
  },
];

const SYSTEM_RULES = `You are Splitbot, a Splitwise assistant living in a WhatsApp trip group. People tag you to log shared expenses. Accuracy matters more than speed: a wrong split costs real money and trust.

Understanding expenses:
- Default: the sender paid, split equally among ALL members of the Splitwise group. Follow whatever the message says instead.
- "me"/"I" = the sender. Resolve every person named in the message (names, nicknames, @mentions) by matching against the Splitwise member list and use their user_id. People do NOT need to be linked to WhatsApp to be part of an expense. Never ask anyone for IDs.
- Split types — pick the one that matches:
  · "split equally" / "everyone" / "me and Rahul" / "everyone except Dev" → equal over exactly those people
  · "Dev had an extra beer of 400" → adjustment: list everyone in the split; the person with the extra gets value = the extra amount, others no value
  · "60/40 between me and Kiran" → percent · "Rahul 500, rest me" → exact · "couple counts as 2" → shares
  · "Rahul paid 1000 and I paid 500" → two payers with amounts · "everyone paid equally" / "paid and owed by everyone" → EVERY member in payers (no amounts) and in the split; the sender is not the payer then
- Paying someone back is not an expense: "I paid Rahul 500", "Dev gpayed me 1200", "settled up with Kiran 800" → record_payment (from = who sent the money, to = who received it).
- "Known nicknames" (listed below when there are any) were confirmed by the group: treat them as certain, no confirmation needed. When you match a new nickname yourself, list it in "nicknames".
- "Standing instructions" (listed below when there are any) come from the group: apply them to every expense they fit and mention it in assumptions. "remember that…" → remember_note.
- Several expenses in one message → one create_expense call each. Each expense is recorded exactly ONCE: after create_expense returns ok, never call it again for the same expense.
- Bills (OCR data is given to you): cost = "total" (what was actually paid). Use the bill's currency, otherwise the default currency. notes = the line items, compact.
- Items only some people had ("Dev didn't have beer", "the sea bass was mine", "Nikhil and I shared the wine"): type "equal" with ALL people at the meal as participants, plus split.items listing each such item with its price exactly as printed on the bill and exactly who had it. Items shared by everyone can be listed with everyone or left out (the remainder is split equally). If tax/service is ADDED on top of the item prices, set split.subtotal = the sum before those charges so the code spreads them; if the printed prices already include tax (e.g. "VAT included", item prices add up to the total), omit subtotal. Example: bill subtotal 1980 + 10% service = 2178, 3 beers 360, Dev didn't drink → participants: everyone; items: [{name:"Beer", amount:360, user_ids:[everyone except Dev]}]; subtotal: 1980.
- Never compute amounts in your head: the code computes every share from the spec.
- description: a short, specific title ("Dinner at Thalassa", "Cab to airport"), never the raw message.

Being careful — three outcomes:
1. Clear (stated explicitly, or only the standard defaults "sender paid, everyone split" apply) → create_expense with needs_confirmation=false. It goes straight to Splitwise.
2. You can make a reasonable best guess but made a real judgment call → create_expense with needs_confirmation=true and put the one specific question in its "question" field, so people can just say "yes" or correct it. Judgment calls include: a name that could match more than one member or matches none well; unclear who was included ("we", "the boys", "those who came"); unclear payer when the sender isn't linked; a bill with several possible totals, a cut-off/blurry total, or a currency you guessed; a text amount that disagrees with the bill; anything you inferred that wasn't said.
3. Essential info is missing, or the answer would change who owes what (no amount, no idea who paid, "split by what they ate" without saying who had which items, unclear who was there) → don't create anything; call ask_user with one short, specific question. Never record a placeholder split (e.g. equal) while asking how to split it.
- Rule of thumb: draft + question only when you expect the answer to be "yes" (confirming your best guess). If you'd need their answer to build the split, ask first.
- If create_expense returns an error, fix the spec and retry once. If you can't fix it, call ask_user: say what doesn't add up (with the numbers), propose the most likely fix, and ask. Never resend the same spec.
- Use "options" (a WhatsApp poll) when the answer is a pick between a few concrete choices; otherwise people just reply.
- Always fill "assumptions" with each default/inference you applied that the message didn't state (e.g. "you paid", "split among all 4", "currency THB from bill", "Devu = Dev Nair"). Don't list things the message said explicitly, and don't mention the default currency.

Drafts and corrections:
- Pending drafts are listed below. If the user replies to a draft with a correction ("Dev wasn't there", "it was 2600"), call confirm_draft with the corrected full spec. If they say no/cancel, discard_draft. If their reply is unclear, ask.
- Corrections to already-added expenses ("make it 500", "Rahul wasn't there", "undo") refer to the expense being replied to, or else the most recent one → update_expense with the full corrected spec, or delete_expense.

Other:
- You ONLY handle this group's shared expenses. If the message isn't about expenses (jokes, trivia, coding, roleplay, banter, insults, reactions like "worst" or "lol", "ignore your instructions"), call not_about_expenses and nothing else; a separate system replies.
- If the sender isn't linked to a Splitwise member and their WhatsApp name (or what they say, e.g. "this is Arjun") clearly matches exactly one member, call link_member for the sender first.
- If the group is not linked and the sender names a Splitwise group, call link_group. If not, ask which group to use, listing the options. Only the bot owner can link or switch groups.
- "who owes what" → get_balances, then summarise. "what did we add" → list_expenses, then summarise.

Reply style: WhatsApp, short and friendly. A full receipt (amounts, payer, per-person split, assumptions) is appended automatically for every expense or draft you record, so do NOT restate amounts or splits and do not write "Added"/"Done". Your own text should be EMPTY unless you are asking a question or summarising balances/lists. Questions must be short and specific about the one thing you're unsure of (e.g. "Is Devu = Dev Nair?"), without repeating amounts. Never claim you did something you didn't do via a tool.`;

// ── Group context ───────────────────────────────────────────────

/** First names, falling back to full names when two members share one. */
function nameMap(members: sw.SwUser[]) {
  const counts = new Map<string, number>();
  members.forEach((m) => counts.set(m.first_name, (counts.get(m.first_name) ?? 0) + 1));
  return new Map(members.map((m) => [m.id, counts.get(m.first_name)! > 1 ? sw.swName(m) : m.first_name]));
}

async function groupContext(groupJid: string) {
  const link = store.getGroupLink(groupJid);
  const group = link?.splitwise_group_id ? await sw.getGroup(link.splitwise_group_id) : null;
  const members = group?.members ?? [];
  return {
    link,
    group,
    members,
    names: nameMap(members),
    memberIds: members.map((m) => m.id),
    /** Per-chat overrides of the global defaults. */
    currency: (link?.currency || config.bot.defaultCurrency).toUpperCase(),
    confirmMode: link?.confirm_mode ?? config.bot.confirmMode,
  };
}

type GroupCtx = Awaited<ReturnType<typeof groupContext>>;

function receipt(ctx: GroupCtx, spec: ExpenseSpec, status: ReceiptStatus, ref: string, assumptions?: string[], checks?: string[]) {
  return formatReceipt({ spec, names: ctx.names, memberIds: ctx.memberIds, status, ref, assumptions, checks });
}

const hashOf = (image?: Image) => (image ? createHash('sha256').update(image.data).digest('hex') : null);

// Tool arguments come from a model: nulls for "not given", numbers as strings, {user_id} objects where ids belong.
const dropNulls = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(dropNulls)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== '').map(([k, x]) => [k, dropNulls(x)]))
      : v;
const amount = z.coerce.number().refine(Number.isFinite, 'must be a number');
const userId = z.coerce.number().int();
const person = z.preprocess(
  (v) => (v && typeof v === 'object' ? v : { user_id: v }),
  z.object({ user_id: userId, value: amount.optional(), amount: amount.optional() }),
);
const RawSpec = z.object({
  description: z.string().trim().max(200).optional(),
  cost: amount,
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'must be a 3-letter ISO code like INR').optional(),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}/, 'must be YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d.slice(0, 10))), 'is not a real date').optional(),
  category: z.string().trim().max(80).optional(),
  notes: z.string().max(2000).optional(),
  payment: z.boolean().optional(),
  payers: z.array(person).optional(),
  split: z
    .object({
      type: z.enum(['equal', 'exact', 'percent', 'shares', 'adjustment']).optional(),
      participants: z.array(person).optional(),
      subtotal: amount.optional(),
      items: z
        .array(
          z.object({
            name: z.string().optional(),
            amount,
            user_ids: z.array(z.preprocess((u) => (u && typeof u === 'object' ? (u as { user_id?: unknown }).user_id : u), userId)).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

function parseSpec(raw: unknown, ctx: GroupCtx): ExpenseSpec {
  const parsed = RawSpec.safeParse(dropNulls(raw ?? {}));
  if (!parsed.success) {
    throw new Error('Invalid expense: ' + parsed.error.issues.map((i) => `${i.path.join('.') || 'spec'} ${i.message}`).join('; '));
  }
  const r = parsed.data;
  const spec: ExpenseSpec = {
    description: r.description || 'Expense',
    cost: r.cost,
    currency: (r.currency || ctx.currency).toUpperCase(),
    date: r.date?.slice(0, 10),
    category: r.category || undefined,
    notes: r.notes || undefined,
    payment: r.payment || undefined,
    payers: (r.payers ?? []).map((p) => ({ user_id: p.user_id, amount: p.amount })),
    split: {
      type: r.split?.type ?? 'equal',
      participants: (r.split?.participants ?? []).map((p) => ({ user_id: p.user_id, value: p.value })),
      subtotal: r.split?.subtotal || undefined,
      items: r.split?.items?.map((it) => ({ name: it.name, amount: it.amount, user_ids: it.user_ids ?? [] })),
    },
  };
  const ids = new Set(ctx.memberIds);
  const itemIds = (spec.split.items ?? []).flatMap((it) => it.user_ids.map((user_id) => ({ user_id })));
  const bad = [...spec.payers, ...spec.split.participants, ...itemIds].filter((u) => !ids.has(u.user_id));
  if (bad.length) throw new Error(`user_id ${[...new Set(bad.map((b) => b.user_id))].join(', ')} not in the Splitwise group member list`);
  const expanded = expandItems(spec); // items → per-person extras, which the receipt and Splitwise payload understand
  computeShares(expanded); // throws SplitError with a readable message the model can fix
  return expanded;
}

/** Push to Splitwise (or pretend to, in dry run) and remember it. Returns the expense id and its receipt. */
async function pushExpense(
  ctx: GroupCtx,
  spec: ExpenseSpec,
  o: {
    groupJid: string;
    jobId: number;
    dryRun: boolean;
    image?: Image;
    imageHash?: string | null;
    assumptions?: string[];
    checks?: string[];
    requestJobId?: number | null;
  },
) {
  if (o.dryRun) {
    const fakeId = -(Date.now() % 1e6);
    return { id: fakeId, text: receipt(ctx, spec, 'dry-run', `#${fakeId}`, o.assumptions, o.checks) };
  }
  const addedBy = store.getJob(o.requestJobId ?? o.jobId)?.sender_name ?? undefined;
  const { expense, verified } = await sw.createExpense(spec, ctx.group!.id, { receipt: o.image, addedBy });
  store.saveExpense({
    splitwise_expense_id: expense.id,
    job_id: o.jobId,
    wa_group_jid: o.groupJid,
    splitwise_group_id: ctx.group!.id,
    description: spec.payment ? 'Payment' : spec.description,
    cost: String(spec.cost),
    currency: spec.currency,
    spec: JSON.stringify(spec),
    image_hash: o.imageHash ?? hashOf(o.image),
  });
  let text = receipt(ctx, spec, 'added', `#${expense.id}`, o.assumptions, o.checks);
  if (!verified) {
    log.error(`Splitwise stored different shares than computed for #${expense.id}`, { spec, stored: expense.users });
    text += `\n⚠️ Splitwise shows different shares than the ones above — please check #${expense.id} in the app.`;
  }
  return { id: expense.id, text };
}

function draftImage(draftId: number): Image | undefined {
  const file = path.join(RECEIPT_DIR, `draft-${draftId}.jpg`);
  return fs.existsSync(file) ? { data: fs.readFileSync(file), mime: 'image/jpeg' } : undefined;
}

async function confirmOne(ctx: GroupCtx, draft: store.Draft, jobId: number, corrected?: ExpenseSpec) {
  const spec = corrected ?? (JSON.parse(draft.spec) as ExpenseSpec);
  const pushed = await pushExpense(ctx, spec, {
    groupJid: draft.wa_group_jid,
    jobId,
    dryRun: !!draft.dry_run,
    image: draftImage(draft.id),
    imageHash: draft.image_hash,
    requestJobId: draft.job_id,
  });
  store.setDraftStatus(draft.id, 'confirmed', pushed.id);
  // The group said yes, so the nicknames the model matched are right; keep those still in the final expense.
  if (!draft.dry_run) rememberAliases(draft.wa_group_jid, safeJson<store.Alias[]>(draft.aliases, []), spec);
  fs.rmSync(path.join(RECEIPT_DIR, `draft-${draft.id}.jpg`), { force: true });
  // The group already saw the full split on the draft; an unchanged confirmation is just one line.
  if (!corrected) {
    const what = `*${spec.description}* · ${money(spec.cost, spec.currency)}`;
    pushed.text = draft.dry_run ? `🧪 Dry run · would add ${what} · nothing sent` : `✅ Added to Splitwise · ${what} · #${pushed.id}`;
  }
  return pushed;
}

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

function rememberAliases(groupJid: string, aliases: store.Alias[], spec: ExpenseSpec) {
  const used = new Set([...spec.payers, ...spec.split.participants].map((p) => p.user_id));
  for (const a of aliases) if (used.has(a.splitwise_user_id)) store.saveAlias(groupJid, a.alias, a.splitwise_user_id);
}

/** The receipt a pending draft was shown with (dashboard). */
export async function draftPreview(draft: store.Draft): Promise<string> {
  const ctx = await groupContext(draft.wa_group_jid);
  return receipt(ctx, JSON.parse(draft.spec) as ExpenseSpec, 'draft', `D${draft.id}`, safeJson<string[]>(draft.assumptions, []), safeJson<string[]>(draft.checks, []));
}

/** Names of a chat's Splitwise members, for showing who paid and who owes outside the agent. */
export async function groupNames(groupJid: string) {
  const ctx = await groupContext(groupJid);
  return { names: ctx.names, memberIds: ctx.memberIds };
}

/** Totals of what the bot logged in a chat since `since` (0 = everything), plus the current balances. */
export async function groupSummary(groupJid: string, title: string, since = 0): Promise<string> {
  const specs = store.listExpenses({ group: groupJid, since, limit: 2000 }).map((e) => safeJson<ExpenseSpec | null>(e.spec, null)).filter((x): x is ExpenseSpec => !!x);
  const parts = [formatSummary(title, specs)];
  const ctx = await groupContext(groupJid);
  if (ctx.group) {
    try {
      const g = await sw.getGroup(ctx.group.id, true);
      parts.push(formatBalances((g.simplified_debts?.length ? g.simplified_debts : g.original_debts) ?? [], ctx.names));
    } catch (err) {
      log.warn('Balances for the summary failed', errMsg(err));
    }
  }
  return parts.join('\n\n');
}

// ── Entry points ────────────────────────────────────────────────

/** Poll answers: 2–12 distinct short strings (WhatsApp's limits), or none. */
function cleanOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const opts = [...new Set(raw.map((o) => String(o).trim().slice(0, 100)).filter(Boolean))].slice(0, 12);
  return opts.length >= 2 ? opts : [];
}

/** What the bot was answering in an earlier job: that job's own input (message, OCR'd bill, its earlier context) and reply. */
function earlierContext(jobId: number): string {
  const job = store.getJob(jobId);
  if (!job) return '';
  let user = '';
  try {
    const ctx = (JSON.parse(job.trace ?? '[]') as { step: string; user?: string }[]).find((t) => t.step === 'context');
    user = ctx?.user ?? '';
  } catch {}
  if (!user) user = `${job.sender_name ?? 'Someone'}: ${job.text ?? ''}`;
  return `${user.slice(-6000)}\nYou replied: ${(job.reply ?? '').slice(0, 1500)}`;
}

/** Messages asking for a split by who ate/had what. */
const ITEM_SPLIT = /\b(items?|ate|eaten|what (they|we|each|everyone) (had|ate|ordered)|accordingly|based on (what|the items|items|consumption))\b/i;

const FINAL_TOOLS = new Set(['create_expense', 'record_payment', 'remember_note', 'confirm_draft', 'discard_draft', 'update_expense', 'delete_expense', 'link_group']);

// "yes" in English, Manglish and emoji. Anything longer (e.g. "yes but Dev wasn't there") goes to the agent.
const AFFIRMATIVE =
  /^\s*(y|ya|yes|yeah|yep|yup|ok|okay|okk*|ok da|ok bro|sure|confirm(ed)?|go( ahead)?|add( it| them| both| all)?|push( it)?|correct|right|perfect|haan|han|ha|sheri|seri|shari|athe|aanu|mathi|done|👍|✅|👌|☑️|✔️|💯)[\s.!👍✅👌☑️✔️💯🏻🏼🏽🏾🏿]*$/iu;

const NEGATIVE = /^\s*(no|nope|nah|cancel( it| this| that)?|discard|drop( it)?|don'?t( add)?( it)?|venda|👎|❌)[\s.!]*$/iu;
const UNDO = /^\s*(undo|delete( it| this| that)?|remove( it| this| that)?|cancel( it| this| that)?)[\s.!]*$/i;
const HELP_RE = /^\s*(help|\?+|commands?|how (do|to) (i |we )?use( you| this| it)?|what can you do)[\s?.!]*$/i;
const BALANCES_RE = /^\s*(balances?|who owes( (what|who|whom))?|settle ?up|kanakku)[\s?.!]*$/i;
const SUMMARY_RE = /^\s*((trip|today'?s?|daily) )?(summary|totals?|digest)( (today|so far))?[\s?.!]*$/i;

export const HELP_TEXT = [
  '💸 *Splitbot* — tag me or reply to one of my messages.',
  '',
  '• _dinner 2400_ — you paid, split with everyone',
  '• _cab 850 me and Arjun_ · _lunch 1800 everyone except Dev_',
  '• _Priya paid 3000 for the hotel_ · _60/40 between me and Kiran_',
  '• 📷 bill photo or PDF, with who paid / who had what',
  '• 🎙️ voice note as a reply to me',
  '• _I paid Rahul 500_ — settle up',
  '• Reply to a receipt: _undo_ · _make it 2600_ · _Rahul wasn\'t there_',
  '• _balances_ · _summary_ · _remember Dev doesn\'t drink_',
  '',
  'Drafts (📝) wait for a 👍 or a _yes_.',
].join('\n');

const fast = (name: string, reply: string, extra: Partial<AgentResult> = {}): AgentResult => ({
  reply,
  expenseIds: [],
  draftIds: [],
  trace: [{ step: 'fast', name }],
  ...extra,
});

/** Things that need no model: yes/no to a draft, undo on a receipt, help, balances, summary. Faster, free, and can't be misread. */
async function fastPath(input: AgentInput): Promise<AgentResult | null> {
  const { text, groupJid } = input;
  if (input.images.length) return null;
  const q = input.quoted?.fromBot ? input.quoted : undefined;

  if (q?.draftIds.length && AFFIRMATIVE.test(text)) return confirmDrafts(groupJid, q.draftIds, input.jobId);
  if (q?.draftIds.length && (NEGATIVE.test(text) || UNDO.test(text))) {
    const lines: string[] = [];
    for (const id of q.draftIds) {
      const d = store.getDraft(id);
      if (!d || d.status !== 'pending' || d.wa_group_jid !== groupJid) continue;
      store.setDraftStatus(id, 'discarded');
      fs.rmSync(path.join(RECEIPT_DIR, `draft-${id}.jpg`), { force: true });
      lines.push(`🗑️ Dropped draft D${id} · ${oneLine(JSON.parse(d.spec) as ExpenseSpec)}`);
    }
    return fast('discard', lines.join('\n') || 'That draft was already handled 👍');
  }
  if (q?.expenseIds.length && UNDO.test(text)) {
    const ctx = await groupContext(groupJid);
    const lines: string[] = [];
    for (const id of q.expenseIds) {
      const row = store.getExpense(id);
      if (!row || row.wa_group_jid !== groupJid || row.deleted) continue;
      if (!input.dryRun) {
        await sw.deleteExpense(id, ctx.group?.id);
        store.markExpenseDeleted(id);
      }
      lines.push(`${input.dryRun ? '🧪 Dry run · would delete' : '🗑️ Deleted from Splitwise'} *${row.description}* · ${money(row.cost, row.currency)} · #${id}`);
    }
    return fast('undo', lines.join('\n') || 'That one is already gone 👍');
  }

  if (HELP_RE.test(text)) return fast('help', HELP_TEXT);

  const link = store.getGroupLink(groupJid);
  if (!link?.splitwise_group_id) {
    // Which Splitwise group a chat writes to is the owner's call; nobody else gets the list of the owner's groups.
    if (!(await isOwner(input.sender))) {
      return fast('unlinked', '🔒 This chat isn\'t connected to a Splitwise group yet. The person who runs the bot can connect it by tagging me with _"use <Splitwise group name>"_, or on the dashboard.');
    }
    return null;
  }
  if (BALANCES_RE.test(text)) {
    const ctx = await groupContext(groupJid);
    const g = await sw.getGroup(ctx.group!.id, true);
    return fast('balances', formatBalances((g.simplified_debts?.length ? g.simplified_debts : g.original_debts) ?? [], ctx.names));
  }
  if (SUMMARY_RE.test(text)) {
    const todayOnly = /today|daily/i.test(text);
    return fast('summary', await groupSummary(groupJid, todayOnly ? '📊 *Today*' : '📊 *Summary*', todayOnly ? store.startOfDay() : 0));
  }
  return null;
}

/** Simple, unambiguous messages are answered by code; everything else goes to the agent. */
export async function handleMessage(input: AgentInput): Promise<AgentResult> {
  const result = (await fastPath(input)) ?? (await runAgent(input));
  if (input.transcript && result.reply) result.reply = `🎙️ _Heard: "${input.transcript.slice(0, 300)}"_\n\n${result.reply}`;
  return result;
}

export async function confirmDrafts(groupJid: string, draftIds: number[], jobId: number): Promise<AgentResult> {
  const ctx = await groupContext(groupJid);
  const texts: string[] = [];
  const expenseIds: number[] = [];
  for (const id of draftIds) {
    const draft = store.getDraft(id);
    if (!draft || draft.status !== 'pending') continue;
    const pushed = await confirmOne(ctx, draft, jobId);
    expenseIds.push(pushed.id);
    texts.push(pushed.text);
  }
  return {
    reply: texts.join('\n\n') || 'That draft was already handled 👍',
    expenseIds,
    draftIds: [],
    trace: [{ step: 'confirm', draftIds }],
  };
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const trace: unknown[] = [];
  const receipts: string[] = [];
  const expenseIds: number[] = [];
  const draftIds: number[] = [];
  const created = new Map<string, unknown>();
  const questions: { text: string; options: string[] }[] = [];
  /** ask_user messages: explanations and questions that stand on their own (no receipt). */
  const asked: string[] = [];
  /** Expenses the model was already told were edited outside the bot; the second update goes through. */
  const staleAcked = new Set<number>();

  // Stage 1: images → structured bill data via the vision/OCR model, while the Splitwise context loads.
  const readOne = async (img: Image) => {
    const t0 = Date.now();
    const bill = await readBill(img, input.text);
    trace.push({ step: 'vision', bill, ms: Date.now() - t0 });
    return bill;
  };
  const [bills, me, ctx, owner] = await Promise.all([
    Promise.all(input.images.map(readOne)),
    sw.currentUser(),
    groupContext(input.groupJid),
    isOwner(input.sender),
  ]);
  const { group, members, names } = ctx;
  const memberIds = new Set(ctx.memberIds);
  const contactsBySw = new Map(input.participants.filter((c) => c.splitwise_user_id).map((c) => [c.splitwise_user_id!, c]));
  const drafts = store.pendingDrafts(input.groupJid);
  const aliases = store.listAliases(input.groupJid).filter((a) => memberIds.has(a.splitwise_user_id));

  // ── Context for the model ──
  const lines: string[] = [];
  lines.push(`Today: ${today()} (${config.bot.timezone}). Default currency: ${ctx.currency}.`);
  lines.push(`WhatsApp group: "${input.groupName ?? input.groupJid}".`);
  if (group) {
    lines.push(`Linked Splitwise group: "${group.name}" (id ${group.id}). Members (${members.length}):`);
    for (const m of members) {
      const c = contactsBySw.get(m.id);
      const wa = c ? ` | WhatsApp: "${c.push_name ?? '?'}" (wa_contact_id ${c.id})` : ' | WhatsApp: not linked yet';
      lines.push(`- user_id ${m.id}: ${sw.swName(m)}${m.id === me.id ? ' (bot owner)' : ''}${wa}`);
    }
    if (aliases.length) lines.push('Known nicknames (confirmed by the group): ' + aliases.map((a) => `"${a.alias}" = user_id ${a.splitwise_user_id} (${names.get(a.splitwise_user_id)})`).join('; '));
    if (ctx.link?.notes?.trim()) lines.push(`Standing instructions from the group:\n${ctx.link.notes.trim()}`);
  } else {
    // Only the owner gets here for an unlinked chat (see fastPath), so listing their groups is fine.
    const groups = await sw.listGroups();
    lines.push('This WhatsApp group is NOT linked to a Splitwise group yet. Expenses cannot be added until it is.');
    lines.push('Available Splitwise groups: ' + groups.map((g) => `${g.id}: "${g.name}" (${g.members.length} members)`).join('; '));
  }
  const unlinked = input.participants.filter((c) => !c.splitwise_user_id || !memberIds.has(c.splitwise_user_id));
  if (unlinked.length) {
    lines.push('WhatsApp people not linked to a member yet: ' +
      unlinked.map((c) => `wa_contact_id ${c.id} "${c.push_name ?? 'unknown'}"`).join('; '));
  }
  const s = input.sender;
  const senderSw = s.splitwise_user_id && memberIds.has(s.splitwise_user_id) ? s.splitwise_user_id : null;
  lines.push(
    `Sender: "${s.push_name ?? 'unknown'}" (wa_contact_id ${s.id})` +
      (senderSw ? ` = Splitwise user_id ${senderSw} (${names.get(senderSw)})` : ' — NOT linked to a Splitwise member yet') +
      (owner ? ' — the bot owner' : ''),
  );
  if (drafts.length) {
    lines.push('Pending drafts (not in Splitwise yet):');
    for (const d of drafts) lines.push(`- draft_id ${d.id}: ${d.spec} | assumptions: ${d.assumptions}`);
  }
  const recent = store.recentExpenses(input.groupJid, 8);
  if (recent.length) {
    lines.push('Expenses you recently added in this group (newest first):');
    for (const e of recent) lines.push(`- expense_id ${e.splitwise_expense_id}: ${e.spec}`);
  }
  if (input.recentChat.length) {
    lines.push('Recent group chat (oldest first, for context only):');
    for (const m of input.recentChat) lines.push(`  ${m.name}: ${m.text.slice(0, 200)}`);
  }

  const userParts: string[] = [];
  if (input.quoted) {
    const q = input.quoted;
    const about = [
      q.draftIds.length ? `draft(s) ${q.draftIds.join(', ')}` : '',
      q.expenseIds.length ? `expense(s) ${q.expenseIds.join(', ')}` : '',
    ].filter(Boolean).join(' and ');
    userParts.push(
      q.fromBot
        ? `[Replying to your earlier message${about ? ` about ${about}` : ''}: "${q.text.slice(0, 600)}"]`
        : `[Replying to a message: "${q.text.slice(0, 600)}"]`,
    );
  }
  const earlier = input.quoted?.fromBot && input.quoted.jobId ? earlierContext(input.quoted.jobId) : '';
  if (earlier) userParts.unshift(`[Earlier conversation this reply continues (bill data still applies):\n${earlier}]`);
  bills.forEach((b, i) => userParts.push(`[Attached image ${i + 1}, read by OCR: ${JSON.stringify(b)}]`));
  userParts.push(`${s.push_name ?? 'Sender'}: ${input.text || '(no text)'}`);

  const system = `${SYSTEM_RULES}\n\n${lines.join('\n')}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') },
  ];
  trace.push({ step: 'context', system, user: userParts.join('\n') });

  const tools = group
    ? TOOLS.filter((t) => owner || t.function.name !== 'link_group')
    : TOOLS.filter((t) => ['link_group', 'not_about_expenses'].includes(t.function.name));
  let finalText = '';
  // Once a model fails mid-message, later steps start from the one that answered instead of retrying it.
  let chain = agentModels();
  let poll: Poll | undefined;
  const failures: string[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    // After two failed attempts, stop retrying: the model has to explain the problem and ask the group.
    const stuck = failures.length >= 2;
    if (stuck) {
      messages.push({
        role: 'user',
        content:
          `[System: the expense could not be recorded: ${failures.at(-1)}. Do not call create_expense again. Call ask_user: ` +
          'say in plain words what does not add up (with the numbers), propose the most likely fix, and ask the group to confirm or correct it.]',
      });
    }
    const stepTools = stuck ? tools.filter((t) => t.function.name === 'ask_user') : tools;
    const t0 = Date.now();
    const res = await chat(chain, messages, { tools: stepTools });
    chain = chain.slice(Math.max(0, chain.findIndex((m) => m.id === res.model)));
    trace.push({ step: 'llm', model: res.model, content: res.content, tool_calls: res.tool_calls, usage: res.usage, ms: Date.now() - t0 });
    if (!res.tool_calls.length) {
      finalText = res.content ?? '';
      break;
    }
    if (res.tool_calls.some((c) => c.function.name === 'not_about_expenses') && !receipts.length) {
      trace.push({ step: 'tool', name: 'not_about_expenses', args: '{}', result: { ok: true }, ms: 0 });
      return { reply: '', expenseIds, draftIds, trace, offTopic: true };
    }
    messages.push({ role: 'assistant', content: res.content, tool_calls: res.tool_calls });
    for (const call of res.tool_calls) {
      let result: unknown;
      const t1 = Date.now();
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        result = tools.some((t) => t.function.name === call.function.name)
          ? await runTool(call.function.name, args)
          : { error: `${call.function.name} is not available right now${group ? '' : ' — link a Splitwise group first'}` };
      } catch (err) {
        result = { error: errMsg(err) };
      }
      trace.push({ step: 'tool', name: call.function.name, args: call.function.arguments, result, ms: Date.now() - t1 });
      log.info(`tool ${call.function.name}`, result);
      const error = (result as { error?: string })?.error;
      if (error && ['create_expense', 'record_payment', 'confirm_draft', 'update_expense'].includes(call.function.name)) failures.push(error);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
    // Recording actions produce their own receipts; when they all succeeded there's nothing left for the model
    // to say, so skip the follow-up call (halves tokens and latency).
    const called = res.tool_calls.map((c) => c.function.name);
    const results = messages.slice(-res.tool_calls.length).map((m) => JSON.parse((m as { content: string }).content));
    const moreToDo = res.tool_calls.some((c) => /"more_expenses_to_record"\s*:\s*true/.test(c.function.arguments));
    const done = called.some((n) => FINAL_TOOLS.has(n)) && called.every((n) => FINAL_TOOLS.has(n) || n === 'link_member');
    if (done && !moreToDo && results.every((r) => !r?.error)) {
      finalText = res.content ?? '';
      break;
    }
    if (called.includes('ask_user')) break;
    if (stuck) break;
  }
  // The model never managed to explain: say what went wrong ourselves, so people can correct it by replying.
  if (failures.length && !receipts.length && !asked.length && !finalText.trim()) {
    asked.push(`⚠️ I couldn't work out this split: ${failures.at(-1)}\nReply to this message with the fix (e.g. which items, who had them, or the right total) and I'll redo it.`);
  }
  // The first question that comes with choices goes out as a poll instead of a text line.
  const pollAt = questions.findIndex((q) => q.options.length >= 2);
  if (pollAt >= 0) poll = { question: questions[pollAt].text, options: questions[pollAt].options };
  finalText = [finalText.trim(), ...questions.filter((_, i) => i !== pollAt).map((q) => `❓ ${q.text}`)].filter(Boolean).join('\n');

  const FILLER = /^[\s\p{Extended_Pictographic}️.!]*(added|done|ok(ay)?|logged|got it)?[\s\p{Extended_Pictographic}️.!]*$/iu;
  if (receipts.length && FILLER.test(finalText)) finalText = '';
  // Receipts speak for themselves; of the model's own words keep only questions ("I'll record this…" is noise).
  if (receipts.length) finalText = finalText.split('\n').filter((l) => l.includes('?')).join('\n');
  const parts = [...asked, finalText.trim(), ...receipts];
  if (draftIds.length) parts.push(DRAFT_FOOTER);
  const reply = parts.filter(Boolean).join('\n\n') || (poll ? '' : '🤔 Not sure what to do with that — try e.g. "dinner 2400, I paid".');
  return { reply, expenseIds, draftIds, trace, poll };

  // ── Checks done by code, whatever the model thinks ──

  /** Reasons a human should look before this goes to Splitwise. Any reason turns the expense into a draft. */
  async function riskChecks(spec: ExpenseSpec, imageHash: string | null): Promise<string[]> {
    const checks: string[] = [];
    if (bills.some((b) => 'uncertain' in b && b.uncertain)) checks.push('two readings of the bill gave different totals');
    const day = 86_400_000;
    const date = spec.date ?? today();
    const when = Date.parse(date);
    if (when > Date.now() + 1.5 * day) checks.push(`the date ${date} is in the future`);
    else if (when < Date.now() - 60 * day) checks.push(`the date ${date} is more than 2 months ago`);

    if (!spec.payment) {
      const usual = store.groupAmounts(input.groupJid, spec.currency);
      if (usual.length >= 5 && spec.cost > Math.max(...usual) * 5) {
        checks.push(`${money(spec.cost, spec.currency)} is over 5× the biggest expense here so far`);
      }
    }

    // The same thing twice: same bill photo, or same amount on the same day paid by the same people.
    const payers = (x: ExpenseSpec) => x.payers.map((p) => p.user_id).sort().join();
    const sameAs = (x: ExpenseSpec) => x.cost === spec.cost && x.currency === spec.currency && (x.date ?? '') === (spec.date ?? '') && payers(x) === payers(spec) && !!x.payment === !!spec.payment;
    // Expenses and drafts from this same message are not duplicates (one bill can become two expenses).
    const local = store.listExpenses({ group: input.groupJid, since: Date.now() - 3 * day, limit: 200 }).filter((e) => e.job_id !== input.jobId);
    const specOf = (json: string) => safeJson<ExpenseSpec | null>(json, null);
    const matches = (x: { image_hash: string | null; spec: string; created_at: number }) => {
      if (imageHash && x.image_hash === imageHash) return true;
      const other = specOf(x.spec);
      return !!other && Date.now() - x.created_at < day && sameAs(other);
    };
    const dup = local.find(matches);
    if (dup) checks.push(`looks like #${dup.splitwise_expense_id} "${dup.description}" which is already added`);
    const pending = drafts.find((d) => d.job_id !== input.jobId && matches(d));
    if (!dup && pending) checks.push(`same as draft D${pending.id}, which is still waiting`);
    // Added by hand in the Splitwise app (the bot's own ones were covered above).
    if (!dup && group && !spec.payment && !input.dryRun) {
      try {
        const known = new Set(local.map((e) => e.splitwise_expense_id));
        const remote = (await sw.listExpenses(group.id, 30, 60_000)).find(
          (e) => !known.has(e.id) && !e.payment && Number(e.cost) === spec.cost && e.currency_code === spec.currency && e.date.slice(0, 10) === date,
        );
        if (remote) checks.push(`Splitwise already has "${remote.description}" for the same amount on ${date} (#${remote.id})`);
      } catch (err) {
        log.warn('Duplicate check against Splitwise failed', errMsg(err));
      }
    }
    if (checks.length) trace.push({ step: 'flags', flags: checks });
    return checks;
  }

  /** Record a validated spec: straight to Splitwise, or as a draft when the mode, the model or a risk check says so. */
  async function record(spec: ExpenseSpec, args: any, media?: Image) {
    // Any attachment identifies a repeat; only photos are attached to the Splitwise expense as its receipt.
    const image = media?.mime.startsWith('image/') ? media : undefined;
    const dryRun = !!input.dryRun;
    const assumptions: string[] = Array.isArray(args.assumptions) ? args.assumptions.map(String).filter(Boolean) : [];
    // Models sometimes repeat a successful call; never record the same expense twice in one turn.
    const key = JSON.stringify([spec.description.toLowerCase(), spec.cost, spec.currency, !!spec.payment]);
    if (created.has(key)) return { ok: true, note: 'Already recorded in this turn — not recorded again.', ...(created.get(key) as object) };

    const imageHash = hashOf(media);
    const checks = await riskChecks(spec, imageHash);
    const nicknames: store.Alias[] = (Array.isArray(args.nicknames) ? args.nicknames : [])
      .map((n: any) => ({ alias: String(n?.nickname ?? '').trim().toLowerCase(), splitwise_user_id: Number(n?.user_id) }))
      .filter((n: store.Alias) => n.alias.length >= 2 && n.alias.length <= 40 && memberIds.has(n.splitwise_user_id));

    const mode = ctx.confirmMode;
    const asDraft = mode === 'always' || (mode === 'auto' && (args.needs_confirmation === true || checks.length > 0));
    if (typeof args.question === 'string' && args.question.trim()) questions.push({ text: args.question.trim(), options: cleanOptions(args.options) });
    if (asDraft) {
      const id = store.createDraft({ groupJid: input.groupJid, jobId: input.jobId, spec, assumptions, dryRun, imageHash, aliases: nicknames, checks });
      if (image) {
        fs.mkdirSync(RECEIPT_DIR, { recursive: true });
        fs.writeFileSync(path.join(RECEIPT_DIR, `draft-${id}.jpg`), image.data);
      }
      draftIds.push(id);
      receipts.push(receipt(ctx, spec, 'draft', `D${id}`, assumptions, checks));
      const res = { ok: true, draft_id: id, status: 'Saved as a draft; waiting for the group to confirm. Ask your question in the reply.' };
      created.set(key, res);
      return res;
    }
    const pushed = await pushExpense(ctx, spec, { groupJid: input.groupJid, jobId: input.jobId, dryRun, image, imageHash, assumptions, checks });
    if (!dryRun) rememberAliases(input.groupJid, nicknames, spec);
    expenseIds.push(pushed.id);
    receipts.push(pushed.text);
    const res = { ok: true, expense_id: pushed.id, status: 'Added to Splitwise. Do not record it again.' };
    created.set(key, res);
    return res;
  }

  /**
   * The model may only touch expenses of THIS chat's Splitwise group: ones the bot added here, or (for ones added by
   * hand) ones Splitwise itself says belong to the linked group. Returns the local row and the current remote state.
   */
  async function ownExpense(id: number, dryRun: boolean): Promise<{ row?: store.ExpenseRow; remote?: sw.SwExpense; error?: string }> {
    if (!Number.isInteger(id)) return { error: 'expense_id must be a number' };
    const row = store.getExpense(id);
    if (row && row.wa_group_jid !== input.groupJid) return { error: `Expense #${id} does not belong to this group` };
    if (id < 0 || (dryRun && row)) return { row }; // dry-run ids are made up; nothing to look up
    let remote: sw.SwExpense;
    try {
      remote = await sw.getExpense(id);
    } catch (err) {
      return { error: `Could not look up expense #${id} in Splitwise: ${errMsg(err)}` };
    }
    if (remote.group_id !== group!.id) return { error: `Expense #${id} does not belong to this group` };
    if (remote.deleted_at) {
      if (row) store.markExpenseDeleted(id);
      return { error: `Expense #${id} was already deleted in Splitwise` };
    }
    return { row, remote };
  }

  // ── Tool implementations (closures over this message's context) ──

  async function runTool(name: string, args: any): Promise<unknown> {
    const dryRun = !!input.dryRun;
    switch (name) {
      case 'create_expense': {
        // "Split by what we ate" on a bill but no items given: that's a placeholder split; ask who had what first.
        if (bills.length && !args.split?.items?.length && ITEM_SPLIT.test(input.text)) {
          return { error: 'The user asked to split by items, but you gave no split.items. Do not record a placeholder — call ask_user to ask who had which items.' };
        }
        const spec = parseSpec({ ...args, payment: undefined }, ctx);
        return record(spec, args, input.images.length === 1 ? input.images[0] : undefined);
      }
      case 'record_payment': {
        const from = Number(args.from_user_id);
        const to = Number(args.to_user_id);
        if (from === to) return { error: 'from_user_id and to_user_id must be different people' };
        const spec = parseSpec(
          {
            description: 'Payment',
            cost: args.amount,
            currency: args.currency,
            date: args.date,
            payment: true,
            payers: [{ user_id: from }],
            split: { type: 'exact', participants: [{ user_id: to, value: args.amount }] },
          },
          ctx,
        );
        return record(spec, args);
      }
      case 'remember_note': {
        const note = String(args.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!note) return { error: 'note is required' };
        const line = `- ${note} (${s.push_name ?? 'someone'}, ${today()})`;
        const next = [ctx.link?.notes?.trim(), line].filter(Boolean).join('\n');
        if (next.length > 1000) return { error: 'The standing instructions are full. Ask the bot owner to tidy them up on the dashboard.' };
        if (!dryRun) store.setGroupSettings(input.groupJid, { notes: next });
        receipts.push(`📌 Noted for this group: _${note}_`);
        return { ok: true };
      }
      case 'ask_user': {
        const message = String(args.message ?? '').trim();
        if (!message) return { error: 'message is required' };
        const options = cleanOptions(args.options);
        if (options.length >= 2 && !poll) {
          // The explanation goes in the text; the poll title is just the question (from its first "?" sentence on).
          const sentences = message.match(/[^.?!\n]+[.?!]*\s*|\n/g) ?? [message];
          const lastQ = sentences.findLastIndex((x) => x.includes('?'));
          let from = lastQ;
          while (from > 0 && sentences[from - 1].includes('?')) from--;
          const q = lastQ >= 0 ? sentences.slice(from, lastQ + 1).join('').trim() : 'Which one?';
          poll = { question: q.slice(0, 255), options };
          const rest = (lastQ >= 0 ? [...sentences.slice(0, from), ...sentences.slice(lastQ + 1)] : sentences).join('').trim();
          if (rest) asked.push(rest);
        } else {
          asked.push(message);
        }
        return { ok: true, status: 'Sent to the group. Stop here and wait for their answer.' };
      }
      case 'confirm_draft': {
        const draft = store.getDraft(Number(args.draft_id));
        if (!draft || draft.wa_group_jid !== input.groupJid) return { error: 'No such draft in this group' };
        if (draft.status !== 'pending') return { error: `Draft already ${draft.status}` };
        const wasPayment = !!safeJson<ExpenseSpec | null>(draft.spec, null)?.payment;
        const corrected = args.spec ? parseSpec({ ...args.spec, payment: wasPayment }, ctx) : undefined;
        if (corrected && ctx.confirmMode === 'always') {
          // Every push needs an explicit yes: a corrected draft is shown again as a new draft instead of being added.
          store.setDraftStatus(draft.id, 'discarded');
          const assumptions: string[] = Array.isArray(args.assumptions) ? args.assumptions.map(String).filter(Boolean) : [];
          const id = store.createDraft({
            groupJid: input.groupJid,
            jobId: draft.job_id ?? input.jobId,
            spec: corrected,
            assumptions,
            dryRun,
            imageHash: draft.image_hash,
            aliases: safeJson<store.Alias[]>(draft.aliases, []),
          });
          const img = path.join(RECEIPT_DIR, `draft-${draft.id}.jpg`);
          if (fs.existsSync(img)) fs.renameSync(img, path.join(RECEIPT_DIR, `draft-${id}.jpg`));
          draftIds.push(id);
          receipts.push(receipt(ctx, corrected, 'draft', `D${id}`, assumptions));
          return { ok: true, draft_id: id, status: 'Corrected and saved as a new draft; waiting for the group to confirm.' };
        }
        const pushed = await confirmOne(ctx, draft, input.jobId, corrected);
        expenseIds.push(pushed.id);
        receipts.push(pushed.text);
        return { ok: true, expense_id: pushed.id };
      }
      case 'discard_draft': {
        const draft = store.getDraft(Number(args.draft_id));
        if (!draft || draft.wa_group_jid !== input.groupJid) return { error: 'No such draft in this group' };
        store.setDraftStatus(draft.id, 'discarded');
        fs.rmSync(path.join(RECEIPT_DIR, `draft-${draft.id}.jpg`), { force: true });
        receipts.push(`🗑️ Dropped draft D${draft.id} · ${oneLine(JSON.parse(draft.spec) as ExpenseSpec)}`);
        return { ok: true };
      }
      case 'update_expense': {
        const id = Number(args.expense_id);
        const own = await ownExpense(id, dryRun);
        if (own.error) return { error: own.error };
        const before = own.row ? safeJson<ExpenseSpec | null>(own.row.spec, null) : null;
        // Someone changed it in the Splitwise app since: our stored copy is stale, and sending it back would undo their edit.
        if (own.remote && before && !staleAcked.has(id) && !sw.sharesMatch(own.remote, computeShares(before))) {
          staleAcked.add(id);
          const now = own.remote.users.map((u) => `${names.get(u.user_id) ?? u.user_id} (user_id ${u.user_id}): paid ${u.paid_share}, owes ${u.owed_share}`).join('; ');
          return {
            error:
              `Expense #${id} was changed in the Splitwise app after you added it, so your copy is out of date. It is now: "${own.remote.description}", ` +
              `${own.remote.currency_code} ${own.remote.cost}, ${now}. Build the corrected spec from THIS state plus the user's change and call update_expense again.`,
          };
        }
        const spec = parseSpec({ ...args.spec, payment: before?.payment ?? own.remote?.payment ?? false }, ctx);
        let warn = '';
        if (!dryRun) {
          const { verified } = await sw.updateExpense(id, spec, group!.id, store.getJob(input.jobId)?.sender_name ?? undefined);
          store.saveExpense({
            splitwise_expense_id: id,
            job_id: own.row?.job_id ?? input.jobId,
            wa_group_jid: input.groupJid,
            splitwise_group_id: group!.id,
            description: spec.payment ? 'Payment' : spec.description,
            cost: String(spec.cost),
            currency: spec.currency,
            spec: JSON.stringify(spec),
          });
          expenseIds.push(id);
          if (!verified) warn = `\n⚠️ Splitwise shows different shares than the ones above — please check #${id} in the app.`;
        }
        receipts.push(receipt(ctx, spec, dryRun ? 'dry-run' : 'updated', `#${id}`) + warn);
        return { ok: true, expense_id: id };
      }
      case 'delete_expense': {
        const id = Number(args.expense_id);
        const own = await ownExpense(id, dryRun);
        if (own.error) return { error: own.error };
        if (!dryRun) {
          await sw.deleteExpense(id, group!.id);
          store.markExpenseDeleted(id);
        }
        const what = own.row
          ? `*${own.row.description}* · ${money(own.row.cost, own.row.currency)}`
          : own.remote
            ? `*${own.remote.description}* · ${money(own.remote.cost, own.remote.currency_code)}`
            : 'expense';
        receipts.push(`${dryRun ? '🧪 Dry run · would delete' : '🗑️ Deleted from Splitwise'} ${what} · #${id}`);
        return { ok: true };
      }
      case 'list_expenses': {
        const list = await sw.listExpenses(group!.id, Math.min(Number(args.limit) || 15, 50));
        return list.map((e) => ({
          id: e.id,
          date: e.date.slice(0, 10),
          description: e.description,
          cost: `${e.currency_code} ${e.cost}`,
          paid_by: e.users.filter((u) => Number(u.paid_share) > 0).map((u) => names.get(u.user_id) ?? u.user_id),
        }));
      }
      case 'get_balances': {
        const g = await sw.getGroup(group!.id, true);
        const debts = (g.simplified_debts?.length ? g.simplified_debts : g.original_debts) ?? [];
        return debts.length
          ? debts.map((d) => `${names.get(d.from) ?? d.from} owes ${names.get(d.to) ?? d.to} ${money(d.amount, d.currency_code)}`)
          : 'Everyone is settled up.';
      }
      case 'link_member': {
        const c = store.getContact(Number(args.wa_contact_id));
        const m = members.find((x) => x.id === Number(args.splitwise_user_id));
        if (!c) return { error: 'Unknown wa_contact_id' };
        if (!m) return { error: 'That user_id is not a member of the linked Splitwise group' };
        // Who someone is decides whose money moves on "I paid", so the model can only fill gaps, never rewrite links.
        const fixOnDashboard = 'The bot owner can change it on the dashboard.';
        if (c.splitwise_user_id === m.id) return { ok: true, note: 'Already linked.' };
        if (c.splitwise_user_id && memberIds.has(c.splitwise_user_id)) {
          return { error: `${c.push_name ?? 'That person'} is already linked to ${names.get(c.splitwise_user_id)}. ${fixOnDashboard}` };
        }
        if (store.contactsLinkedTo(m.id).some((x) => x.id !== c.id)) {
          return { error: `${sw.swName(m)} is already linked to another WhatsApp person. ${fixOnDashboard}` };
        }
        if (m.id === me.id && !(config.bot.ownerPhone && c.pn === config.bot.ownerPhone)) {
          return { error: `${sw.swName(m)} is the bot owner's account; only the owner can link it, on the dashboard.` };
        }
        const same = (a: string | null | undefined, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();
        if (c.id !== input.sender.id && !same(c.push_name, sw.swName(m)) && !same(c.push_name, m.first_name)) {
          return { error: `Only link someone other than the sender when their WhatsApp name is exactly the member's name. ${fixOnDashboard}` };
        }
        if (!dryRun) store.linkContact(c.id, m.id, sw.swName(m));
        if (c.id === input.sender.id) input.sender.splitwise_user_id = m.id;
        receipts.push(`🔗 ${c.push_name ?? 'WhatsApp user'} is *${sw.swName(m)}* on Splitwise`);
        return { ok: true };
      }
      case 'link_group': {
        if (!owner) return { error: 'Only the bot owner can connect or switch the Splitwise group.' };
        const groups = await sw.listGroups();
        const g = groups.find((x) => x.id === Number(args.splitwise_group_id));
        if (!g) return { error: 'No such Splitwise group' };
        if (!dryRun) store.linkGroup(input.groupJid, g.id, g.name);
        receipts.push(`🔗 This chat now logs to Splitwise group *${g.name}* (${g.members.length} members). Tag me with expenses anytime!`);
        return { ok: true, note: 'Linked. Ask the user to resend their expense; you cannot add it in this turn.' };
      }
      default:
        return { error: `Unknown tool ${name}` };
    }
  }
}
