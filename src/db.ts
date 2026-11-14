import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS group_links (
  wa_group_jid TEXT PRIMARY KEY,
  wa_group_name TEXT,
  splitwise_group_id INTEGER,
  splitwise_group_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- A WhatsApp person. In LID-addressed groups we may only know the LID; the phone number shows up later.
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lid TEXT UNIQUE,
  pn TEXT UNIQUE,
  push_name TEXT,
  splitwise_user_id INTEGER,
  splitwise_name TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id TEXT UNIQUE,
  wa_group_jid TEXT,
  group_name TEXT,
  sender_contact_id INTEGER,
  sender_name TEXT,
  text TEXT,
  has_image INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  reply TEXT,
  trace TEXT,
  error TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS expenses (
  splitwise_expense_id INTEGER PRIMARY KEY,
  job_id INTEGER,
  wa_group_jid TEXT,
  splitwise_group_id INTEGER,
  description TEXT,
  cost TEXT,
  currency TEXT,
  spec TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Expenses the bot proposed but is waiting on a "yes" / 👍 for.
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_group_jid TEXT NOT NULL,
  job_id INTEGER,
  bot_msg_id TEXT,
  spec TEXT NOT NULL,
  assumptions TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expense_id INTEGER,
  dry_run INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- One row per LLM call, for the daily spend cap and the dashboard.
CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS llm_usage_ts ON llm_usage (ts);

-- Bot replies, so a user replying to one ("undo", "make it 500") can be tied to the expenses it created.
CREATE TABLE IF NOT EXISTS bot_messages (
  wa_msg_id TEXT PRIMARY KEY,
  wa_group_jid TEXT,
  job_id INTEGER,
  expense_ids TEXT,
  created_at INTEGER NOT NULL
);

-- Polls the bot sent, with the secret needed to decrypt votes on them.
CREATE TABLE IF NOT EXISTS polls (
  wa_msg_id TEXT PRIMARY KEY,
  wa_group_jid TEXT NOT NULL,
  job_id INTEGER,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  draft_ids TEXT NOT NULL,
  secret TEXT NOT NULL,
  answered_at INTEGER,
  created_at INTEGER NOT NULL
);
`);

// Columns added after the first release. Returns true when the column was just created.
function addColumn(table: string, column: string, ddl: string): boolean {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (cols.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}
addColumn('contacts', 'muted', 'INTEGER NOT NULL DEFAULT 0');
// New chats are ignored until the owner approves them; chats that existed before this column are kept working.
if (addColumn('group_links', 'approved', 'INTEGER NOT NULL DEFAULT 0')) db.exec('UPDATE group_links SET approved = 1');
addColumn('group_links', 'currency', 'TEXT');
addColumn('group_links', 'confirm_mode', 'TEXT');
addColumn('group_links', 'notes', 'TEXT');
addColumn('group_links', 'digest', 'INTEGER NOT NULL DEFAULT 0');
addColumn('group_links', 'last_digest', 'TEXT');
addColumn('jobs', 'flagged', 'INTEGER NOT NULL DEFAULT 0');
addColumn('jobs', 'flag_note', 'TEXT');
addColumn('expenses', 'image_hash', 'TEXT');
addColumn('drafts', 'nudged_at', 'INTEGER');
addColumn('drafts', 'image_hash', 'TEXT');
addColumn('drafts', 'aliases', 'TEXT');
addColumn('drafts', 'checks', 'TEXT');

db.exec(`
-- Nicknames the group confirmed once ("Devu" = Dev Nair), so the bot never has to ask again.
CREATE TABLE IF NOT EXISTS aliases (
  wa_group_jid TEXT NOT NULL,
  alias TEXT NOT NULL,
  splitwise_user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (wa_group_jid, alias)
);
-- Dashboard overrides of .env settings (JSON values) and small bits of state.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS jobs_sender ON jobs (sender_contact_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_group ON jobs (wa_group_jid, created_at);
CREATE INDEX IF NOT EXISTS expenses_group ON expenses (wa_group_jid, created_at);
CREATE INDEX IF NOT EXISTS expenses_job ON expenses (job_id);
CREATE INDEX IF NOT EXISTS drafts_group ON drafts (wa_group_jid, status);
CREATE INDEX IF NOT EXISTS drafts_msg ON drafts (bot_msg_id);
CREATE INDEX IF NOT EXISTS drafts_job ON drafts (job_id);
`);

// ── Group links ─────────────────────────────────────────────────

export interface GroupLink {
  wa_group_jid: string;
  wa_group_name: string | null;
  splitwise_group_id: number | null;
  splitwise_group_name: string | null;
  enabled: number;
  /** 0 = a chat the bot was added to that the owner has not approved yet; the bot ignores it. */
  approved: number;
  /** Per-chat overrides; null = the global default. */
  currency: string | null;
  confirm_mode: 'auto' | 'always' | 'never' | null;
  /** Standing instructions the group gave the bot ("Dev doesn't drink"). */
  notes: string | null;
  digest: number;
  last_digest: string | null;
  created_at: number;
}

export function getGroupLink(jid: string): GroupLink | undefined {
  return db.prepare('SELECT * FROM group_links WHERE wa_group_jid = ?').get(jid) as GroupLink | undefined;
}

export function listGroupLinks(): GroupLink[] {
  return db.prepare('SELECT * FROM group_links ORDER BY created_at DESC').all() as unknown as GroupLink[];
}

export function upsertGroup(jid: string, name: string | null) {
  db.prepare(
    `INSERT INTO group_links (wa_group_jid, wa_group_name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(wa_group_jid) DO UPDATE SET wa_group_name = COALESCE(excluded.wa_group_name, wa_group_name)`,
  ).run(jid, name, Date.now());
}

/** Linking is an owner action (dashboard, or the owner in the chat), so it also approves the chat. */
export function linkGroup(jid: string, splitwiseGroupId: number | null, splitwiseGroupName: string | null) {
  upsertGroup(jid, null);
  db.prepare('UPDATE group_links SET splitwise_group_id = ?, splitwise_group_name = ?, approved = 1 WHERE wa_group_jid = ?').run(
    splitwiseGroupId,
    splitwiseGroupName,
    jid,
  );
}

export function approveGroup(jid: string, approved = true) {
  upsertGroup(jid, null);
  db.prepare('UPDATE group_links SET approved = ? WHERE wa_group_jid = ?').run(approved ? 1 : 0, jid);
}

export function setGroupSettings(
  jid: string,
  p: { currency?: string | null; confirm_mode?: string | null; notes?: string | null; digest?: boolean; last_digest?: string },
) {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  if (sets.length) db.prepare(`UPDATE group_links SET ${sets.join(', ')} WHERE wa_group_jid = ?`).run(...vals, jid);
}

// ── Nicknames ───────────────────────────────────────────────────

export interface Alias {
  alias: string;
  splitwise_user_id: number;
}

export function listAliases(jid: string): Alias[] {
  return db.prepare('SELECT alias, splitwise_user_id FROM aliases WHERE wa_group_jid = ? ORDER BY alias').all(jid) as unknown as Alias[];
}

export function saveAlias(jid: string, alias: string, splitwiseUserId: number) {
  const a = alias.trim().toLowerCase().slice(0, 40);
  if (a.length < 2) return;
  db.prepare(
    `INSERT INTO aliases (wa_group_jid, alias, splitwise_user_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(wa_group_jid, alias) DO UPDATE SET splitwise_user_id = excluded.splitwise_user_id`,
  ).run(jid, a, splitwiseUserId, Date.now());
}

export function deleteAlias(jid: string, alias: string) {
  db.prepare('DELETE FROM aliases WHERE wa_group_jid = ? AND alias = ?').run(jid, alias.trim().toLowerCase());
}

// ── Settings (key → JSON) ───────────────────────────────────────

export function getSetting<T = unknown>(key: string): T | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}

export function setSetting(key: string, value: unknown) {
  if (value === null || value === undefined) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function allSettings(prefix: string): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all(`${prefix}%`) as { key: string; value: string }[];
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.key.slice(prefix.length)] = JSON.parse(r.value);
    } catch {}
  }
  return out;
}

export function setGroupEnabled(jid: string, enabled: boolean) {
  db.prepare('UPDATE group_links SET enabled = ? WHERE wa_group_jid = ?').run(enabled ? 1 : 0, jid);
}

// ── Contacts ────────────────────────────────────────────────────

export interface Contact {
  id: number;
  lid: string | null;
  pn: string | null;
  push_name: string | null;
  splitwise_user_id: number | null;
  splitwise_name: string | null;
  muted: number;
  updated_at: number;
}

/**
 * Find-or-create the contact matching any of the given identifiers, filling in whatever was missing.
 * `lid` / `pn` are bare user parts (digits), not full JIDs.
 */
export function resolveContact(ids: { lid?: string | null; pn?: string | null; pushName?: string | null }): Contact {
  const { lid = null, pn = null, pushName = null } = ids;
  const byLid = lid ? (db.prepare('SELECT * FROM contacts WHERE lid = ?').get(lid) as Contact | undefined) : undefined;
  const byPn = pn ? (db.prepare('SELECT * FROM contacts WHERE pn = ?').get(pn) as Contact | undefined) : undefined;

  let row = byLid ?? byPn;
  if (byLid && byPn && byLid.id !== byPn.id) {
    // Same person seen once by LID and once by phone: fold the phone row into the LID row.
    db.prepare('DELETE FROM contacts WHERE id = ?').run(byPn.id);
    db.prepare(
      'UPDATE contacts SET splitwise_user_id = COALESCE(splitwise_user_id, ?), splitwise_name = COALESCE(splitwise_name, ?) WHERE id = ?',
    ).run(byPn.splitwise_user_id, byPn.splitwise_name, byLid.id);
    row = byLid;
  }

  if (!row) {
    const res = db
      .prepare('INSERT INTO contacts (lid, pn, push_name, updated_at) VALUES (?, ?, ?, ?)')
      .run(lid, pn, pushName, Date.now());
    return getContact(Number(res.lastInsertRowid))!;
  }

  db.prepare(
    'UPDATE contacts SET lid = COALESCE(?, lid), pn = COALESCE(?, pn), push_name = COALESCE(?, push_name), updated_at = ? WHERE id = ?',
  ).run(lid, pn, pushName, Date.now(), row.id);
  return getContact(row.id)!;
}

export function getContact(id: number): Contact | undefined {
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Contact | undefined;
}

export function findContactByUser(user: string): Contact | undefined {
  return db.prepare('SELECT * FROM contacts WHERE lid = ? OR pn = ?').get(user, user) as Contact | undefined;
}

export function contactsLinkedTo(splitwiseUserId: number): Contact[] {
  return db.prepare('SELECT * FROM contacts WHERE splitwise_user_id = ?').all(splitwiseUserId) as unknown as Contact[];
}

export function listContacts(): Contact[] {
  return db.prepare('SELECT * FROM contacts ORDER BY updated_at DESC').all() as unknown as Contact[];
}

export function setContactMuted(contactId: number, muted: boolean) {
  db.prepare('UPDATE contacts SET muted = ? WHERE id = ?').run(muted ? 1 : 0, contactId);
}

export function linkContact(contactId: number, splitwiseUserId: number | null, splitwiseName: string | null) {
  db.prepare('UPDATE contacts SET splitwise_user_id = ?, splitwise_name = ?, updated_at = ? WHERE id = ?').run(
    splitwiseUserId,
    splitwiseName,
    Date.now(),
    contactId,
  );
}

// ── Jobs ────────────────────────────────────────────────────────

export interface Job {
  id: number;
  msg_id: string | null;
  wa_group_jid: string | null;
  group_name: string | null;
  sender_contact_id: number | null;
  sender_name: string | null;
  text: string | null;
  has_image: number;
  /** rejected = stopped by the guard before any LLM call */
  status: 'running' | 'done' | 'error' | 'rejected';
  reply: string | null;
  trace: string | null;
  error: string | null;
  dry_run: number;
  /** Marked wrong on the dashboard: an eval case to learn from. */
  flagged: number;
  flag_note: string | null;
  created_at: number;
  finished_at: number | null;
}

/** Returns null when this message id was already processed (WhatsApp redelivers on reconnect). */
export function createJob(j: {
  msgId: string | null;
  groupJid: string | null;
  groupName: string | null;
  senderContactId: number | null;
  senderName: string | null;
  text: string;
  hasImage: boolean;
  dryRun: boolean;
}): number | null {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO jobs (msg_id, wa_group_jid, group_name, sender_contact_id, sender_name, text, has_image, status, dry_run, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    )
    .run(j.msgId, j.groupJid, j.groupName, j.senderContactId, j.senderName, j.text, j.hasImage ? 1 : 0, j.dryRun ? 1 : 0, Date.now());
  return res.changes ? Number(res.lastInsertRowid) : null;
}

export function finishJob(id: number, r: { status: 'done' | 'error'; reply?: string; trace?: unknown; error?: string }) {
  db.prepare('UPDATE jobs SET status = ?, reply = ?, trace = ?, error = ?, finished_at = ? WHERE id = ?').run(
    r.status,
    r.reply ?? null,
    r.trace === undefined ? null : JSON.stringify(r.trace),
    r.error ?? null,
    Date.now(),
    id,
  );
}

export function getJob(id: number): Job | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
}

export function listJobs(f: { status?: string; group?: string; q?: string; flagged?: boolean; before?: number; limit?: number } = {}): Job[] {
  const where: string[] = [];
  const vals: (string | number)[] = [];
  if (f.status) (where.push('status = ?'), vals.push(f.status));
  if (f.group) (where.push('wa_group_jid = ?'), vals.push(f.group));
  if (f.flagged) where.push('flagged = 1');
  if (f.before) (where.push('id < ?'), vals.push(f.before));
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    where.push("(text LIKE ? ESCAPE '\\' OR sender_name LIKE ? ESCAPE '\\' OR reply LIKE ? ESCAPE '\\')");
    vals.push(like, like, like);
  }
  const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...vals, Math.min(f.limit ?? 50, 500)) as unknown as Job[];
}

export function jobByMsgId(msgId: string): Job | undefined {
  return db.prepare('SELECT * FROM jobs WHERE msg_id = ?').get(msgId) as Job | undefined;
}

export function flagJob(id: number, wrong: boolean, note: string | null) {
  db.prepare('UPDATE jobs SET flagged = ?, flag_note = ? WHERE id = ?').run(wrong ? 1 : 0, wrong ? note : null, id);
}

/** Jobs that were still running when the process died. They are closed as errors and returned so the group can be told. */
export function interruptRunningJobs(): Job[] {
  const rows = db.prepare("SELECT * FROM jobs WHERE status = 'running'").all() as unknown as Job[];
  db.prepare("UPDATE jobs SET status = 'error', error = 'Interrupted by a restart', finished_at = ? WHERE status = 'running'").run(Date.now());
  return rows;
}

// ── Expenses created by the bot ─────────────────────────────────

export interface ExpenseRow {
  splitwise_expense_id: number;
  job_id: number | null;
  wa_group_jid: string | null;
  splitwise_group_id: number | null;
  description: string;
  cost: string;
  currency: string;
  spec: string;
  /** sha256 of the bill photo it was read from, to spot the same bill sent twice. */
  image_hash: string | null;
  deleted: number;
  created_at: number;
}

export function saveExpense(e: Omit<ExpenseRow, 'deleted' | 'created_at' | 'image_hash'> & { image_hash?: string | null }) {
  db.prepare(
    `INSERT INTO expenses (splitwise_expense_id, job_id, wa_group_jid, splitwise_group_id, description, cost, currency, spec, image_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(splitwise_expense_id) DO UPDATE SET description = excluded.description, cost = excluded.cost,
       currency = excluded.currency, spec = excluded.spec, deleted = 0`,
  ).run(e.splitwise_expense_id, e.job_id, e.wa_group_jid, e.splitwise_group_id, e.description, e.cost, e.currency, e.spec, e.image_hash ?? null, Date.now());
}

/** Live expenses recorded while handling one message. */
export function expensesByJob(jobId: number): ExpenseRow[] {
  return db.prepare('SELECT * FROM expenses WHERE job_id = ? AND deleted = 0').all(jobId) as unknown as ExpenseRow[];
}

export function listExpenses(f: { group?: string; limit?: number; since?: number; includeDeleted?: boolean } = {}): ExpenseRow[] {
  const where: string[] = [];
  const vals: (string | number)[] = [];
  if (f.group) (where.push('wa_group_jid = ?'), vals.push(f.group));
  if (f.since) (where.push('created_at >= ?'), vals.push(f.since));
  if (!f.includeDeleted) where.push('deleted = 0');
  const sql = `SELECT * FROM expenses ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  return db.prepare(sql).all(...vals, Math.min(f.limit ?? 100, 2000)) as unknown as ExpenseRow[];
}

export function markExpenseDeleted(id: number) {
  db.prepare('UPDATE expenses SET deleted = 1 WHERE splitwise_expense_id = ?').run(id);
}

export function recentExpenses(groupJid: string | null, limit = 10): ExpenseRow[] {
  if (groupJid) {
    return db
      .prepare('SELECT * FROM expenses WHERE wa_group_jid = ? AND deleted = 0 ORDER BY created_at DESC LIMIT ?')
      .all(groupJid, limit) as unknown as ExpenseRow[];
  }
  return db.prepare('SELECT * FROM expenses ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as ExpenseRow[];
}

export function getExpense(id: number): ExpenseRow | undefined {
  return db.prepare('SELECT * FROM expenses WHERE splitwise_expense_id = ?').get(id) as ExpenseRow | undefined;
}

// ── Bot messages ────────────────────────────────────────────────

export function saveBotMessage(waMsgId: string, groupJid: string, jobId: number, expenseIds: number[]) {
  db.prepare('INSERT OR REPLACE INTO bot_messages (wa_msg_id, wa_group_jid, job_id, expense_ids, created_at) VALUES (?, ?, ?, ?, ?)').run(
    waMsgId,
    groupJid,
    jobId,
    JSON.stringify(expenseIds),
    Date.now(),
  );
}

export function getBotMessage(waMsgId: string): { job_id: number; expense_ids: number[] } | undefined {
  const row = db.prepare('SELECT job_id, expense_ids FROM bot_messages WHERE wa_msg_id = ?').get(waMsgId) as
    | { job_id: number; expense_ids: string }
    | undefined;
  return row && { job_id: row.job_id, expense_ids: JSON.parse(row.expense_ids) };
}

// ── Polls ───────────────────────────────────────────────────────

export interface PollRow {
  wa_msg_id: string;
  wa_group_jid: string;
  job_id: number | null;
  question: string;
  options: string[];
  draft_ids: number[];
  secret: Buffer;
  answered_at: number | null;
}

export function savePoll(p: Omit<PollRow, 'answered_at'>) {
  db.prepare(
    'INSERT OR REPLACE INTO polls (wa_msg_id, wa_group_jid, job_id, question, options, draft_ids, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(p.wa_msg_id, p.wa_group_jid, p.job_id, p.question, JSON.stringify(p.options), JSON.stringify(p.draft_ids), p.secret.toString('base64'), Date.now());
}

export function getPoll(waMsgId: string): PollRow | undefined {
  const row = db.prepare('SELECT * FROM polls WHERE wa_msg_id = ?').get(waMsgId) as Record<string, any> | undefined;
  if (!row) return undefined;
  return {
    ...row,
    options: JSON.parse(row.options),
    draft_ids: JSON.parse(row.draft_ids),
    secret: Buffer.from(row.secret, 'base64'),
  } as PollRow;
}

/** First vote wins: returns false if someone already answered this poll. */
export function markPollAnswered(waMsgId: string): boolean {
  return db.prepare('UPDATE polls SET answered_at = ? WHERE wa_msg_id = ? AND answered_at IS NULL').run(Date.now(), waMsgId).changes > 0;
}

export function stats() {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    jobs: one('SELECT COUNT(*) AS n FROM jobs'),
    jobErrors: one("SELECT COUNT(*) AS n FROM jobs WHERE status = 'error'"),
    expenses: one('SELECT COUNT(*) AS n FROM expenses WHERE deleted = 0'),
    rejectedToday: one(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'rejected' AND created_at >= ${startOfDay()}`),
    spendToday: spendSince(startOfDay()),
    pendingDrafts: one(`SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending' AND dry_run = 0 AND created_at > ${Date.now() - DRAFT_TTL_MS}`),
    latency: latency(Date.now() - 7 * 86_400_000),
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** How long real (LLM-handled) messages took, in ms. */
export function latency(since: number) {
  const rows = db
    .prepare("SELECT finished_at - created_at AS ms FROM jobs WHERE status = 'done' AND dry_run = 0 AND finished_at IS NOT NULL AND created_at >= ? ORDER BY ms")
    .all(since) as { ms: number }[];
  const ms = rows.map((r) => r.ms);
  return { p50: percentile(ms, 0.5), p95: percentile(ms, 0.95), n: ms.length };
}

const dayKey = (ts: number) => new Intl.DateTimeFormat('en-CA', { timeZone: config.bot.timezone }).format(new Date(ts));

/** Per-day activity for the dashboard charts, oldest first, plus usage per model over the same period. */
export function metrics(days: number) {
  const since = startOfDay() - (days - 1) * 86_400_000;
  const byDay = new Map<string, { date: string; jobs: number; errors: number; rejected: number; expenses: number; spend: number; ms: number[] }>();
  for (let i = 0; i < days; i++) {
    const date = dayKey(since + i * 86_400_000 + 43_200_000);
    byDay.set(date, { date, jobs: 0, errors: 0, rejected: 0, expenses: 0, spend: 0, ms: [] });
  }
  const jobs = db.prepare('SELECT status, created_at, finished_at, dry_run FROM jobs WHERE created_at >= ?').all(since) as unknown as Job[];
  for (const j of jobs) {
    const d = byDay.get(dayKey(j.created_at));
    if (!d) continue;
    d.jobs++; // every message, including the ones counted again under errors / rejected
    if (j.status === 'rejected') d.rejected++;
    else if (j.status === 'error') d.errors++;
    if (j.status === 'done' && !j.dry_run && j.finished_at) d.ms.push(j.finished_at - j.created_at);
  }
  for (const e of db.prepare('SELECT created_at FROM expenses WHERE created_at >= ?').all(since) as { created_at: number }[]) {
    const d = byDay.get(dayKey(e.created_at));
    if (d) d.expenses++;
  }
  for (const u of db.prepare('SELECT ts, cost FROM llm_usage WHERE ts >= ?').all(since) as { ts: number; cost: number }[]) {
    const d = byDay.get(dayKey(u.ts));
    if (d) d.spend += u.cost;
  }
  const models = db
    .prepare(
      `SELECT model, COUNT(*) AS calls, COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(cost), 0) AS cost FROM llm_usage WHERE ts >= ? GROUP BY model ORDER BY calls DESC`,
    )
    .all(since);
  return {
    days: [...byDay.values()].map(({ ms, ...d }) => {
      ms.sort((a, b) => a - b);
      return { ...d, p50: percentile(ms, 0.5), p95: percentile(ms, 0.95) };
    }),
    models,
  };
}

// ── Housekeeping ────────────────────────────────────────────────

/** Drop what nobody will look at again: old traces (the bulk of the file), usage rows, reply and poll bookkeeping. */
export function prune() {
  const day = 86_400_000;
  const now = Date.now();
  db.prepare('UPDATE jobs SET trace = NULL WHERE trace IS NOT NULL AND flagged = 0 AND created_at < ?').run(now - 60 * day);
  db.prepare("DELETE FROM jobs WHERE status = 'rejected' AND created_at < ?").run(now - 30 * day);
  db.prepare('DELETE FROM llm_usage WHERE ts < ?').run(now - 120 * day);
  db.prepare('DELETE FROM bot_messages WHERE created_at < ?').run(now - 60 * day);
  db.prepare('DELETE FROM polls WHERE created_at < ?').run(now - 30 * day);
  db.prepare("DELETE FROM drafts WHERE status != 'pending' AND created_at < ?").run(now - 60 * day);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

/** A consistent copy of the database in one file. */
export function backupTo(file: string) {
  fs.rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
}

/** Amounts of the group's live expenses in one currency, for spotting an amount far outside the usual. */
export function groupAmounts(groupJid: string, currency: string): number[] {
  const rows = db
    .prepare('SELECT cost FROM expenses WHERE wa_group_jid = ? AND currency = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 200')
    .all(groupJid, currency) as { cost: string }[];
  return rows.map((r) => Number(r.cost)).filter((n) => n > 0);
}

// ── Drafts ──────────────────────────────────────────────────────

export interface Draft {
  id: number;
  wa_group_jid: string;
  job_id: number | null;
  bot_msg_id: string | null;
  spec: string;
  assumptions: string | null;
  status: 'pending' | 'confirmed' | 'discarded';
  expense_id: number | null;
  dry_run: number;
  nudged_at: number | null;
  image_hash: string | null;
  /** JSON [{alias, splitwise_user_id}] to remember once the draft is confirmed. */
  aliases: string | null;
  /** JSON string[]: why code forced this to be a draft (possible duplicate, unusual amount…). */
  checks: string | null;
  created_at: number;
}

export const DRAFT_TTL_MS = 48 * 60 * 60_000;

export function createDraft(d: {
  groupJid: string;
  jobId: number;
  spec: unknown;
  assumptions: string[];
  dryRun: boolean;
  imageHash?: string | null;
  aliases?: Alias[];
  checks?: string[];
}): number {
  const res = db
    .prepare('INSERT INTO drafts (wa_group_jid, job_id, spec, assumptions, dry_run, image_hash, aliases, checks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      d.groupJid, d.jobId, JSON.stringify(d.spec), JSON.stringify(d.assumptions), d.dryRun ? 1 : 0,
      d.imageHash ?? null, JSON.stringify(d.aliases ?? []), JSON.stringify(d.checks ?? []), Date.now(),
    );
  return Number(res.lastInsertRowid);
}

/** Every pending draft, newest first (dashboard). */
export function allPendingDrafts(): Draft[] {
  return db
    .prepare("SELECT * FROM drafts WHERE status = 'pending' AND created_at > ? ORDER BY id DESC")
    .all(Date.now() - DRAFT_TTL_MS) as unknown as Draft[];
}

/** Real drafts nobody answered for a while and that were not reminded about yet. */
export function draftsToNudge(olderThanMs: number): Draft[] {
  return db
    .prepare("SELECT * FROM drafts WHERE status = 'pending' AND dry_run = 0 AND nudged_at IS NULL AND created_at < ? AND created_at > ? ORDER BY id")
    .all(Date.now() - olderThanMs, Date.now() - DRAFT_TTL_MS) as unknown as Draft[];
}

export function markNudged(ids: number[]) {
  const stmt = db.prepare('UPDATE drafts SET nudged_at = ? WHERE id = ?');
  for (const id of ids) stmt.run(Date.now(), id);
}

export function getDraft(id: number): Draft | undefined {
  return db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Draft | undefined;
}

export function pendingDrafts(groupJid: string): Draft[] {
  return db
    .prepare("SELECT * FROM drafts WHERE wa_group_jid = ? AND status = 'pending' AND created_at > ? ORDER BY id")
    .all(groupJid, Date.now() - DRAFT_TTL_MS) as unknown as Draft[];
}

export function draftsForBotMessage(botMsgId: string): Draft[] {
  return db
    .prepare("SELECT * FROM drafts WHERE bot_msg_id = ? AND status = 'pending' AND created_at > ?")
    .all(botMsgId, Date.now() - DRAFT_TTL_MS) as unknown as Draft[];
}

export function draftsForJob(jobId: number): Draft[] {
  return db.prepare("SELECT * FROM drafts WHERE job_id = ? AND status = 'pending'").all(jobId) as unknown as Draft[];
}

export function attachDraftsToMessage(ids: number[], botMsgId: string) {
  const stmt = db.prepare('UPDATE drafts SET bot_msg_id = ? WHERE id = ?');
  for (const id of ids) stmt.run(botMsgId, id);
}

export function setDraftStatus(id: number, status: Draft['status'], expenseId: number | null = null) {
  db.prepare('UPDATE drafts SET status = ?, expense_id = ? WHERE id = ?').run(status, expenseId, id);
}

/** Record a guard rejection so it shows on the dashboard (never counted towards rate limits). */
export function rejectJob(j: { msgId: string | null; groupJid: string; groupName: string | null; senderContactId: number; senderName: string | null; text: string; reason: string }) {
  db.prepare(
    `INSERT OR IGNORE INTO jobs (msg_id, wa_group_jid, group_name, sender_contact_id, sender_name, text, status, error, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, 'rejected', ?, ?, ?)`,
  ).run(j.msgId, j.groupJid, j.groupName, j.senderContactId, j.senderName, j.text, j.reason, Date.now(), Date.now());
}

/** LLM-processed jobs (not rejections) since `since`, by sender or by group. */
export function countJobs(by: { senderContactId?: number; groupJid?: string }, since: number): number {
  const col = by.senderContactId !== undefined ? 'sender_contact_id' : 'wa_group_jid';
  const val = by.senderContactId ?? by.groupJid ?? null;
  return (db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${col} = ? AND created_at >= ? AND status != 'rejected' AND dry_run = 0`)
    .get(val, since) as { n: number }).n;
}

export function lastJobFrom(senderContactId: number): Job | undefined {
  return db.prepare('SELECT * FROM jobs WHERE sender_contact_id = ? ORDER BY id DESC LIMIT 1').get(senderContactId) as Job | undefined;
}

// ── LLM usage ───────────────────────────────────────────────────

export function recordUsage(model: string, promptTokens: number, completionTokens: number, cost: number) {
  db.prepare('INSERT INTO llm_usage (ts, model, prompt_tokens, completion_tokens, cost) VALUES (?, ?, ?, ?, ?)').run(
    Date.now(), model, promptTokens, completionTokens, cost,
  );
}

/** USD spent since `since` (providers that report cost, i.e. OpenRouter). */
export function spendSince(since: number): number {
  return (db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM llm_usage WHERE ts >= ?').get(since) as { c: number }).c;
}

/** Midnight today in the bot's timezone, as epoch ms. */
export function startOfDay(): number {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: config.bot.timezone }));
  local.setHours(0, 0, 0, 0);
  return now.getTime() - (new Date(now.toLocaleString('en-US', { timeZone: config.bot.timezone })).getTime() - local.getTime());
}
