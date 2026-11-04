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
`);

// Columns added after the first release.
const contactCols = (db.prepare('PRAGMA table_info(contacts)').all() as { name: string }[]).map((c) => c.name);
if (!contactCols.includes('muted')) db.exec('ALTER TABLE contacts ADD COLUMN muted INTEGER NOT NULL DEFAULT 0');

// ── Group links ─────────────────────────────────────────────────

export interface GroupLink {
  wa_group_jid: string;
  wa_group_name: string | null;
  splitwise_group_id: number | null;
  splitwise_group_name: string | null;
  enabled: number;
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

export function linkGroup(jid: string, splitwiseGroupId: number | null, splitwiseGroupName: string | null) {
  upsertGroup(jid, null);
  db.prepare('UPDATE group_links SET splitwise_group_id = ?, splitwise_group_name = ? WHERE wa_group_jid = ?').run(
    splitwiseGroupId,
    splitwiseGroupName,
    jid,
  );
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

export function listJobs(limit = 100): Job[] {
  return db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit) as unknown as Job[];
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
  deleted: number;
  created_at: number;
}

export function saveExpense(e: Omit<ExpenseRow, 'deleted' | 'created_at'>) {
  db.prepare(
    `INSERT INTO expenses (splitwise_expense_id, job_id, wa_group_jid, splitwise_group_id, description, cost, currency, spec, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(splitwise_expense_id) DO UPDATE SET description = excluded.description, cost = excluded.cost,
       currency = excluded.currency, spec = excluded.spec, deleted = 0`,
  ).run(e.splitwise_expense_id, e.job_id, e.wa_group_jid, e.splitwise_group_id, e.description, e.cost, e.currency, e.spec, Date.now());
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

export function stats() {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    jobs: one('SELECT COUNT(*) AS n FROM jobs'),
    jobErrors: one("SELECT COUNT(*) AS n FROM jobs WHERE status = 'error'"),
    expenses: one('SELECT COUNT(*) AS n FROM expenses WHERE deleted = 0'),
    rejectedToday: one(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'rejected' AND created_at >= ${startOfDay()}`),
    spendToday: spendSince(startOfDay()),
  };
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
  created_at: number;
}

const DRAFT_TTL_MS = 48 * 60 * 60_000;

export function createDraft(d: { groupJid: string; jobId: number; spec: unknown; assumptions: string[]; dryRun: boolean }): number {
  const res = db
    .prepare('INSERT INTO drafts (wa_group_jid, job_id, spec, assumptions, dry_run, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(d.groupJid, d.jobId, JSON.stringify(d.spec), JSON.stringify(d.assumptions), d.dryRun ? 1 : 0, Date.now());
  return Number(res.lastInsertRowid);
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
