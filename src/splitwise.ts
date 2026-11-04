import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { logger } from './log.ts';
import { computeShares, currencyDecimals, type ExpenseSpec } from './split.ts';

const log = logger('splitwise');
const BASE = 'https://secure.splitwise.com';
const API = `${BASE}/api/v3.0`;

export interface SwUser {
  id: number;
  first_name: string;
  last_name: string | null;
  email?: string;
  default_currency?: string;
}

export interface SwGroupMember extends SwUser {
  balance: { currency_code: string; amount: string }[];
}

export interface SwGroup {
  id: number;
  name: string;
  members: SwGroupMember[];
  simplified_debts?: { from: number; to: number; amount: string; currency_code: string }[];
  original_debts?: { from: number; to: number; amount: string; currency_code: string }[];
}

export interface SwExpense {
  id: number;
  description: string;
  cost: string;
  currency_code: string;
  date: string;
  deleted_at: string | null;
  created_by?: { id: number; first_name: string };
  users: { user_id: number; user?: { first_name: string }; paid_share: string; owed_share: string }[];
}

export function swName(u: { first_name: string; last_name?: string | null }) {
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

// ── Token ───────────────────────────────────────────────────────

let accessToken: string | null = null;

function loadToken() {
  try {
    accessToken = JSON.parse(fs.readFileSync(config.splitwise.tokenFile, 'utf8')).access_token ?? null;
  } catch {
    accessToken = null;
  }
}
loadToken();

function saveToken(token: string | null) {
  accessToken = token;
  fs.mkdirSync(path.dirname(config.splitwise.tokenFile), { recursive: true });
  if (token) fs.writeFileSync(config.splitwise.tokenFile, JSON.stringify({ access_token: token }), { mode: 0o600 });
  else fs.rmSync(config.splitwise.tokenFile, { force: true });
  me = null;
}

export function isConnected() {
  return !!accessToken;
}

export function authorizeUrl(state: string) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.splitwise.consumerKey,
    redirect_uri: config.splitwise.redirectUri,
    state,
  });
  return `${BASE}/oauth/authorize?${q}`;
}

export async function exchangeCode(code: string) {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.splitwise.consumerKey,
      client_secret: config.splitwise.consumerSecret,
      redirect_uri: config.splitwise.redirectUri,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !data.access_token) throw new Error(`Splitwise token exchange failed: ${data.error ?? res.status}`);
  saveToken(data.access_token);
  log.info('Connected to Splitwise');
}

export function disconnect() {
  saveToken(null);
}

// ── HTTP ────────────────────────────────────────────────────────

async function call<T>(method: 'GET' | 'POST', endpoint: string, body?: Record<string, unknown> | FormData): Promise<T> {
  if (!accessToken) throw new Error('Splitwise is not connected — open the dashboard and connect it');
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${accessToken}` } };
  if (body instanceof FormData) init.body = body;
  else if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const started = Date.now();
  const res = await fetch(`${API}/${endpoint}`, init);
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  log.debug(`${method} ${endpoint} → ${res.status} (${Date.now() - started}ms)`);
  if (res.status === 401) throw new Error('Splitwise token rejected (401) — reconnect Splitwise in the dashboard');
  if (!res.ok) throw new Error(`Splitwise ${endpoint} failed (${res.status}): ${JSON.stringify(data.errors ?? data).slice(0, 300)}`);
  const errors = data.errors && (Array.isArray(data.errors) ? data.errors : Object.values(data.errors).flat());
  if (errors?.length) throw new Error(`Splitwise rejected the request: ${errors.join('; ')}`);
  return data as T;
}

// ── Reads (lightly cached; the agent asks for these on every message) ──

let me: SwUser | null = null;
const groupCache = new Map<number, { at: number; group: SwGroup }>();
let categoryCache: { id: number; name: string }[] | null = null;
const GROUP_TTL = 60_000;

export async function currentUser(): Promise<SwUser> {
  me ??= (await call<{ user: SwUser }>('GET', 'get_current_user')).user;
  return me;
}

export async function listGroups(): Promise<SwGroup[]> {
  const { groups } = await call<{ groups: SwGroup[] }>('GET', 'get_groups');
  return groups.filter((g) => g.id !== 0); // id 0 is the pseudo-group of non-group expenses
}

export async function getGroup(id: number, fresh = false): Promise<SwGroup> {
  const hit = groupCache.get(id);
  if (!fresh && hit && Date.now() - hit.at < GROUP_TTL) return hit.group;
  const { group } = await call<{ group: SwGroup }>('GET', `get_group/${id}`);
  groupCache.set(id, { at: Date.now(), group });
  return group;
}

/** Flattened subcategories, e.g. "Food and drink › Dining out". */
export async function categories(): Promise<{ id: number; name: string }[]> {
  if (categoryCache) return categoryCache;
  const { categories } = await call<{ categories: { id: number; name: string; subcategories?: { id: number; name: string }[] }[] }>(
    'GET',
    'get_categories',
  );
  categoryCache = categories.flatMap((c) => (c.subcategories ?? []).map((s) => ({ id: s.id, name: `${c.name} › ${s.name}` })));
  return categoryCache;
}

function matchCategory(name: string | undefined, cats: { id: number; name: string }[]): number | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  return (cats.find((c) => c.name.toLowerCase() === n) ?? cats.find((c) => c.name.toLowerCase().endsWith(`› ${n}`)) ??
    cats.find((c) => c.name.toLowerCase().includes(n)))?.id;
}

export async function listExpenses(groupId: number, limit = 15): Promise<SwExpense[]> {
  const { expenses } = await call<{ expenses: SwExpense[] }>('GET', `get_expenses?group_id=${groupId}&limit=${limit}`);
  return expenses.filter((e) => !e.deleted_at);
}

// ── Writes ──────────────────────────────────────────────────────

/** "[bot] Dinner" — tagged once, even if the model echoes a title that already carries the tag. */
export function taggedDescription(description: string) {
  const tag = config.bot.expenseTag;
  const plain = tag && description.startsWith(tag) ? description.slice(tag.length).trim() : description.trim();
  return (tag ? `${tag} ${plain}` : plain).slice(0, 200);
}

/** Who asked for it, plus any bill line items. Splitwise shows this as the expense's notes. */
function expenseDetails(spec: ExpenseSpec, addedBy?: string) {
  const credit = `Added by Splitbot via WhatsApp${addedBy ? ` · requested by ${addedBy}` : ''}`;
  return spec.notes ? `${spec.notes}\n\n— ${credit}` : credit;
}

async function expensePayload(spec: ExpenseSpec, groupId: number, addedBy?: string) {
  const shares = computeShares(spec);
  const fields: Record<string, string> = {
    cost: spec.cost.toFixed(currencyDecimals(spec.currency)),
    description: taggedDescription(spec.description),
    currency_code: spec.currency,
    group_id: String(groupId),
  };
  if (spec.date) fields.date = new Date(spec.date).toISOString();
  fields.details = expenseDetails(spec, addedBy);
  const categoryId = matchCategory(spec.category, await categories().catch(() => []));
  if (categoryId) fields.category_id = String(categoryId);
  shares.forEach((s, i) => {
    fields[`users__${i}__user_id`] = String(s.user_id);
    fields[`users__${i}__paid_share`] = s.paid_share;
    fields[`users__${i}__owed_share`] = s.owed_share;
  });
  return { fields, shares };
}

function withReceipt(fields: Record<string, string>, receipt?: { data: Buffer; mime: string }) {
  if (!receipt) return fields;
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const ext = receipt.mime.split('/')[1] ?? 'jpg';
  form.append('receipt', new Blob([new Uint8Array(receipt.data)], { type: receipt.mime }), `receipt.${ext}`);
  return form;
}

export async function createExpense(
  spec: ExpenseSpec,
  groupId: number,
  o: { receipt?: { data: Buffer; mime: string }; addedBy?: string } = {},
) {
  const { receipt } = o;
  const { fields, shares } = await expensePayload(spec, groupId, o.addedBy);
  let res: { expenses: SwExpense[] };
  try {
    res = await call('POST', 'create_expense', withReceipt(fields, receipt));
  } catch (err) {
    if (!receipt) throw err;
    log.warn('create_expense with receipt failed, retrying without it', String(err));
    res = await call('POST', 'create_expense', fields);
  }
  groupCache.delete(groupId);
  return { expense: res.expenses[0], shares };
}

export async function updateExpense(id: number, spec: ExpenseSpec, groupId: number, addedBy?: string) {
  const { fields, shares } = await expensePayload(spec, groupId, addedBy);
  const res = await call<{ expenses: SwExpense[] }>('POST', `update_expense/${id}`, fields);
  groupCache.delete(groupId);
  return { expense: res.expenses[0], shares };
}

export async function deleteExpense(id: number, groupId?: number) {
  await call<{ success: boolean }>('POST', `delete_expense/${id}`);
  if (groupId) groupCache.delete(groupId);
}
