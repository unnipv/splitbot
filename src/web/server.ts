import crypto from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { confirmDrafts, draftPreview, groupNames, handleMessage } from '../agent.ts';
import { config } from '../config.ts';
import * as store from '../db.ts';
import { denialFor } from '../denial.ts';
import { oneLine } from '../format.ts';
import { bus, errMsg, logger, recentLogs } from '../log.ts';
import { getSettings, saveSettings } from '../settings.ts';
import { computeShares, type ExpenseSpec } from '../split.ts';
import * as sw from '../splitwise.ts';
import * as wa from '../whatsapp.ts';

const log = logger('web');
/** Fake group so the agent can be tried (and linked to a Splitwise group) before the bot joins any real chat. */
const PLAYGROUND_JID = 'playground@g.us';

// ── Access control ──────────────────────────────────────────────

const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60_000;
const authFails = new Map<string, { n: number; since: number }>();

function clientIp(req: Request): string {
  const ip = req.socket.remoteAddress ?? '?';
  // Behind Tailscale Serve every request comes from loopback; the real peer is in X-Forwarded-For.
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return loopback && fwd ? fwd : ip;
}

function basicAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.web.password) return next(); // only reachable on loopback then (see config.web.host)
  const ip = clientIp(req);
  const fails = authFails.get(ip);
  if (fails && Date.now() - fails.since > FAIL_WINDOW_MS) authFails.delete(ip);
  else if (fails && fails.n >= MAX_FAILS) {
    return res.status(429).set('Retry-After', '900').send('Too many failed logins — try again in 15 minutes');
  }
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(/:(.*)/s);
    // Hash first so the comparison is constant-time whatever the lengths.
    const digest = (s: string) => crypto.createHash('sha256').update(s).digest();
    const ok = (a: string, b: string) => crypto.timingSafeEqual(digest(a), digest(b));
    const userOk = ok(user ?? '', config.web.user);
    const passOk = ok(pass ?? '', config.web.password);
    if (userOk && passOk) return next();
    const cur = authFails.get(ip) ?? { n: 0, since: Date.now() };
    cur.n++;
    authFails.set(ip, cur);
    if (cur.n === MAX_FAILS) log.warn(`Dashboard login locked for ${ip} after ${MAX_FAILS} wrong passwords`);
    if (authFails.size > 5000) authFails.clear();
  }
  res.set('WWW-Authenticate', 'Basic realm="splitbot"').status(401).send('Authentication required');
}

/**
 * The browser attaches the saved login to requests from any site, so another page could fire a POST at the dashboard.
 * Changes are therefore only accepted from the dashboard's own pages (non-browser clients send neither header).
 */
function sameOriginOnly(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none' ? next() : res.status(403).json({ error: 'Cross-site request refused' });
  const origin = req.headers.origin;
  if (!origin) return next();
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {}
  const mine = [req.headers.host, req.headers['x-forwarded-host']].flat().filter(Boolean);
  return mine.includes(host) ? next() : res.status(403).json({ error: 'Cross-site request refused' });
}

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Wrap handlers so thrown errors become JSON errors (HttpError keeps its status, anything else is a 500). */
const h = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log.warn(`${req.method} ${req.path} failed`, errMsg(err));
      res.status(status).json({ error: errMsg(err) });
    });

// ── Helpers ─────────────────────────────────────────────────────

function knownGroup(jid: string) {
  const link = store.getGroupLink(jid);
  if (!link) throw new HttpError(404, 'Unknown group');
  return link;
}

const isRealGroup = (jid: string | null) => !!jid && jid.endsWith('@g.us') && jid !== PLAYGROUND_JID;

const SPLIT_WORDS: Record<string, string> = { equal: 'equally', exact: 'by amount', percent: 'by percentage', shares: 'by shares', adjustment: 'equally + extras' };

/** "Arjun" / "split equally · 4 people" for the expenses table. */
function describe(spec: ExpenseSpec | null, names: Map<number, string>) {
  if (!spec) return { paid_by: '', split: '', date: null, payment: false };
  const n = (id: number) => names.get(id) ?? `#${id}`;
  let shares: ReturnType<typeof computeShares> = [];
  try {
    shares = computeShares(spec);
  } catch {}
  const payers = shares.filter((s) => Number(s.paid_share) > 0).map((s) => n(s.user_id));
  const owers = shares.filter((s) => Number(s.owed_share) > 0).map((s) => n(s.user_id));
  return {
    paid_by: payers.join(', '),
    split: spec.payment
      ? `to ${owers.join(', ')}`
      : owers.length <= 3
        ? `${SPLIT_WORDS[spec.split.type] ?? spec.split.type} · ${owers.join(', ')}`
        : `${SPLIT_WORDS[spec.split.type] ?? spec.split.type} · ${owers.length} people`,
    date: spec.date ?? null,
    payment: !!spec.payment,
  };
}

async function namesFor(jid: string | null, cache: Map<string, Map<number, string>>) {
  if (!jid) return new Map<number, string>();
  if (!cache.has(jid)) cache.set(jid, await groupNames(jid).then((g) => g.names).catch(() => new Map<number, string>()));
  return cache.get(jid)!;
}

const parseSpec = (json: string): ExpenseSpec | null => {
  try {
    return JSON.parse(json) as ExpenseSpec;
  } catch {
    return null;
  }
};

/** What the owner should look at, most urgent first. */
async function attention(swError: string | null) {
  const out: { kind: 'error' | 'warn' | 'info'; text: string; href: string | null }[] = [];
  const add = (kind: 'error' | 'warn' | 'info', text: string, href: string | null = null) => out.push({ kind, text, href });
  if (wa.status.state !== 'open') add('error', wa.status.state === 'qr' ? 'WhatsApp is not linked — scan the QR code' : `WhatsApp is ${wa.status.state.replace('_', ' ')}`, '#home');
  if (!sw.isConnected()) add('error', 'Splitwise is not connected', '#home');
  else if (swError) add('error', `Splitwise: ${swError}`, '#home');
  if (!config.llm.agent.length) add('error', 'No AI model is configured (set OPENROUTER_API_KEY or GROQ_API_KEY)', '#settings');

  const groups = store.listGroupLinks().filter((g) => isRealGroup(g.wa_group_jid));
  const waiting = groups.filter((g) => !g.approved);
  if (waiting.length) add('warn', `${waiting.length} chat${waiting.length === 1 ? ' is' : 's are'} waiting for your approval: ${waiting.map((g) => g.wa_group_name ?? 'unnamed').slice(0, 3).join(', ')}`, '#groups');
  for (const g of groups.filter((x) => x.approved && x.enabled)) {
    if (!g.splitwise_group_id) {
      add('warn', `"${g.wa_group_name ?? g.wa_group_jid}" has no Splitwise group yet`, '#groups');
      continue;
    }
    const unlinked = wa.knownParticipants(g.wa_group_jid).filter((c) => !c.splitwise_user_id).length;
    if (unlinked) add('info', `${unlinked} ${unlinked === 1 ? 'person' : 'people'} in "${g.wa_group_name ?? g.wa_group_jid}" ${unlinked === 1 ? "isn't" : "aren't"} matched to a Splitwise member`, '#groups');
  }
  const st = store.stats();
  if (st.pendingDrafts) add('info', `${st.pendingDrafts} draft${st.pendingDrafts === 1 ? '' : 's'} waiting for a yes`, '#expenses');
  const recentErrors = store.listJobs({ status: 'error', limit: 100 }).filter((j) => Date.now() - j.created_at < 86_400_000).length;
  if (recentErrors) add('warn', `${recentErrors} message${recentErrors === 1 ? '' : 's'} failed in the last 24 hours`, '#activity');
  if (st.spendToday >= config.limits.dailyBudgetUsd) add('warn', 'Daily AI budget reached — only free models are in use until midnight', '#settings');
  if (config.web.weakPassword) add('warn', 'The dashboard password is empty or still "change-me", so the dashboard only listens on this machine. Set DASHBOARD_PASSWORD in .env.');
  if (!config.bot.ownerPhone) add('info', 'OWNER_PHONE is not set: you can only approve chats here, and alerts have nowhere to go');
  return out;
}

// ── Server ──────────────────────────────────────────────────────

export function startWeb() {
  const app = express();
  app.disable('x-powered-by');
  /** OAuth `state` values we issued, with when; one use, 10 minutes. */
  const oauthStates = new Map<string, number>();

  app.use(securityHeaders);

  // For uptime checks: says only whether the process is up and WhatsApp is connected.
  app.get('/healthz', (_req, res) => {
    const ok = wa.status.state === 'open' && sw.isConnected();
    res.status(ok ? 200 : 503).json({ ok, whatsapp: wa.status.state, splitwise: sw.isConnected() });
  });

  // OAuth callback is exempt from basic auth (the redirect may land on a different origin); it's protected by `state`.
  app.get('/api/splitwise/callback', h(async (req, res) => {
    const { code, state } = req.query as Record<string, string>;
    const issued = state ? oauthStates.get(state) : undefined;
    if (state) oauthStates.delete(state);
    if (!code || !issued || Date.now() - issued > 10 * 60_000) return res.status(400).send('Invalid or expired OAuth callback');
    await sw.exchangeCode(code);
    res.redirect('/#home');
  }));

  app.use(basicAuth);
  app.use(sameOriginOnly);
  app.use(express.json({ limit: '15mb' }));
  app.use(express.static(path.resolve(import.meta.dirname, '../../public')));

  // ── Status / events ──
  app.get('/api/status', h(async (_req, res) => {
    let user: sw.SwUser | null = null;
    let swError: string | null = null;
    if (sw.isConnected()) user = await sw.currentUser().catch((e) => ((swError = errMsg(e)), null));
    res.json({
      whatsapp: wa.status,
      splitwise: { connected: sw.isConnected(), user, error: swError, redirectUri: config.splitwise.redirectUri },
      llm: { agent: config.llm.agent.map((m) => m.id), vision: config.llm.vision.map((m) => m.id) },
      bot: { triggers: config.bot.triggers, currency: config.bot.defaultCurrency, timezone: config.bot.timezone },
      stats: store.stats(),
      limits: config.limits,
      attention: await attention(swError),
      uptime: process.uptime(),
    });
  }));

  app.get('/api/metrics', h((req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
    res.json(store.metrics(days));
  }));

  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event: string) => (data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const handlers = { log: send('log'), status: send('status'), job: send('job') };
    for (const [e, fn] of Object.entries(handlers)) bus.on(e, fn);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      for (const [e, fn] of Object.entries(handlers)) bus.off(e, fn);
    });
  });

  app.get('/api/logs', (_req, res) => res.json(recentLogs()));

  // ── WhatsApp ──
  app.post('/api/whatsapp/pair', h(async (req, res) => {
    res.json({ code: await wa.requestPairingCode(String(req.body?.phone ?? '')) });
  }));
  app.post('/api/whatsapp/logout', h(async (_req, res) => {
    await wa.logout();
    res.json({ ok: true });
  }));

  // ── Splitwise ──
  app.get('/api/splitwise/auth', (_req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    for (const [s, at] of oauthStates) if (Date.now() - at > 10 * 60_000) oauthStates.delete(s);
    oauthStates.set(state, Date.now());
    res.redirect(sw.authorizeUrl(state));
  });
  app.post('/api/splitwise/disconnect', (_req, res) => {
    sw.disconnect();
    res.json({ ok: true });
  });
  app.get('/api/splitwise/groups', h(async (_req, res) => {
    const groups = await sw.listGroups();
    res.json(groups.map((g) => ({ id: g.id, name: g.name, members: g.members.map((m) => ({ id: m.id, name: sw.swName(m) })) })));
  }));

  // ── Groups ──
  app.get('/api/groups', h(async (_req, res) => {
    await wa.refreshGroups().catch(() => []);
    // Chats waiting for approval first.
    res.json(store.listGroupLinks().sort((a, b) => a.approved - b.approved));
  }));
  app.post('/api/groups/:jid/link', h(async (req, res) => {
    const jid = String(req.params.jid);
    knownGroup(jid);
    const id = req.body?.splitwise_group_id ? Number(req.body.splitwise_group_id) : null;
    const g = id ? (await sw.listGroups()).find((x) => x.id === id) : null;
    if (id && !g) throw new HttpError(404, 'Splitwise group not found');
    store.linkGroup(jid, g?.id ?? null, g?.name ?? null);
    res.json({ ok: true });
  }));
  app.post('/api/groups/:jid/enabled', h((req, res) => {
    const jid = String(req.params.jid);
    knownGroup(jid);
    store.setGroupEnabled(jid, !!req.body?.enabled);
    res.json({ ok: true });
  }));
  app.post('/api/groups/:jid/settings', h((req, res) => {
    const jid = String(req.params.jid);
    knownGroup(jid);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof store.setGroupSettings>[1] = {};
    if ('currency' in b) {
      if (b.currency !== null && !/^[A-Za-z]{3}$/.test(String(b.currency))) throw new HttpError(400, 'Currency must be a 3-letter code, e.g. THB');
      patch.currency = b.currency === null ? null : String(b.currency).toUpperCase();
    }
    if ('confirm_mode' in b) {
      if (b.confirm_mode !== null && !['auto', 'always', 'never'].includes(String(b.confirm_mode))) throw new HttpError(400, 'confirm_mode must be auto, always or never');
      patch.confirm_mode = b.confirm_mode === null ? null : String(b.confirm_mode);
    }
    if ('notes' in b) {
      const notes = b.notes === null ? '' : String(b.notes).trim();
      if (notes.length > 1000) throw new HttpError(400, 'Standing notes can be at most 1000 characters');
      patch.notes = notes || null;
    }
    if ('digest' in b) patch.digest = !!b.digest;
    store.setGroupSettings(jid, patch);
    if ('approved' in b) store.approveGroup(jid, !!b.approved);
    if ('enabled' in b) store.setGroupEnabled(jid, !!b.enabled);
    res.json({ ok: true });
  }));
  app.get('/api/groups/:jid/members', h(async (req, res) => {
    const jid = String(req.params.jid);
    const link = store.getGroupLink(jid);
    const members = link?.splitwise_group_id ? (await sw.getGroup(link.splitwise_group_id, true)).members : [];
    res.json({
      splitwise: members.map((m) => ({ id: m.id, name: sw.swName(m), balance: m.balance })),
      whatsapp: wa.knownParticipants(jid),
    });
  }));
  app.get('/api/groups/:jid/aliases', h(async (req, res) => {
    const jid = String(req.params.jid);
    const { names } = await groupNames(jid).catch(() => ({ names: new Map<number, string>() }));
    res.json(store.listAliases(jid).map((a) => ({ ...a, name: names.get(a.splitwise_user_id) ?? `#${a.splitwise_user_id}` })));
  }));
  app.post('/api/groups/:jid/aliases', h(async (req, res) => {
    const jid = String(req.params.jid);
    knownGroup(jid);
    const alias = String(req.body?.alias ?? '').trim();
    const userId = Number(req.body?.splitwise_user_id);
    if (alias.length < 2 || alias.length > 40) throw new HttpError(400, 'A nickname needs 2–40 characters');
    const { memberIds } = await groupNames(jid);
    if (!memberIds.includes(userId)) throw new HttpError(400, "That person isn't a member of the linked Splitwise group");
    store.saveAlias(jid, alias, userId);
    res.json({ ok: true });
  }));
  app.delete('/api/groups/:jid/aliases/:alias', h((req, res) => {
    store.deleteAlias(String(req.params.jid), String(req.params.alias));
    res.json({ ok: true });
  }));

  // ── Contacts ──
  app.get('/api/contacts', (_req, res) => res.json(store.listContacts()));
  app.post('/api/contacts/:id/mute', h((req, res) => {
    store.setContactMuted(Number(req.params.id), !!req.body?.muted);
    res.json({ ok: true });
  }));
  app.post('/api/contacts/:id/link', h((req, res) => {
    const id = req.body?.splitwise_user_id ? Number(req.body.splitwise_user_id) : null;
    store.linkContact(Number(req.params.id), id, id ? String(req.body.splitwise_name ?? '') || null : null);
    res.json({ ok: true });
  }));

  // ── Jobs ──
  app.get('/api/jobs', h((req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const rows = store.listJobs({
      status: ['running', 'done', 'error', 'rejected'].includes(q.status ?? '') ? q.status : undefined,
      group: q.group || undefined,
      q: q.q?.trim() || undefined,
      flagged: q.flagged === '1',
      before: Number(q.before) || undefined,
      limit: limit + 1,
    });
    res.json({ jobs: rows.slice(0, limit).map(({ trace, ...j }) => j), hasMore: rows.length > limit });
  }));
  app.get('/api/jobs/:id', h((req, res) => {
    const job = store.getJob(Number(req.params.id));
    if (!job) throw new HttpError(404, 'Not found');
    res.json({ ...job, trace: job.trace ? JSON.parse(job.trace) : null });
  }));
  app.post('/api/jobs/:id/flag', h((req, res) => {
    const job = store.getJob(Number(req.params.id));
    if (!job) throw new HttpError(404, 'Not found');
    store.flagJob(job.id, !!req.body?.wrong, String(req.body?.note ?? '').trim().slice(0, 1000) || null);
    res.json({ ok: true });
  }));
  // Messages the owner marked as handled wrongly, with what the model was shown: raw material for scripts/eval.ts cases.
  app.get('/api/eval-cases', h((_req, res) => {
    const cases = store.listJobs({ flagged: true, limit: 500 }).map((j) => {
      let context: string | null = null;
      try {
        context = (JSON.parse(j.trace ?? '[]') as { step: string; user?: string }[]).find((t) => t.step === 'context')?.user ?? null;
      } catch {}
      return { id: j.id, when: new Date(j.created_at).toISOString(), group: j.group_name, sender: j.sender_name, text: j.text, has_image: !!j.has_image, bot_reply: j.reply, what_was_wrong: j.flag_note, model_input: context };
    });
    res.set('Content-Disposition', 'attachment; filename="splitbot-eval-cases.json"').json(cases);
  }));

  // ── Expenses and drafts ──
  app.get('/api/expenses', h(async (req, res) => {
    const group = String(req.query.group ?? '') || undefined;
    const rows = store.listExpenses({ group, limit: Math.min(Number(req.query.limit) || 100, 500), includeDeleted: true });
    const cache = new Map<string, Map<number, string>>();
    const groupName = new Map(store.listGroupLinks().map((g) => [g.wa_group_jid, g.wa_group_name]));
    const out = [];
    for (const e of rows) {
      const { spec, image_hash, ...row } = e;
      out.push({
        ...row,
        group_name: (e.wa_group_jid && groupName.get(e.wa_group_jid)) ?? null,
        ...describe(parseSpec(spec), await namesFor(e.wa_group_jid, cache)),
        url: `https://secure.splitwise.com/#/groups/${e.splitwise_group_id}/expenses/${e.splitwise_expense_id}`,
      });
    }
    res.json(out);
  }));
  app.post('/api/expenses/:id/delete', h(async (req, res) => {
    const row = store.getExpense(Number(req.params.id));
    if (!row) throw new HttpError(404, 'Not an expense the bot added');
    if (row.deleted) throw new HttpError(400, 'Already deleted');
    await sw.deleteExpense(row.splitwise_expense_id, row.splitwise_group_id ?? undefined);
    store.markExpenseDeleted(row.splitwise_expense_id);
    log.info(`Expense #${row.splitwise_expense_id} "${row.description}" deleted from the dashboard`);
    if (isRealGroup(row.wa_group_jid) && wa.isConnected()) {
      wa.sendText(row.wa_group_jid!, `🗑️ Deleted from Splitwise by the bot's owner: *${row.description}* · ${row.currency} ${row.cost} · #${row.splitwise_expense_id}`).catch(() => {});
    }
    res.json({ ok: true });
  }));

  app.get('/api/drafts', h(async (_req, res) => {
    const groupName = new Map(store.listGroupLinks().map((g) => [g.wa_group_jid, g.wa_group_name]));
    const out = [];
    for (const d of store.allPendingDrafts()) {
      const spec = parseSpec(d.spec);
      out.push({
        id: d.id,
        wa_group_jid: d.wa_group_jid,
        group_name: groupName.get(d.wa_group_jid) ?? null,
        job_id: d.job_id,
        created_at: d.created_at,
        dry_run: d.dry_run,
        description: spec?.payment ? 'Payment' : (spec?.description ?? ''),
        cost: spec?.cost ?? null,
        currency: spec?.currency ?? null,
        preview: await draftPreview(d).catch(() => (spec ? oneLine(spec) : '')),
      });
    }
    res.json(out);
  }));
  app.post('/api/drafts/:id/confirm', h(async (req, res) => {
    const draft = store.getDraft(Number(req.params.id));
    if (!draft || draft.status !== 'pending') throw new HttpError(404, 'No such pending draft');
    const jobId = store.createJob({
      msgId: null,
      groupJid: draft.wa_group_jid,
      groupName: store.getGroupLink(draft.wa_group_jid)?.wa_group_name ?? null,
      senderContactId: null,
      senderName: 'Dashboard',
      text: `Confirm draft D${draft.id}`,
      hasImage: false,
      dryRun: !!draft.dry_run,
    })!;
    try {
      const result = await confirmDrafts(draft.wa_group_jid, [draft.id], jobId);
      store.finishJob(jobId, { status: 'done', reply: result.reply, trace: result.trace });
      if (!draft.dry_run && isRealGroup(draft.wa_group_jid) && wa.isConnected()) {
        wa.sendBotMessage(draft.wa_group_jid, `${result.reply}\n_(confirmed by the bot's owner)_`, { jobId, expenseIds: result.expenseIds }).catch(() => {});
      }
      res.json({ ok: true, reply: result.reply });
    } catch (err) {
      store.finishJob(jobId, { status: 'error', error: errMsg(err) });
      throw err;
    } finally {
      bus.emit('job', { id: jobId });
    }
  }));
  app.post('/api/drafts/:id/discard', h((req, res) => {
    const draft = store.getDraft(Number(req.params.id));
    if (!draft || draft.status !== 'pending') throw new HttpError(404, 'No such pending draft');
    store.setDraftStatus(draft.id, 'discarded');
    res.json({ ok: true });
  }));

  // ── Settings ──
  app.get('/api/settings', (_req, res) => res.json(getSettings()));
  app.post('/api/settings', h((req, res) => {
    try {
      res.json(saveSettings((req.body ?? {}) as Record<string, unknown>));
    } catch (err) {
      throw new HttpError(400, errMsg(err));
    }
  }));

  // ── Playground: run the agent without WhatsApp ──

  /** One message through the agent, off WhatsApp. Records a job like a real message would. */
  async function simulate(o: { groupJid: string; sender: store.Contact; text: string; image?: string; replyToJobId?: number; dryRun: boolean }) {
    const link = store.getGroupLink(o.groupJid);
    const jobId = store.createJob({
      msgId: null,
      groupJid: o.groupJid,
      groupName: link?.wa_group_name ?? null,
      senderContactId: o.sender.id,
      senderName: o.sender.push_name,
      text: o.text,
      hasImage: !!o.image,
      dryRun: o.dryRun,
    })!;
    bus.emit('job', { id: jobId });
    const images = o.image
      ? [{ data: Buffer.from(o.image.split(',').pop()!, 'base64'), mime: o.image.match(/^data:([^;]+)/)?.[1] ?? 'image/jpeg' }]
      : [];
    try {
      const prevJob = o.replyToJobId ? store.getJob(o.replyToJobId) : undefined;
      const quoted = prevJob
        ? {
            text: prevJob.reply ?? '',
            fromBot: true,
            expenseIds: store.expensesByJob(prevJob.id).map((e) => e.splitwise_expense_id),
            draftIds: store.draftsForJob(prevJob.id).map((d) => d.id),
            jobId: prevJob.id,
          }
        : undefined;
      const result = await handleMessage({
        quoted,
        jobId,
        groupJid: o.groupJid,
        groupName: link?.wa_group_name ?? null,
        sender: o.sender,
        text: o.text,
        images,
        recentChat: [],
        participants: wa.knownParticipants(o.groupJid),
        dryRun: o.dryRun,
      });
      if (result.offTopic) {
        const denial = await denialFor({ reason: 'off-topic (model)', kind: 'offtopic', strike: 1 }, { name: o.sender.push_name ?? 'aliya', text: o.text });
        result.reply = denial?.text ?? (denial?.sticker ? '[last warning sticker]' : '[ignored]');
      }
      // The stored reply shows the poll as text; the response also carries it so the playground can render buttons.
      const stored = result.poll
        ? [result.reply, `📊 Poll: ${result.poll.question}\n${result.poll.options.map((x) => `○ ${x}`).join('\n')}`].filter(Boolean).join('\n\n')
        : result.reply;
      store.finishJob(jobId, { status: 'done', reply: stored, trace: result.trace });
      const { trace, ...rest } = result;
      return { jobId, ...rest };
    } catch (err) {
      store.finishJob(jobId, { status: 'error', error: errMsg(err) });
      throw err;
    } finally {
      bus.emit('job', { id: jobId });
    }
  }

  /** The default playground sender is you (the Splitwise account owner), so "I paid" means something. */
  async function playgroundSender(name?: string) {
    const me = await sw.currentUser();
    let sender = store.resolveContact({ pn: 'playground', pushName: name || me.first_name });
    if (!sender.splitwise_user_id) store.linkContact(sender.id, me.id, sw.swName(me));
    sender = store.getContact(sender.id)!;
    return sender;
  }

  app.post('/api/simulate', h(async (req, res) => {
    const { group_jid, sender_contact_id, sender_name, text, image, reply_to_job_id, dry_run = true } = (req.body ?? {}) as Record<string, any>;
    if (!group_jid) throw new HttpError(400, 'group_jid required');
    if (group_jid === PLAYGROUND_JID) {
      store.upsertGroup(PLAYGROUND_JID, 'Playground');
      store.approveGroup(PLAYGROUND_JID);
    } else knownGroup(String(group_jid));
    const sender = (sender_contact_id ? store.getContact(Number(sender_contact_id)) : undefined) ?? (await playgroundSender(sender_name));
    res.json(
      await simulate({
        groupJid: String(group_jid),
        sender,
        text: String(text ?? ''),
        image: image ? String(image) : undefined,
        replyToJobId: reply_to_job_id ? Number(reply_to_job_id) : undefined,
        dryRun: !!dry_run,
      }),
    );
  }));

  // Run an old message again with today's prompt and models, without touching Splitwise.
  app.post('/api/jobs/:id/replay', h(async (req, res) => {
    const job = store.getJob(Number(req.params.id));
    if (!job) throw new HttpError(404, 'Not found');
    if (job.has_image) throw new HttpError(400, "This message had a photo, and photos aren't kept — replay it from the Playground with the photo");
    if (!job.wa_group_jid || !store.getGroupLink(job.wa_group_jid)) throw new HttpError(400, 'The group of this message is no longer known');
    const sender = (job.sender_contact_id ? store.getContact(job.sender_contact_id) : undefined) ?? (await playgroundSender());
    const out = await simulate({ groupJid: job.wa_group_jid, sender, text: job.text ?? '', dryRun: true });
    res.json({ jobId: out.jobId, reply: out.reply });
  }));

  app.listen(config.web.port, config.web.host, () => {
    log.info(`Dashboard on http://${config.web.host}:${config.web.port}`);
    if (config.web.weakPassword) {
      const exposed = config.web.host !== '127.0.0.1' && config.web.host !== 'localhost' && config.web.host !== '::1';
      if (exposed) log.error('DASHBOARD_PASSWORD is empty or "change-me" and HOST exposes the dashboard to the network — set a real password');
      else log.warn('DASHBOARD_PASSWORD is empty or "change-me": the dashboard only listens on this machine. Set a real password to reach it from the network.');
    }
  });
}
