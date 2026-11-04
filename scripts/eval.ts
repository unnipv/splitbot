/**
 * Accuracy eval for the agent: runs fixed scenarios (dry run, nothing reaches Splitwise) and checks the computed splits.
 *
 *   npm run eval -- --group <splitwise_group_id> --me <your_user_id> [--models openrouter:anthropic/claude-haiku-5.5,groq:openai/gpt-oss-120b@high] [--bill path.png]
 *
 * Scenario names refer to members by first name; they are resolved against the Splitwise group.
 * Uses its own DATA_DIR so the real database is untouched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    group: { type: 'string' },
    me: { type: 'string' },
    models: { type: 'string', default: 'groq:openai/gpt-oss-120b@high' },
    bill: { type: 'string' },
    only: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    vision: { type: 'string' },
  },
});
if (!args.group || !args.me) throw new Error('--group and --me are required');

// Isolated data dir with the Splitwise token, before any app module loads config.
const realData = path.resolve(process.env.DATA_DIR ?? './data');
const evalData = fs.mkdtempSync(path.join(os.tmpdir(), 'splitbot-eval-'));
fs.copyFileSync(path.join(realData, 'splitwise-token.json'), path.join(evalData, 'splitwise-token.json'));
process.env.DATA_DIR = evalData;
process.env.CONFIRM_MODE = 'auto';

const { config, parseModels } = await import('../src/config.ts');
const store = await import('../src/db.ts');
const { runAgent } = await import('../src/agent.ts');
const sw = await import('../src/splitwise.ts');
const { computeShares, expandItems } = await import('../src/split.ts');

const GROUP = 'eval@g.us';
const swGroup = await sw.getGroup(Number(args.group));
store.upsertGroup(GROUP, 'Trip');
store.linkGroup(GROUP, swGroup.id, swGroup.name);
const meId = Number(args.me);
const me = swGroup.members.find((m) => m.id === meId)!;
const sender = store.resolveContact({ pn: 'eval-sender', pushName: me.first_name });
store.linkContact(sender.id, me.id, sw.swName(me));

const byName = (first: string) => {
  const m = swGroup.members.find((x) => x.first_name.toLowerCase().startsWith(first.toLowerCase()));
  if (!m) throw new Error(`No member named ${first}`);
  return m.id;
};
const others = swGroup.members.filter((m) => m.id !== meId).map((m) => m.first_name);
if (others.length < 3) throw new Error('Pick a Splitwise group with at least 4 members');
const [A, B, C] = others; // three other members, referred to by first name in the scenarios
const all = swGroup.members.map((m) => m.id);

type Recorded = { spec: any; draft: boolean };
interface Scenario {
  name: string;
  text: string;
  bill?: boolean;
  /** Expected owed shares per expense (user id → amount), in order. Empty array = expect no expense (a question). */
  expect: { cost?: number; currency?: string; paid?: Record<number, number>; owed: Record<number, number>; draft?: boolean }[];
}

const eq = (ids: number[], total: number) => Object.fromEntries(ids.map((id) => [id, total / ids.length]));

const scenarios: Scenario[] = [
  { name: 'default split', text: 'dinner 2400', expect: [{ cost: 2400, paid: { [meId]: 2400 }, owed: eq(all, 2400), draft: false }] },
  { name: 'two people', text: `cab 850 me and ${B}`, expect: [{ owed: eq([meId, byName(B)], 850) }] },
  { name: 'other payer', text: `${A} paid 3000 for the hotel`, expect: [{ paid: { [byName(A)]: 3000 }, owed: eq(all, 3000) }] },
  {
    name: 'extra item',
    text: `drinks 2000 total, ${C} had an extra beer of 400 in that`,
    expect: [{ cost: 2000, owed: { ...eq(all.filter((i) => i !== byName(C)), 1200), [byName(C)]: 800 } }],
  },
  { name: 'percent', text: `groceries 1000 split 60/40 between me and ${A}`, expect: [{ owed: { [meId]: 600, [byName(A)]: 400 } }] },
  {
    name: 'two payers',
    text: `petrol 2500, ${B} and I paid half each, split with everyone`,
    expect: [{ paid: { [meId]: 1250, [byName(B)]: 1250 }, owed: eq(all, 2500) }],
  },
  { name: 'everyone except', text: `lunch 1800, everyone except ${C}`, expect: [{ owed: eq(all.filter((i) => i !== byName(C)), 1800) }] },
  { name: 'two expenses', text: 'taxi 300 and tolls 120, all of us', expect: [{ owed: eq(all, 300) }, { owed: eq(all, 120) }] },
  { name: 'paid for someone', text: `I paid 900 for ${A}'s museum ticket`, expect: [{ paid: { [meId]: 900 }, owed: { [byName(A)]: 900 } }] },
  {
    name: 'payer, one absent',
    text: `${C} paid 1500 for the boat, ${B} didn't come`,
    expect: [{ paid: { [byName(C)]: 1500 }, owed: eq(all.filter((i) => i !== byName(B)), 1500) }],
  },
  { name: 'foreign currency', text: `dinner 90 euros, ${B} paid`, expect: [{ currency: 'EUR', paid: { [byName(B)]: 90 }, owed: eq(all, 90) }] },
  { name: 'nickname → draft', text: `dinner 3000, ${C.slice(0, 3)}u paid`, expect: [{ paid: { [byName(C)]: 3000 }, owed: eq(all, 3000), draft: true }] },
  {
    name: 'everyone paid & owes',
    text: 'we bought baht from a forex counter for INR 242286, everyone paid and owes equal amount add this expense',
    expect: [{ cost: 242286, currency: 'INR', paid: eq(all, 242286), owed: eq(all, 242286) }],
  },
  { name: 'missing amount → ask', text: 'add lunch for those who came', expect: [] },
];
if (args.bill) {
  scenarios.push(
    { name: 'bill', text: '', bill: true, expect: [{ cost: 2330.46, currency: 'THB', owed: eq(all, 2330.46) }] },
    {
      name: 'bill, item exclusion',
      text: `dinner, ${C} didn't have beer`,
      bill: true,
      // Beer 360 of subtotal 1980 shared by the 3 others, tax/service proportional.
      expect: [{ cost: 2330.46, owed: { ...eq(all.filter((i) => i !== byName(C)), 2330.46 - 476.69), [byName(C)]: 476.69 } }],
    },
  );
}

const billImage = args.bill ? { data: fs.readFileSync(args.bill), mime: args.bill.endsWith('.png') ? 'image/png' : 'image/jpeg' } : null;

function check(sc: Scenario, recorded: Recorded[], reply: string): string | null {
  if (recorded.length !== sc.expect.length) return `expected ${sc.expect.length} expense(s), got ${recorded.length}`;
  for (const [i, exp] of sc.expect.entries()) {
    const { spec, draft } = recorded[i];
    const shares = computeShares(expandItems(spec));
    const tol = 0.05;
    if (exp.cost !== undefined && Math.abs(spec.cost - exp.cost) > tol) return `cost ${spec.cost} ≠ ${exp.cost}`;
    if (exp.currency && spec.currency !== exp.currency) return `currency ${spec.currency} ≠ ${exp.currency}`;
    const owed = Object.fromEntries(shares.filter((s) => Number(s.owed_share) > 0).map((s) => [s.user_id, Number(s.owed_share)]));
    const want = Object.fromEntries(Object.entries(exp.owed).map(([k, v]) => [Number(k), v]));
    const ids = new Set([...Object.keys(owed), ...Object.keys(want)].map(Number));
    for (const id of ids) if (Math.abs((owed[id] ?? 0) - (want[id] ?? 0)) > tol) return `owed ${JSON.stringify(owed)} ≠ ${JSON.stringify(want)}`;
    if (exp.paid) {
      const paid = Object.fromEntries(shares.filter((s) => Number(s.paid_share) > 0).map((s) => [s.user_id, Number(s.paid_share)]));
      for (const [id, v] of Object.entries(exp.paid)) if (Math.abs((paid[Number(id)] ?? 0) - v) > tol) return `paid ${JSON.stringify(paid)}`;
    }
    if (exp.draft !== undefined && draft !== exp.draft) return `draft=${draft}, expected ${exp.draft}`;
  }
  if (!sc.expect.length && !reply.includes('?')) return 'expected a question';
  return null;
}

let jobSeq = 0;
for (const modelArg of args.models!.split(',')) {
  // "provider:model[@effort]", evaluated alone (no fallback) so the score is that model's own.
  config.llm.agent = parseModels(modelArg);
  if (!config.llm.agent.length) throw new Error(`No API key for ${modelArg}`);
  // Bills are read by --vision if given, else by the model under test.
  config.llm.vision = parseModels(args.vision ?? modelArg);
  let pass = 0;
  let total = 0;
  const times: number[] = [];
  console.log(`\n━━ ${modelArg} ━━`);
  for (const sc of scenarios.filter((s) => !args.only || s.name.includes(args.only))) {
    for (let r = 0; r < Number(args.repeat); r++) {
      total++;
      // Each scenario starts clean: no drafts or expenses left over from earlier ones.
      store.db.exec("UPDATE drafts SET status = 'discarded' WHERE status = 'pending'; UPDATE expenses SET deleted = 1;");
      const started = Date.now();
      let verdict: string | null;
      try {
        const res = await runAgent({
          jobId: ++jobSeq,
          groupJid: GROUP,
          groupName: 'Trip',
          sender: store.getContact(sender.id)!,
          text: sc.text,
          images: sc.bill && billImage ? [billImage] : [],
          recentChat: [],
          participants: [],
          dryRun: true,
        });
        const recorded: Recorded[] = (res.trace as any[])
          .filter((t) => t.step === 'tool' && t.name === 'create_expense' && t.result?.ok && !t.result.note)
          .map((t) => {
            const a = JSON.parse(t.args);
            return { spec: { ...a, split: { ...a.split } }, draft: !!t.result.draft_id };
          });
        verdict = check(sc, recorded, res.reply);
        if (verdict) {
          verdict += `\n      reply: ${res.reply.replace(/\n/g, ' ⏎ ').slice(0, 400)}`;
          for (const t of res.trace as any[]) {
            if (t.step === 'tool') verdict += `\n      tool ${t.name}(${process.env.EVAL_ARGS ? t.args : '…'}) → ${JSON.stringify(t.result).slice(0, 160)}`;
            if (t.step === 'context' && process.env.EVAL_ARGS) verdict += `\n      user msg: ${String(t.user).slice(0, 600)}`;
          }
        }
      } catch (err) {
        verdict = `error: ${err instanceof Error ? err.message : err}`;
      }
      const ms = Date.now() - started;
      times.push(ms);
      if (!verdict) pass++;
      console.log(`${verdict ? '✗' : '✓'} ${sc.name.padEnd(22)} ${(ms / 1000).toFixed(1).padStart(5)}s ${verdict ?? ''}`);
    }
  }
  times.sort((a, b) => a - b);
  console.log(`→ ${pass}/${total} passed · median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)}s`);
}
fs.rmSync(evalData, { recursive: true, force: true });
