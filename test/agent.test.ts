/**
 * The agent end to end, with the two outside services replaced at the network boundary: a scripted "model" answers
 * the chat-completions calls and an in-memory Splitwise answers the API calls. Everything in between is the real code.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splitbot-agent-'));
fs.writeFileSync(path.join(dir, 'splitwise-token.json'), JSON.stringify({ access_token: 'test-token' }));
// Set every key explicitly so nothing from a developer's .env leaks into the test.
Object.assign(process.env, {
  DATA_DIR: dir,
  OPENROUTER_API_KEY: '', SARVAM_API_KEY: '', GEMINI_API_KEY: '', DEEPSEEK_API_KEY: '', CEREBRAS_API_KEY: '', LLM_API_KEY: '',
  GROQ_API_KEY: 'test',
  AGENT_MODELS: 'groq:fake', VISION_MODELS: 'groq:fake-vision', ROAST_MODELS: 'groq:fake',
  OWNER_PHONE: '919000000001',
  CONFIRM_MODE: 'auto', DEFAULT_CURRENCY: 'INR', TIMEZONE: 'Asia/Kolkata', EXPENSE_TAG: '[bot]', DENIAL_STYLE: 'plain',
});

// ── Fake Splitwise ──
const member = (id: number, first_name: string, last_name: string | null = null) => ({ id, first_name, last_name, balance: [] });
const GROUP = { id: 1, name: 'Goa Trip', members: [member(1, 'Arjun'), member(2, 'Dev', 'Nair'), member(3, 'Kiran'), member(4, 'Priya')], simplified_debts: [{ from: 2, to: 1, amount: '600.0', currency_code: 'INR' }] };
const OTHER = { id: 2, name: 'Home', members: [member(1, 'Arjun'), member(9, 'Flatmate')] };
const sw = {
  expenses: new Map<number, any>(),
  nextId: 9000,
  created: [] as Record<string, string>[],
  updated: [] as number[],
  deleted: [] as number[],
  calls: [] as string[],
};
// An expense in the owner's OTHER Splitwise group, which no chat linked to "Goa Trip" may touch.
sw.expenses.set(555, { id: 555, group_id: 2, description: 'Rent', cost: '30000.0', currency_code: 'INR', date: '2026-11-01T00:00:00Z', deleted_at: null, users: [] });

function expenseFrom(id: number, f: Record<string, string>) {
  const users = [];
  for (let i = 0; `users__${i}__user_id` in f; i++) {
    users.push({ user_id: Number(f[`users__${i}__user_id`]), paid_share: f[`users__${i}__paid_share`], owed_share: f[`users__${i}__owed_share`] });
  }
  return { id, group_id: Number(f.group_id), description: f.description, cost: f.cost, currency_code: f.currency_code, date: f.date ?? new Date().toISOString(), deleted_at: null, payment: f.payment === 'true', users };
}

function splitwise(endpoint: string, body: Record<string, string> | undefined): unknown {
  sw.calls.push(endpoint);
  const [name, arg] = endpoint.split(/[/?]/);
  switch (name) {
    case 'get_current_user': return { user: GROUP.members[0] };
    case 'get_group': return { group: GROUP };
    case 'get_groups': return { groups: [GROUP, OTHER] };
    case 'get_categories': return { categories: [] };
    case 'get_expenses': return { expenses: [...sw.expenses.values()].filter((e) => e.group_id === 1) };
    case 'get_expense': {
      const e = sw.expenses.get(Number(arg));
      return e ? { expense: e } : { errors: { base: ['Invalid API request: record not found'] } };
    }
    case 'create_expense': {
      const e = expenseFrom(sw.nextId++, body!);
      sw.expenses.set(e.id, e);
      sw.created.push(body!);
      return { expenses: [e] };
    }
    case 'update_expense': {
      const e = expenseFrom(Number(arg), body!);
      sw.expenses.set(e.id, e);
      sw.updated.push(e.id);
      return { expenses: [e] };
    }
    case 'delete_expense':
      sw.deleted.push(Number(arg));
      sw.expenses.get(Number(arg)).deleted_at = new Date().toISOString();
      return { success: true };
  }
  throw new Error(`fake Splitwise: unexpected ${endpoint}`);
}

// ── Scripted model ──
const script: unknown[] = [];
const llmCalls: { tools?: { function: { name: string } }[]; messages: { role: string; content: unknown }[] }[] = [];
const toolCall = (name: string, args: unknown) => ({ role: 'assistant', content: null, tool_calls: [{ id: `c${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const say = (content: string) => ({ role: 'assistant', content });

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.startsWith('https://api.groq.com/')) {
    llmCalls.push(JSON.parse(String(init!.body)));
    if (!script.length) throw new Error('The model was called more often than the test scripted');
    return json({ choices: [{ message: script.shift(), finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  }
  if (u.startsWith('https://secure.splitwise.com/api/v3.0/')) {
    return json(splitwise(u.split('/api/v3.0/')[1], typeof init?.body === 'string' ? JSON.parse(init.body) : undefined));
  }
  throw new Error(`Unexpected network call in a test: ${u}`);
}) as typeof fetch;

const store = await import('../src/db.ts');
const { handleMessage, confirmDrafts, HELP_TEXT } = await import('../src/agent.ts');
const { today } = await import('../src/format.ts');

const G = 'trip@g.us';
store.upsertGroup(G, 'Trip chat');
store.linkGroup(G, 1, 'Goa Trip');
const owner = store.resolveContact({ pn: '919000000001', pushName: 'Arjun' });
store.linkContact(owner.id, 1, 'Arjun');
const dev = store.resolveContact({ pn: '919000000002', pushName: 'Devu' });
store.linkContact(dev.id, 2, 'Dev Nair');
const kiran = store.resolveContact({ pn: '919000000003', pushName: 'Kiran' });
const stranger = store.resolveContact({ pn: '919000000009', pushName: 'Arjun' }); // same display name as the owner

let seq = 0;
async function send(senderId: number, text: string, extra: Partial<Parameters<typeof handleMessage>[0]> = {}) {
  const sender = store.getContact(senderId)!;
  const groupJid = extra.groupJid ?? G;
  const jobId = store.createJob({ msgId: `t${++seq}`, groupJid, groupName: 'Trip chat', senderContactId: sender.id, senderName: sender.push_name, text, hasImage: false, dryRun: false })!;
  const before = llmCalls.length;
  const result = await handleMessage({ jobId, groupJid, groupName: 'Trip chat', sender, text, images: [], recentChat: [], participants: [owner, dev, kiran].map((c) => store.getContact(c.id)!), ...extra });
  assert.equal(script.length, 0, 'the test scripted more model replies than were used');
  return { ...result, jobId, llm: llmCalls.slice(before) };
}
const toolResults = (r: { trace: unknown[] }) => (r.trace as { step: string; name: string; result: any }[]).filter((t) => t.step === 'tool');
const dinner = (cost: number, extra: object = {}) => ({
  description: 'Dinner', cost, currency: 'INR', payers: [{ user_id: 2 }],
  split: { type: 'equal', participants: [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }, { user_id: 4 }] },
  assumptions: ['split among all 4'], needs_confirmation: false, ...extra,
});

test('help is answered without the model', async () => {
  const r = await send(dev.id, 'help');
  assert.equal(r.reply, HELP_TEXT);
  assert.equal(r.llm.length, 0);
});

test('a clear expense goes straight to Splitwise with exact shares', async () => {
  script.push(toolCall('create_expense', dinner(2500)));
  const r = await send(dev.id, 'dinner 2500');
  assert.equal(r.llm.length, 1, 'no follow-up model call after a successful recording');
  assert.equal(r.expenseIds.length, 1);
  assert.match(r.reply, /✅ Added to Splitwise/);
  const sent = sw.created.at(-1)!;
  assert.equal(sent.description, '[bot] Dinner');
  const stored = sw.expenses.get(r.expenseIds[0]).users as { user_id: number; paid_share: string; owed_share: string }[];
  assert.deepEqual(stored.map((u) => u.owed_share), ['625.00', '625.00', '625.00', '625.00']);
  assert.deepEqual(stored.filter((u) => Number(u.paid_share) > 0).map((u) => [u.user_id, u.paid_share]), [[2, '2500.00']]);
  assert.match(sent.details, /requested by Devu/);
  assert.equal(store.getExpense(r.expenseIds[0])?.wa_group_jid, G);
});

test('the same expense again becomes a draft that names the first one', async () => {
  const first = sw.created.length;
  script.push(toolCall('create_expense', dinner(2500)));
  const r = await send(dev.id, 'dinner 2500 again');
  assert.equal(sw.created.length, first, 'nothing new was pushed');
  assert.equal(r.draftIds.length, 1);
  assert.match(r.reply, /📝 Draft/);
  assert.match(r.reply, /Check: looks like #\d+ "Dinner" which is already added/);
  // A yes still adds it: the check asks, it doesn't forbid.
  const confirmed = await confirmDrafts(G, r.draftIds, r.jobId);
  assert.equal(confirmed.expenseIds.length, 1);
  assert.equal(sw.created.length, first + 1);
});

test('an expense dated far in the future is drafted even when the model is sure', async () => {
  script.push(toolCall('create_expense', dinner(1111, { date: '2031-01-01' })));
  const r = await send(dev.id, 'dinner 1111 on 1 jan 2031');
  assert.equal(r.expenseIds.length, 0);
  assert.match(r.reply, /Check: the date 2031-01-01 is in the future/);
});

test('garbage tool arguments are rejected with a message the model can act on', async () => {
  script.push(toolCall('create_expense', dinner('lots' as unknown as number)), say('How much was it?'));
  const r = await send(dev.id, 'dinner, lots of money');
  assert.match(toolResults(r)[0].result.error, /Invalid expense: cost/);
  assert.equal(r.expenseIds.length + r.draftIds.length, 0);
});

test('the model cannot delete or change an expense outside this chat\'s Splitwise group', async () => {
  script.push(toolCall('delete_expense', { expense_id: 555 }), say('I can\'t find that one here.'));
  const del = await send(dev.id, 'delete expense 555');
  assert.match(toolResults(del)[0].result.error, /does not belong to this group/);
  assert.deepEqual(sw.deleted, []);

  script.push(toolCall('update_expense', { expense_id: 555, spec: dinner(1) }), say('I can\'t change that one.'));
  const upd = await send(dev.id, 'make expense 555 cost 1');
  assert.match(toolResults(upd)[0].result.error, /does not belong to this group/);
  assert.deepEqual(sw.updated, []);
});

test('an expense edited in the Splitwise app is not overwritten from the bot\'s stale copy', async () => {
  script.push(toolCall('create_expense', dinner(800, { description: 'Lunch' })));
  const added = await send(dev.id, 'lunch 800');
  const id = added.expenseIds[0];
  // Someone fixes it by hand in the app: Priya wasn't there.
  sw.expenses.get(id).users = [{ user_id: 1, paid_share: '0.0', owed_share: '266.67' }, { user_id: 2, paid_share: '800.0', owed_share: '266.67' }, { user_id: 3, paid_share: '0.0', owed_share: '266.66' }];
  const fixed = { ...dinner(900, { description: 'Lunch' }), split: { type: 'equal', participants: [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }] } };
  script.push(toolCall('update_expense', { expense_id: id, spec: dinner(900, { description: 'Lunch' }) }), toolCall('update_expense', { expense_id: id, spec: fixed }));
  const r = await send(dev.id, 'make it 900', { quoted: { text: added.reply, fromBot: true, expenseIds: [id], draftIds: [] } });
  const [first, second] = toolResults(r);
  assert.match(first.result.error, /changed in the Splitwise app/);
  assert.match(first.result.error, /owes 266.67/);
  assert.equal(second.result.ok, true);
  assert.deepEqual(sw.updated, [id]);
  assert.match(r.reply, /✏️ Updated in Splitwise/);
});

test('"undo" as a reply to a receipt deletes it without the model', async () => {
  script.push(toolCall('create_expense', dinner(300, { description: 'Taxi' })));
  const added = await send(dev.id, 'taxi 300');
  const r = await send(kiran.id, 'undo', { quoted: { text: added.reply, fromBot: true, expenseIds: added.expenseIds, draftIds: [] } });
  assert.equal(r.llm.length, 0);
  assert.match(r.reply, /🗑️ Deleted from Splitwise \*Taxi\*/);
  assert.ok(sw.deleted.includes(added.expenseIds[0]));
  assert.equal(store.getExpense(added.expenseIds[0])?.deleted, 1);
});

test('paying someone back is recorded as a Splitwise payment', async () => {
  script.push(toolCall('record_payment', { from_user_id: 2, to_user_id: 1, amount: 600, assumptions: [], needs_confirmation: false }));
  const r = await send(dev.id, 'I paid Arjun 600');
  const sent = sw.created.at(-1)!;
  assert.equal(sent.payment, 'true');
  assert.equal(sent.description, 'Payment');
  const users = sw.expenses.get(r.expenseIds[0]).users as { user_id: number; paid_share: string; owed_share: string }[];
  assert.deepEqual(users.find((u) => u.user_id === 2), { user_id: 2, paid_share: '600.00', owed_share: '0.00' });
  assert.deepEqual(users.find((u) => u.user_id === 1), { user_id: 1, paid_share: '0.00', owed_share: '600.00' });
  assert.match(r.reply, /💸 \*Payment\*[\s\S]*\*Dev\* paid \*Arjun\*/);
});

test('balances are formatted by code', async () => {
  const r = await send(kiran.id, 'who owes what?');
  assert.equal(r.llm.length, 0);
  assert.match(r.reply, /Dev → Arjun · \*₹600/);
});

test('a nickname the group confirmed is remembered and shown to the model next time', async () => {
  script.push(toolCall('create_expense', { ...dinner(450, { description: 'Snacks' }), payers: [{ user_id: 4 }], needs_confirmation: true, question: 'Is Pri = Priya?', nicknames: [{ nickname: 'Pri', user_id: 4 }] }));
  const r = await send(dev.id, 'snacks 450 Pri paid');
  assert.equal(r.draftIds.length, 1);
  assert.deepEqual(store.listAliases(G), [], 'not remembered until someone says yes');
  await send(kiran.id, 'yes', { quoted: { text: r.reply, fromBot: true, expenseIds: [], draftIds: r.draftIds } });
  assert.deepEqual(store.listAliases(G).map((a) => ({ ...a })), [{ alias: 'pri', splitwise_user_id: 4 }]);

  script.push(say('ok'));
  const next = await send(dev.id, 'what did Pri pay for, 100?');
  assert.match(String(next.llm[0].messages[0].content), /Known nicknames \(confirmed by the group\): "pri" = user_id 4 \(Priya\)/);
});

test('standing instructions are saved and reach the model', async () => {
  script.push(toolCall('remember_note', { note: "Dev doesn't drink" }));
  const r = await send(kiran.id, "remember Dev doesn't drink");
  assert.match(r.reply, /📌 Noted for this group/);
  script.push(say('ok'));
  const next = await send(kiran.id, 'beers 900?');
  assert.match(String(next.llm[0].messages[0].content), /Standing instructions from the group:\n- Dev doesn't drink \(Kiran, /);
});

test('link_member only fills gaps: no relinking, no claiming the owner, no guessing for others', async () => {
  // Kiran (unlinked) may claim the unclaimed member Kiran.
  script.push(toolCall('link_member', { wa_contact_id: kiran.id, splitwise_user_id: 3 }), say('ok?'));
  await send(kiran.id, 'this is Kiran, 5?');
  assert.equal(store.getContact(kiran.id)?.splitwise_user_id, 3);

  const attempt = async (who: number, args: object) => {
    script.push(toolCall('link_member', args), say('ok?'));
    return toolResults(await send(who, 'link me, 5?'))[0].result.error as string;
  };
  // Dev is linked already; saying "I am Priya" must not move him.
  assert.match(await attempt(dev.id, { wa_contact_id: dev.id, splitwise_user_id: 4 }), /already linked to Dev/);
  // Kiran's member is taken; a stranger can't take it over.
  assert.match(await attempt(stranger.id, { wa_contact_id: stranger.id, splitwise_user_id: 3 }), /already linked to another WhatsApp person/);
  // Nobody becomes the bot owner through the model, even with the owner's display name. (The owner's own contact is linked, so free the member first.)
  store.linkContact(owner.id, null, null);
  assert.match(await attempt(stranger.id, { wa_contact_id: stranger.id, splitwise_user_id: 1 }), /only the owner can link it/);
  store.linkContact(owner.id, 1, 'Arjun');
  assert.equal(store.getContact(stranger.id)?.splitwise_user_id, null);
});

test('only the owner can point a chat at a Splitwise group', async () => {
  // Linked chat, ordinary member: the tool isn't even offered, and calling it anyway is refused.
  script.push(toolCall('link_group', { splitwise_group_id: 2 }), say('Only the owner can do that?'));
  const r = await send(dev.id, 'use Home, group 2');
  assert.ok(!r.llm[0].tools!.some((t) => t.function.name === 'link_group'));
  assert.match(toolResults(r)[0].result.error, /not available/);
  assert.equal(store.getGroupLink(G)?.splitwise_group_id, 1);

  // Unlinked chat, ordinary member: no model call, and the owner's groups are never listed.
  const NEW = 'new@g.us';
  store.upsertGroup(NEW, 'Strangers');
  const callsBefore = sw.calls.length;
  const locked = await send(dev.id, 'use Home 2', { groupJid: NEW });
  assert.equal(locked.llm.length, 0);
  assert.match(locked.reply, /^🔒/);
  assert.ok(!sw.calls.slice(callsBefore).includes('get_groups'));

  // Unlinked chat, owner: works.
  script.push(toolCall('link_group', { splitwise_group_id: 2 }));
  const linked = await send(owner.id, 'use Home 2', { groupJid: NEW });
  assert.match(linked.reply, /now logs to Splitwise group \*Home\*/);
  assert.equal(store.getGroupLink(NEW)?.splitwise_group_id, 2);
  assert.equal(store.getGroupLink(NEW)?.approved, 1);
});

test('per-chat currency and confirm mode override the global defaults', async () => {
  store.setGroupSettings(G, { currency: 'THB', confirm_mode: 'always' });
  const { currency, ...noCurrency } = dinner(77, { description: 'Mango rice' }) as ReturnType<typeof dinner> & { currency: string };
  script.push(toolCall('create_expense', noCurrency));
  const r = await send(dev.id, 'mango rice 77');
  assert.equal(r.draftIds.length, 1, 'always-confirm chat: draft');
  assert.match(r.reply, /THB\s?77/);
  store.setGroupSettings(G, { currency: null, confirm_mode: null });
  assert.ok(today());
});
