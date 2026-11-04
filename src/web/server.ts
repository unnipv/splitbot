import crypto from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { handleMessage } from '../agent.ts';
import { denialFor } from '../denial.ts';
import { config } from '../config.ts';
import * as store from '../db.ts';
import { bus, errMsg, logger, recentLogs } from '../log.ts';
import * as sw from '../splitwise.ts';
import * as wa from '../whatsapp.ts';

const log = logger('web');
/** Fake group so the agent can be tried (and linked to a Splitwise group) before the bot joins any real chat. */
const PLAYGROUND_JID = 'playground@g.us';

function basicAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.web.password) return next();
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(/:(.*)/s);
    const ok = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    if (ok(user, config.web.user) && ok(pass ?? '', config.web.password)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="splitbot"').status(401).send('Authentication required');
}

/** Wrap async handlers so thrown errors become JSON 500s. */
const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((err) => {
    log.warn(`${req.method} ${req.path} failed`, errMsg(err));
    res.status(500).json({ error: errMsg(err) });
  });

export function startWeb() {
  const app = express();
  const oauthStates = new Set<string>();

  // OAuth callback is exempt from basic auth (the redirect may land on a different origin); it's protected by `state`.
  app.get('/api/splitwise/callback', h(async (req, res) => {
    const { code, state } = req.query as Record<string, string>;
    if (!code || !state || !oauthStates.delete(state)) return res.status(400).send('Invalid OAuth callback');
    await sw.exchangeCode(code);
    res.redirect('/#status');
  }));

  app.use(basicAuth);
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
      uptime: process.uptime(),
    });
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
    res.json({ code: await wa.requestPairingCode(String(req.body.phone ?? '')) });
  }));
  app.post('/api/whatsapp/logout', h(async (_req, res) => {
    await wa.logout();
    res.json({ ok: true });
  }));

  // ── Splitwise ──
  app.get('/api/splitwise/auth', (_req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.add(state);
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
    res.json(store.listGroupLinks());
  }));
  app.post('/api/groups/:jid/link', h(async (req, res) => {
    const id = req.body.splitwise_group_id ? Number(req.body.splitwise_group_id) : null;
    const g = id ? (await sw.listGroups()).find((x) => x.id === id) : null;
    if (id && !g) return res.status(404).json({ error: 'Splitwise group not found' });
    store.linkGroup(String(req.params.jid), g?.id ?? null, g?.name ?? null);
    res.json({ ok: true });
  }));
  app.post('/api/groups/:jid/enabled', (req, res) => {
    store.setGroupEnabled(String(req.params.jid), !!req.body.enabled);
    res.json({ ok: true });
  });
  app.get('/api/groups/:jid/members', h(async (req, res) => {
    const jid = String(req.params.jid);
    const link = store.getGroupLink(jid);
    const members = link?.splitwise_group_id ? (await sw.getGroup(link.splitwise_group_id, true)).members : [];
    res.json({
      splitwise: members.map((m) => ({ id: m.id, name: sw.swName(m), balance: m.balance })),
      whatsapp: wa.knownParticipants(jid),
    });
  }));
  app.post('/api/groups/:jid/announce', h(async (req, res) => {
    await wa.sendText(String(req.params.jid), String(req.body.text ?? ''));
    res.json({ ok: true });
  }));

  // ── Contacts ──
  app.get('/api/contacts', (_req, res) => res.json(store.listContacts()));
  app.post('/api/contacts/:id/mute', (req, res) => {
    store.setContactMuted(Number(req.params.id), !!req.body.muted);
    res.json({ ok: true });
  });
  app.post('/api/contacts/:id/link', (req, res) => {
    const id = req.body.splitwise_user_id ? Number(req.body.splitwise_user_id) : null;
    store.linkContact(Number(req.params.id), id, id ? String(req.body.splitwise_name ?? '') || null : null);
    res.json({ ok: true });
  });

  // ── Jobs / expenses ──
  app.get('/api/jobs', (_req, res) => res.json(store.listJobs(150).map(({ trace, ...j }) => j)));
  app.get('/api/jobs/:id', (req, res) => {
    const job = store.getJob(Number(req.params.id));
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json({ ...job, trace: job.trace ? JSON.parse(job.trace) : null });
  });
  app.get('/api/expenses', (_req, res) => res.json(store.recentExpenses(null, 100)));

  // ── Playground: run the agent without WhatsApp (dry run by default) ──
  app.post('/api/simulate', h(async (req, res) => {
    const { group_jid, sender_contact_id, sender_name, text, image, reply_to_job_id, dry_run = true } = req.body as Record<string, any>;
    if (!group_jid) return res.status(400).json({ error: 'group_jid required' });
    if (group_jid === PLAYGROUND_JID) store.upsertGroup(PLAYGROUND_JID, 'Playground');
    let sender = sender_contact_id ? store.getContact(Number(sender_contact_id)) : undefined;
    if (!sender) {
      // The default playground sender is you (the Splitwise account owner), so "I paid" means something.
      const me = await sw.currentUser();
      sender = store.resolveContact({ pn: 'playground', pushName: sender_name || me.first_name });
      if (!sender.splitwise_user_id) store.linkContact(sender.id, me.id, sw.swName(me));
      sender = store.getContact(sender.id)!;
    }
    const link = store.getGroupLink(group_jid);
    const jobId = store.createJob({
      msgId: null,
      groupJid: group_jid,
      groupName: link?.wa_group_name ?? null,
      senderContactId: sender.id,
      senderName: sender.push_name,
      text: String(text ?? ''),
      hasImage: !!image,
      dryRun: !!dry_run,
    })!;
    bus.emit('job', { id: jobId });
    const images = image
      ? [{ data: Buffer.from(String(image).split(',').pop()!, 'base64'), mime: String(image).match(/^data:([^;]+)/)?.[1] ?? 'image/jpeg' }]
      : [];
    try {
      const prevJob = reply_to_job_id ? store.getJob(Number(reply_to_job_id)) : undefined;
      const quoted = prevJob
        ? {
            text: prevJob.reply ?? '',
            fromBot: true,
            expenseIds: store.recentExpenses(group_jid, 50).filter((e) => e.job_id === prevJob.id).map((e) => e.splitwise_expense_id),
            draftIds: store.draftsForJob(prevJob.id).map((d) => d.id),
          }
        : undefined;
      const result = await handleMessage({
        quoted,
        jobId,
        groupJid: group_jid,
        groupName: link?.wa_group_name ?? null,
        sender,
        text: String(text ?? ''),
        images,
        recentChat: [],
        participants: wa.knownParticipants(group_jid),
        dryRun: !!dry_run,
      });
      if (result.offTopic) {
        const denial = await denialFor({ reason: 'off-topic (model)', kind: 'offtopic', strike: 1 }, { name: sender.push_name ?? 'aliya', text: String(text ?? '') });
        result.reply = denial?.text ?? (denial?.sticker ? '[last warning sticker]' : '[ignored]');
      }
      store.finishJob(jobId, { status: 'done', reply: result.reply, trace: result.trace });
      res.json({ jobId, ...result });
    } catch (err) {
      store.finishJob(jobId, { status: 'error', error: errMsg(err) });
      throw err;
    } finally {
      bus.emit('job', { id: jobId });
    }
  }));

  app.listen(config.web.port, () => {
    log.info(`Dashboard on http://0.0.0.0:${config.web.port}`);
    if (!config.web.password) log.warn('DASHBOARD_PASSWORD is empty — dashboard is open to anyone on your network');
  });
}
