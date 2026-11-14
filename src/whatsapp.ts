import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import makeWASocket, {
  Browsers,
  decryptPollVote,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
  type GroupMetadata,
  type WAMessage,
  type WASocket,
  type proto,
} from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { confirmDrafts, handleMessage, isOwner, type AgentInput, type AgentResult, type Poll } from './agent.ts';
import { config } from './config.ts';
import * as store from './db.ts';
import { denialFor, type Denial } from './denial.ts';
import { checkMessage, offtopicStrike } from './guard.ts';
import { oneLine } from './format.ts';
import { transcribe } from './llm.ts';
import { bus, errMsg, logger } from './log.ts';
import type { ExpenseSpec } from './split.ts';

const log = logger('whatsapp');
const baileysLogger = pino({ level: 'warn' });

export interface WaStatus {
  state: 'starting' | 'qr' | 'connecting' | 'open' | 'closed' | 'logged_out';
  qr: string | null; // data URL
  pairingCode: string | null;
  me: { id: string; lid: string | null; name: string | null } | null;
  lastError: string | null;
  since: number;
}

export const status: WaStatus = { state: 'starting', qr: null, pairingCode: null, me: null, lastError: null, since: Date.now() };

function setStatus(patch: Partial<WaStatus>) {
  Object.assign(status, patch, { since: Date.now() });
  bus.emit('status', { whatsapp: status });
}

let sock: WASocket | null = null;
let reconnectDelay = 2_000;
/** Shutting down: finish what is queued, take nothing new, don't reconnect. */
let stopping = false;
/** Messages cut off by the last restart; their groups are told once we are back online. */
let interrupted: store.Job[] = [];

export function setInterrupted(jobs: store.Job[]) {
  interrupted = jobs;
}

// ── Connection ──────────────────────────────────────────────────

export async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(config.waAuthDir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
    logger: baileysLogger,
    browser: Browsers.ubuntu('Splitbot'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    cachedGroupMetadata: async (jid) => groupCache.get(jid)?.meta,
  });
  const s = sock;
  setStatus({ state: 'connecting', qr: null });

  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', async (u) => {
    if (u.qr) {
      setStatus({ state: 'qr', qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 320 }) });
      log.info('Scan the QR code in the dashboard (or terminal) with WhatsApp → Linked devices');
      if (process.stdout.isTTY) console.log(await QRCode.toString(u.qr, { type: 'terminal', small: true }));
    }
    if (u.connection === 'open') {
      reconnectDelay = 2_000;
      const me = s.user!;
      setStatus({
        state: 'open',
        qr: null,
        pairingCode: null,
        lastError: null,
        me: { id: me.id, lid: me.lid ?? null, name: me.name ?? me.verifiedName ?? null },
      });
      log.info(`Connected as ${me.name ?? ''} (${me.id})`);
      refreshGroups().catch((err) => log.warn('Group refresh failed', errMsg(err)));
      notifyInterrupted().catch((err) => log.warn('Restart notice failed', errMsg(err)));
    }
    if (u.connection === 'close') {
      if (stopping) return;
      const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log.warn('Logged out from WhatsApp — clearing session; scan a new QR to link again');
        bus.emit('alert', { key: 'wa-logout', text: '📵 Splitbot was logged out of WhatsApp. Open the dashboard and scan the QR code to link it again.' });
        fs.rmSync(config.waAuthDir, { recursive: true, force: true });
        setStatus({ state: 'logged_out', me: null, lastError: 'Logged out' });
        setTimeout(() => startWhatsApp().catch((e) => log.error('Restart failed', e)), 1_000);
        return;
      }
      const restartRequired = code === DisconnectReason.restartRequired;
      const delay = restartRequired ? 0 : reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
      setStatus({ state: 'closed', lastError: errMsg(u.lastDisconnect?.error ?? 'closed') });
      log.warn(`Connection closed (${code ?? 'unknown'}), reconnecting in ${delay}ms`);
      setTimeout(() => startWhatsApp().catch((e) => log.error('Reconnect failed', e)), delay);
    }
  });

  s.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages) {
      onMessage(s, m).catch((err) => log.error('Message handling failed', err));
    }
  });

  s.ev.on('messages.reaction', (reactions) => {
    for (const r of reactions) {
      if (r.reaction.key?.fromMe || !r.reaction.text) continue;
      const jid = r.key.remoteJid!;
      enqueue(jid, () => onReaction(s, r.key, r.reaction.text!, r.reaction.key ?? {})).catch(() => {});
    }
  });

  s.ev.on('groups.upsert', (groups) => {
    for (const g of groups) {
      groupCache.set(g.id, { at: Date.now(), meta: g });
      const known = store.getGroupLink(g.id);
      store.upsertGroup(g.id, g.subject);
      if (!known) {
        log.info(`Added to group "${g.subject}" — waiting for the owner's approval`);
        // Anyone can add a number to a group, so a new chat does nothing until the owner switches it on.
        bus.emit('alert', { key: `new-group:${g.id}`, text: `👥 Splitbot was added to the group "${g.subject}". It stays silent there until you approve it: tag the bot in that group yourself, or approve it on the dashboard's Groups tab.` });
        sendText(
          g.id,
          `👋 Hi, I'm Splitbot. I log shared expenses to Splitwise.\n\nI'm not switched on for this chat yet: the person who runs me has to approve it and pick the Splitwise group (by tagging me with e.g. _"use Goa Trip"_).\nAfter that, tag me with expenses like _"dinner 2400"_ or a bill photo. Say _help_ for more.`,
        ).catch(() => {});
      }
    }
  });

  s.ev.on('groups.update', (updates) => {
    for (const g of updates) if (g.id && g.subject) store.upsertGroup(g.id, g.subject);
  });
}

export async function requestPairingCode(phone: string) {
  if (!sock) throw new Error('WhatsApp socket not started');
  if (sock.authState.creds.registered) throw new Error('Already linked');
  const code = await sock.requestPairingCode(phone.replace(/\D/g, ''));
  setStatus({ pairingCode: code });
  return code;
}

export async function logout() {
  await sock?.logout();
}

// ── Groups ──────────────────────────────────────────────────────

const groupCache = new Map<string, { at: number; meta: GroupMetadata }>();

async function groupMeta(jid: string): Promise<GroupMetadata | null> {
  const hit = groupCache.get(jid);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.meta;
  try {
    const meta = await sock!.groupMetadata(jid);
    groupCache.set(jid, { at: Date.now(), meta });
    return meta;
  } catch (err) {
    log.warn(`groupMetadata(${jid}) failed`, errMsg(err));
    return hit?.meta ?? null;
  }
}

export async function refreshGroups() {
  if (!sock || status.state !== 'open') return [];
  const all = await sock.groupFetchAllParticipating();
  for (const g of Object.values(all)) {
    groupCache.set(g.id, { at: Date.now(), meta: g });
    store.upsertGroup(g.id, g.subject);
  }
  return Object.values(all).map((g) => ({ jid: g.id, name: g.subject, size: g.participants.length }));
}

function participantContacts(meta: GroupMetadata | null): store.Contact[] {
  if (!meta) return [];
  return meta.participants
    .map((p) => {
      const ids = splitIds([p.id, p.lid, p.phoneNumber]);
      if (isBot(ids)) return null;
      return store.resolveContact({ ...ids, pushName: p.notify ?? p.name ?? null });
    })
    .filter((c): c is store.Contact => !!c);
}

// ── Identity helpers ────────────────────────────────────────────

/** Split a bag of JIDs (some @lid, some @s.whatsapp.net) into bare LID / phone user parts. */
function splitIds(jids: (string | null | undefined)[]): { lid: string | null; pn: string | null } {
  let lid: string | null = null;
  let pn: string | null = null;
  for (const j of jids) {
    const d = j ? jidDecode(j) : undefined;
    if (!d?.user) continue;
    if (d.server === 'lid') lid ??= d.user;
    else if (d.server === 's.whatsapp.net') pn ??= d.user;
  }
  return { lid, pn };
}

function botUsers(): string[] {
  const me = sock?.user;
  return [jidDecode(me?.id)?.user, jidDecode(me?.lid)?.user].filter((u): u is string => !!u);
}

function isBot(ids: { lid: string | null; pn: string | null } | string | null | undefined): boolean {
  if (!ids) return false;
  const users = botUsers();
  if (typeof ids === 'string') return users.includes(jidDecode(ids)?.user ?? '');
  return users.includes(ids.lid ?? '') || users.includes(ids.pn ?? '');
}

// ── Messages ────────────────────────────────────────────────────

const recentChat = new Map<string, { name: string; text: string; ts: number }[]>();
const queues = new Map<string, Promise<unknown>>();
const MAX_AGE_MS = 12 * 60 * 60_000;
// proto.Message.ProtocolMessage.Type
const REVOKE = 0;
const MESSAGE_EDIT = 14;

/** One group's work runs strictly in order. The returned promise rejects if `fn` does; the queue itself never breaks. */
function enqueue<T>(jid: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(jid) ?? Promise.resolve()).then(fn);
  queues.set(jid, next.catch((err) => log.error('Queued work failed', err)));
  return next;
}

/** Let running and queued jobs finish (up to `timeoutMs`), then close the socket. Called on SIGTERM/SIGINT. */
export async function shutdown(timeoutMs = 25_000) {
  stopping = true;
  const pending = [...queues.values()];
  await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, timeoutMs))]);
  try {
    sock?.end(undefined);
  } catch {}
}

/** Something to tell the user as-is (too-big file, unsupported attachment), as opposed to an internal failure. */
class UserError extends Error {}

function textOf(content: proto.IMessage | undefined | null): string {
  if (!content) return '';
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.documentMessage?.caption ??
    content.videoMessage?.caption ??
    ''
  );
}

function contextInfoOf(content: proto.IMessage | undefined): proto.IContextInfo | undefined {
  if (!content) return undefined;
  const type = getContentType(content);
  const inner = type ? (content as any)[type] : undefined;
  return inner?.contextInfo ?? undefined;
}

interface Media {
  /** image and pdf are bills for the vision model; audio is a voice note to transcribe. */
  kind: 'image' | 'pdf' | 'audio';
  mime: string;
  size: number;
}

function mediaOf(content: proto.IMessage | undefined | null): Media | null {
  const size = (n: unknown) => Number(n ?? 0) || 0;
  const img = content?.imageMessage;
  if (img) return { kind: 'image', mime: img.mimetype ?? 'image/jpeg', size: size(img.fileLength) };
  const doc = content?.documentMessage;
  if (doc?.mimetype?.startsWith('image/')) return { kind: 'image', mime: doc.mimetype, size: size(doc.fileLength) };
  if (doc?.mimetype === 'application/pdf') return { kind: 'pdf', mime: doc.mimetype, size: size(doc.fileLength) };
  const audio = content?.audioMessage;
  if (audio) return { kind: 'audio', mime: audio.mimetype ?? 'audio/ogg', size: size(audio.fileLength) };
  return null;
}

async function download(s: WASocket, msg: WAMessage, media: Media) {
  const max = config.limits.maxMediaBytes;
  const tooBig = (bytes: number) => new UserError(`That file is ${(bytes / 1048576).toFixed(1)} MB; I can read up to ${Math.round(max / 1048576)} MB. Send a smaller photo or a screenshot of the total.`);
  // The declared size is checked before downloading: a huge "document" must never be pulled into memory.
  if (media.size > max) throw tooBig(media.size);
  let timer: NodeJS.Timeout | undefined;
  const data = await Promise.race([
    downloadMediaMessage(msg, 'buffer', {}, { logger: baileysLogger, reuploadRequest: s.updateMediaMessage }),
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new UserError('Downloading that attachment took too long — please send it again.')), 45_000))),
  ]).finally(() => clearTimeout(timer));
  if (data.length > max) throw tooBig(data.length);
  return { data, mime: media.mime.split(';')[0].trim() };
}

/** Rewrite "@9198…" / "@1234…(lid)" mention tokens to names so the model can reason about them. */
function withMentionNames(rawText: string, mentioned: string[]): string {
  let text = rawText;
  for (const m of mentioned) {
    const user = jidDecode(m)?.user;
    if (!user) continue;
    const name = isBot(m) ? '' : (() => {
      const c = store.findContactByUser(user);
      return '@' + (c?.splitwise_name ?? c?.push_name ?? user);
    })();
    text = text.replaceAll(`@${user}`, name);
  }
  text = text.replace(/\s+/g, ' ').trim();
  for (const t of config.bot.triggers) if (text.toLowerCase().startsWith(t)) text = text.slice(t.length).trim();
  return text;
}

async function onMessage(s: WASocket, msg: WAMessage) {
  const jid = msg.key.remoteJid;
  if (stopping || !jid || jid === 'status@broadcast' || msg.key.fromMe || !msg.message) return;
  const ts = Number(msg.messageTimestamp ?? 0) * 1000;
  if (ts && Date.now() - ts > MAX_AGE_MS) return;

  const content = normalizeMessageContent(msg.message);
  if (!content || content.reactionMessage) return;
  if (content.protocolMessage) {
    const p = content.protocolMessage;
    if (!isJidGroup(jid) || !p.key?.id) return;
    if (p.type === MESSAGE_EDIT && p.editedMessage) return onEdit(s, msg, jid, p.key.id, p.editedMessage);
    if ((p.type ?? REVOKE) === REVOKE) return onRevoke(s, msg, jid, p.key.id);
    return;
  }
  if (content.pollUpdateMessage) return onPollVote(s, msg, content.pollUpdateMessage);

  if (!isJidGroup(jid)) return onDirectMessage(s, msg, content);

  const senderIds = splitIds([msg.key.participant, (msg.key as any).participantAlt]);
  const sender = store.resolveContact({ ...senderIds, pushName: msg.pushName ?? null });
  const rawText = textOf(content).trim();
  const ctx = contextInfoOf(content);
  const mentioned = ctx?.mentionedJid ?? [];
  const text = withMentionNames(rawText, mentioned);

  // Short rolling chat history per group for context ("same split as before", "the cab Rahul took").
  const name = sender.push_name ?? sender.pn ?? 'someone';
  const hist = recentChat.get(jid) ?? [];
  if (text) {
    hist.push({ name, text, ts: ts || Date.now() });
    if (hist.length > 15) hist.shift();
    recentChat.set(jid, hist);
  }

  // ── Trigger? ──
  const quotedId = ctx?.stanzaId ?? null;
  // Replies to the bot's real answers (expenses, drafts, questions) skip the relevance filter. Replies to a roast
  // trigger the bot too, but only to escalate (sticker, then silence) unless they're actually about money.
  const quotesBot = !!(ctx?.participant && isBot(ctx.participant) && quotedId);
  const repliedToBot = quotesBot && !!store.getBotMessage(quotedId!);
  const repliedToRoast = quotesBot && roastIds.has(quotedId!);
  const lower = rawText.toLowerCase();
  const triggered =
    mentioned.some((m) => isBot(m)) ||
    config.bot.triggers.some((t) => lower.startsWith(t) || lower.includes(` ${t}`)) ||
    repliedToBot ||
    repliedToRoast;
  if (!triggered) return;

  const link = store.getGroupLink(jid);
  if (link && !link.enabled) return;

  await enqueue(jid, async () => {
    // A chat the owner hasn't approved gets nothing: no LLM, no Splitwise, no list of the owner's groups.
    if (!store.getGroupLink(jid)?.approved) {
      if (!(await isOwner(sender))) return onUnapproved(s, msg, jid);
      store.approveGroup(jid);
      log.info(`Group ${jid} approved by the owner tagging the bot there`);
    }
    await handleTrigger(s, msg, { jid, sender, text, content, ctx, quotedId, repliedToBot, repliedToRoast, history: hist.slice(0, -1) });
  }).catch((err) => log.error('Message handling failed', err));
}

const unapprovedNotice = new Map<string, number>();

async function onUnapproved(s: WASocket, msg: WAMessage, jid: string) {
  const last = unapprovedNotice.get(jid) ?? 0;
  if (Date.now() - last < 12 * 3600_000) return;
  unapprovedNotice.set(jid, Date.now());
  const subject = (await groupMeta(jid))?.subject ?? jid;
  store.upsertGroup(jid, subject);
  bus.emit('alert', { key: `new-group:${jid}`, text: `👥 Someone tagged Splitbot in "${subject}", which you haven't approved yet. Tag the bot there yourself or approve it on the dashboard's Groups tab.` });
  await s.sendMessage(jid, { text: "🔒 I'm not switched on for this chat yet — the person who runs me needs to approve it first." }, { quoted: msg }).catch(() => {});
}

/** What the group sees when a job blows up: the reason when it helps them, never provider internals. */
function publicError(err: unknown): string {
  const m = errMsg(err);
  if (err instanceof UserError) return m;
  if (/^LLM |No LLM configured|ran out of tokens|fetch failed|aborted|timeout/i.test(m)) return "The AI model didn't answer just now. Nothing was added — please send it again in a minute.";
  return `Couldn't process that: ${m.slice(0, 200)}`;
}

/** Run one job's work and deliver the outcome: reply (or roast), status, reactions, dashboard event. */
async function deliver(
  s: WASocket,
  o: { jid: string; jobId: number; replyTo: WAMessage; reactTo?: WAMessage; sender: store.Contact; text: string },
  work: () => Promise<AgentResult>,
) {
  const { jid, jobId } = o;
  s.sendPresenceUpdate('composing', jid).catch(() => {});
  try {
    const result = await work();
    if (result.offTopic) {
      // Same escalation as the free filter (roast → sticker → silence); not saved as a bot message, so replies to it are just chat.
      const denial = await denialFor(
        { reason: 'off-topic (model)', kind: 'offtopic', strike: offtopicStrike(o.sender.id) },
        { name: o.sender.push_name ?? 'aliya', text: o.text },
      );
      await sendDenial(s, jid, o.replyTo, denial);
      store.finishJob(jobId, { status: 'done', reply: denial?.text ?? (denial?.sticker ? '[sticker]' : '[ignored]'), trace: result.trace });
      if (o.reactTo) await react(s, o.reactTo, '');
    } else {
      // The reply text is stored first: if sending fails after Splitwise was written, the dashboard still shows what happened.
      store.finishJob(jobId, { status: 'done', reply: result.reply, trace: result.trace });
      await sendResult(s, jid, o.replyTo, jobId, result);
      if (o.reactTo) await react(s, o.reactTo, result.expenseIds.length ? '✅' : result.draftIds.length ? '📝' : '');
    }
  } catch (err) {
    log.error(`Job #${jobId} failed`, err);
    if (store.getJob(jobId)?.status === 'running') store.finishJob(jobId, { status: 'error', error: errMsg(err) });
    if (o.reactTo) await react(s, o.reactTo, '❌');
    await s.sendMessage(jid, { text: `⚠️ ${publicError(err)}` }, { quoted: o.replyTo }).catch(() => {});
  } finally {
    s.sendPresenceUpdate('paused', jid).catch(() => {});
    bus.emit('job', { id: jobId });
  }
}

async function handleTrigger(
  s: WASocket,
  msg: WAMessage,
  m: {
    jid: string;
    sender: store.Contact;
    text: string;
    content: proto.IMessage;
    ctx: proto.IContextInfo | undefined;
    quotedId: string | null;
    repliedToBot: boolean;
    repliedToRoast: boolean;
    history: { name: string; text: string; ts: number }[];
  },
) {
  const meta = await groupMeta(m.jid);
  if (meta) store.upsertGroup(m.jid, meta.subject);

  const quotedContent = m.ctx?.quotedMessage ? normalizeMessageContent(m.ctx.quotedMessage) : undefined;
  const quotedMsg: WAMessage | undefined = quotedContent
    ? { key: { remoteJid: m.jid, id: m.quotedId, participant: m.ctx?.participant }, message: quotedContent }
    : undefined;
  // The message's own attachment, plus the one it replies to ("@bot add this" under a bill or a voice note).
  const attachments = [
    { msg, media: mediaOf(m.content) },
    { msg: quotedMsg, media: m.repliedToBot ? null : mediaOf(quotedContent) },
  ].filter((a): a is { msg: WAMessage; media: Media } => !!a.msg && !!a.media);
  const hasMedia = attachments.length > 0;

  // Cheap gate before any LLM call: off-topic chatter, spam, muted people, rate limits.
  const rejection = checkMessage({
    sender: m.sender,
    groupJid: m.jid,
    text: m.text,
    hasImage: hasMedia,
    repliedToBot: m.repliedToBot,
    repliedToRoast: m.repliedToRoast,
  });
  if (rejection) {
    log.info(`Rejected ${m.sender.push_name ?? '?'} (${rejection.reason}): ${m.text.slice(0, 80)}`);
    store.rejectJob({
      msgId: msg.key.id ?? null,
      groupJid: m.jid,
      groupName: meta?.subject ?? null,
      senderContactId: m.sender.id,
      senderName: m.sender.push_name,
      text: m.text,
      reason: rejection.reason,
    });
    bus.emit('job', {});
    await sendDenial(s, m.jid, msg, await denialFor(rejection, { name: m.sender.push_name ?? 'aliya', text: m.text }));
    return;
  }

  const jobId = store.createJob({
    msgId: msg.key.id ?? null,
    groupJid: m.jid,
    groupName: meta?.subject ?? null,
    senderContactId: m.sender.id,
    senderName: m.sender.push_name,
    text: m.text || (attachments.some((a) => a.media.kind === 'audio') ? '(voice note)' : ''),
    hasImage: attachments.some((a) => a.media.kind !== 'audio'),
    dryRun: false,
  });
  if (jobId === null) return; // already handled (redelivery)
  bus.emit('job', { id: jobId });
  log.info(`Job #${jobId} from ${m.sender.push_name ?? '?'} in "${meta?.subject ?? m.jid}": ${m.text}`);

  await react(s, msg, '⏳');
  await deliver(s, { jid: m.jid, jobId, replyTo: msg, reactTo: msg, sender: m.sender, text: m.text }, async () => {
    const images: { data: Buffer; mime: string }[] = [];
    const heard: string[] = [];
    const preTrace: unknown[] = [];
    for (const a of attachments) {
      const file = await download(s, a.msg, a.media);
      if (a.media.kind !== 'audio') images.push(file);
      else {
        const t0 = Date.now();
        const said = await transcribe(file);
        preTrace.push({ step: 'transcribe', text: said, ms: Date.now() - t0 });
        if (!said) throw new UserError("I couldn't make out anything in that voice note. Try again, or type it.");
        heard.push(said);
      }
    }
    const transcript = heard.join(' ').trim() || undefined;

    const botMsg = m.quotedId ? store.getBotMessage(m.quotedId) : undefined;
    const quoted = quotedContent
      ? {
          text: textOf(quotedContent),
          fromBot: m.repliedToBot,
          expenseIds: botMsg?.expense_ids ?? [],
          draftIds: m.quotedId
            ? [...store.draftsForBotMessage(m.quotedId).map((d) => d.id), ...(store.getPoll(m.quotedId)?.draft_ids ?? [])]
            : [],
          jobId: botMsg?.job_id,
        }
      : undefined;

    const result = await handleMessage({
      jobId,
      groupJid: m.jid,
      groupName: meta?.subject ?? null,
      sender: m.sender,
      text: [m.text, transcript].filter(Boolean).join(' — '),
      images,
      quoted,
      recentChat: m.history,
      participants: participantContacts(meta),
      transcript,
    });
    result.trace.unshift(...preTrace);
    return result;
  });
}

/** What the bot recorded for a message, as the "quoted" context of a follow-up about it. */
function jobContext(job: store.Job): NonNullable<AgentInput['quoted']> {
  return {
    text: job.reply ?? '',
    fromBot: true,
    expenseIds: store.expensesByJob(job.id).map((e) => e.splitwise_expense_id),
    draftIds: store.draftsForJob(job.id).map((d) => d.id),
    jobId: job.id,
  };
}

/** Someone edited a message the bot already acted on ("2400" → "2600"): treat the new text as a correction. */
async function onEdit(s: WASocket, msg: WAMessage, jid: string, originalId: string, edited: proto.IMessage) {
  const job = store.jobByMsgId(originalId);
  if (!job || job.wa_group_jid !== jid || job.status !== 'done') return;
  const content = normalizeMessageContent(edited);
  const text = withMentionNames(textOf(content).trim(), contextInfoOf(content)?.mentionedJid ?? []);
  if (!text || text === job.text) return;
  const context = jobContext(job);
  // Nothing was recorded for the original (a question, a refusal): the edit is simply the message to act on.
  const nothingYet = !context.expenseIds.length && !context.draftIds.length;
  const sender = store.resolveContact({ ...splitIds([msg.key.participant, (msg.key as any).participantAlt]), pushName: msg.pushName ?? null });
  if (sender.id !== job.sender_contact_id || sender.muted) return;

  await enqueue(jid, async () => {
    const meta = await groupMeta(jid);
    const jobId = store.createJob({
      msgId: `edit:${msg.key.id}`,
      groupJid: jid,
      groupName: meta?.subject ?? null,
      senderContactId: sender.id,
      senderName: sender.push_name,
      text: `(edited) ${text}`,
      hasImage: false,
      dryRun: false,
    });
    if (jobId === null) return;
    bus.emit('job', { id: jobId });
    log.info(`Job #${jobId}: ${sender.push_name ?? '?'} edited the message behind job #${job.id}: ${text}`);
    const original: WAMessage = { key: { remoteJid: jid, id: originalId, participant: msg.key.participant }, message: { conversation: text } };
    await deliver(s, { jid, jobId, replyTo: original, sender, text }, () =>
      handleMessage({
        jobId,
        groupJid: jid,
        groupName: meta?.subject ?? null,
        sender,
        text: nothingYet ? text : `I edited my earlier message. It now says: "${text}". Correct what you recorded for it if anything changed; if nothing relevant changed, change nothing and say so in a few words.`,
        images: [],
        quoted: context,
        recentChat: recentChat.get(jid) ?? [],
        participants: participantContacts(meta),
      }),
    );
  }).catch((err) => log.error('Edit handling failed', err));
}

/** The message behind an expense was deleted: don't guess, offer a one-word undo. */
async function onRevoke(s: WASocket, msg: WAMessage, jid: string, originalId: string) {
  const job = store.jobByMsgId(originalId);
  if (!job || job.wa_group_jid !== jid) return;
  await enqueue(jid, async () => {
    for (const d of store.draftsForJob(job.id)) store.setDraftStatus(d.id, 'discarded');
    const live = store.expensesByJob(job.id);
    if (!live.length) return;
    const list = live.map((e) => `*${e.description}* · ${e.currency} ${e.cost} (#${e.splitwise_expense_id})`).join(', ');
    const sent = await s
      .sendMessage(jid, { text: `🗑️ ${msg.pushName ?? 'Someone'} deleted the message behind ${list}. It's still in Splitwise — reply *undo* to this message to remove it.` })
      .catch(() => undefined);
    if (sent?.key.id) store.saveBotMessage(sent.key.id, jid, job.id, live.map((e) => e.splitwise_expense_id));
  }).catch((err) => log.error('Delete handling failed', err));
}

/** Ids of roast/sticker messages the bot sent, so a reply to one counts as the next strike. */
const roastIds = new Set<string>();

async function sendDenial(s: WASocket, jid: string, quoted: WAMessage, denial: Denial | null) {
  for (const content of [denial?.sticker && { sticker: denial.sticker }, denial?.text && { text: denial.text }]) {
    if (!content) continue;
    const sent = await s.sendMessage(jid, content, { quoted }).catch(() => undefined);
    if (sent?.key.id) roastIds.add(sent.key.id);
  }
  if (roastIds.size > 500) roastIds.delete(roastIds.values().next().value!);
}

async function sendResult(s: WASocket, jid: string, quoted: WAMessage, jobId: number, result: AgentResult) {
  const sent = result.reply ? await s.sendMessage(jid, { text: result.reply }, { quoted }) : undefined;
  if (sent?.key.id) {
    store.saveBotMessage(sent.key.id, jid, jobId, result.expenseIds);
    store.attachDraftsToMessage(result.draftIds, sent.key.id);
  }
  if (result.poll) await sendPoll(s, jid, jobId, result.poll, result.draftIds);
}

async function sendPoll(s: WASocket, jid: string, jobId: number, poll: Poll, draftIds: number[]) {
  // We pick the secret ourselves and keep it: Baileys doesn't decrypt votes for us, and we need it after restarts.
  const secret = randomBytes(32);
  const sent = await s
    .sendMessage(jid, { poll: { name: poll.question, values: poll.options, selectableCount: 1, messageSecret: secret } })
    .catch((err) => log.warn('Sending poll failed', errMsg(err)));
  if (!sent?.key.id) {
    // Fall back to a plain question so it's still asked.
    await s.sendMessage(jid, { text: `❓ ${poll.question}\n${poll.options.map((o) => `• ${o}`).join('\n')}` }).catch(() => {});
    return;
  }
  store.savePoll({ wa_msg_id: sent.key.id, wa_group_jid: jid, job_id: jobId, question: poll.question, options: poll.options, draft_ids: draftIds, secret });
  // A reply to the poll counts as a reply to the bot too (its drafts stay attached to the receipt message for 👍).
  store.saveBotMessage(sent.key.id, jid, jobId, []);
}

/** A vote on one of our polls is handled like a reply with the chosen answer. The first vote decides. */
async function onPollVote(s: WASocket, msg: WAMessage, update: proto.Message.IPollUpdateMessage) {
  const pollKey = update.pollCreationMessageKey;
  const jid = msg.key.remoteJid;
  if (!pollKey?.id || !jid || !update.vote?.encPayload || !update.vote.encIv) return;
  const poll = store.getPoll(pollKey.id);
  if (!poll || poll.wa_group_jid !== jid) return;

  const option = decryptVote(s, msg, poll, update.vote);
  if (option === undefined) return log.warn(`Couldn't decrypt a vote on poll ${pollKey.id}`);
  if (option === null) return; // vote withdrawn

  const voter = store.resolveContact({ ...splitIds([msg.key.participant, (msg.key as any).participantAlt]), pushName: msg.pushName ?? null });
  if (voter.muted) return;
  const drafts = poll.draft_ids.map((id) => store.getDraft(id)).filter((d) => d?.status === 'pending');
  if ((poll.draft_ids.length && !drafts.length) || !store.markPollAnswered(pollKey.id)) {
    return log.info(`Ignoring ${voter.push_name ?? '?'}'s vote "${option}": poll already answered`);
  }

  const text = `${option} (answering your poll "${poll.question}")`;
  const jobId = store.createJob({
    msgId: `poll:${msg.key.id}`,
    groupJid: jid,
    groupName: groupCache.get(jid)?.meta.subject ?? null,
    senderContactId: voter.id,
    senderName: voter.push_name,
    text,
    hasImage: false,
    dryRun: false,
  });
  if (jobId === null) return;
  bus.emit('job', { id: jobId });
  log.info(`Job #${jobId}: ${voter.push_name ?? '?'} voted "${option}" on "${poll.question}"`);
  const pollMsg: WAMessage = { key: pollKey, message: { conversation: poll.question } };

  await enqueue(jid, () =>
    deliver(s, { jid, jobId, replyTo: pollMsg, sender: voter, text }, () =>
      handleMessage({
        jobId,
        groupJid: jid,
        groupName: groupCache.get(jid)?.meta.subject ?? null,
        sender: voter,
        text,
        images: [],
        quoted: {
          text: `${poll.question}\nOptions: ${poll.options.join(' / ')}`,
          fromBot: true,
          expenseIds: [],
          draftIds: drafts.map((d) => d!.id),
          jobId: poll.job_id ?? undefined,
        },
        recentChat: recentChat.get(jid) ?? [],
        participants: participantContacts(groupCache.get(jid)?.meta ?? null),
      }),
    ),
  ).catch((err) => log.error('Poll vote handling failed', err));
}

/** The chosen option, null for a withdrawn vote, undefined if no jid pairing decrypts it. */
function decryptVote(s: WASocket, msg: WAMessage, poll: store.PollRow, vote: proto.Message.IPollEncValue) {
  // Votes are keyed to the creator's and voter's jids, which may be phone-number or LID based.
  const creators = [s.user?.id, s.user?.lid].filter(Boolean).map((j) => jidNormalizedUser(j!));
  const voters = [msg.key.participant, (msg.key as any).participantAlt].filter(Boolean).map((j) => jidNormalizedUser(j));
  for (const pollCreatorJid of creators) {
    for (const voterJid of voters) {
      try {
        const res = decryptPollVote(vote as { encPayload: Uint8Array; encIv: Uint8Array }, {
          pollCreatorJid,
          pollMsgId: poll.wa_msg_id,
          pollEncKey: poll.secret,
          voterJid,
        });
        const picked = (res.selectedOptions ?? []).map((h) => Buffer.from(h).toString('hex'));
        if (!picked.length) return null;
        return poll.options.find((o) => picked.includes(createHash('sha256').update(o).digest('hex'))) ?? null;
      } catch {}
    }
  }
  return undefined;
}

/** 👍 / ✅ on a bot draft message confirms it. */
async function onReaction(s: WASocket, key: proto.IMessageKey, emoji: string, reactor: proto.IMessageKey) {
  const jid = key.remoteJid;
  if (stopping || !jid || !key.id || !/^(👍|✅|👌|☑️|✔️|💯)[🏻🏼🏽🏾🏿]?$/u.test(emoji)) return;
  const drafts = store.draftsForBotMessage(key.id).filter((d) => d.wa_group_jid === jid);
  if (!drafts.length) return;
  const ids = splitIds([reactor.participant, (reactor as any).participantAlt]);
  const who = store.resolveContact(ids);
  if (who.muted) return;
  const jobId = store.createJob({
    msgId: `reaction:${key.id}:${who.id}`,
    groupJid: jid,
    groupName: groupCache.get(jid)?.meta.subject ?? null,
    senderContactId: who.id,
    senderName: who.push_name,
    text: `${emoji} on draft`,
    hasImage: false,
    dryRun: false,
  });
  if (jobId === null) return;
  bus.emit('job', { id: jobId });
  log.info(`Job #${jobId}: ${who.push_name ?? '?'} confirmed draft(s) ${drafts.map((d) => d.id).join(', ')} with ${emoji}`);
  const draftMsg: WAMessage = { key, message: { conversation: '' } };
  await deliver(s, { jid, jobId, replyTo: draftMsg, sender: who, text: emoji }, () => confirmDrafts(jid, drafts.map((d) => d.id), jobId));
}

async function onDirectMessage(s: WASocket, msg: WAMessage, content: proto.IMessage) {
  const ids = splitIds([msg.key.remoteJid, (msg.key as any).remoteJidAlt]);
  if (!config.bot.ownerPhone || ids.pn !== config.bot.ownerPhone) return;
  const text = textOf(content).trim().toLowerCase();
  if (text === 'status' || text === 'ping') {
    const groups = store.listGroupLinks();
    const waiting = groups.filter((g) => !g.approved).length;
    await s.sendMessage(msg.key.remoteJid!, {
      text: `🟢 Splitbot up. Groups linked: ${groups.filter((g) => g.splitwise_group_id).length}${waiting ? ` · waiting for approval: ${waiting}` : ''}`,
    });
  }
}

async function react(s: WASocket, msg: WAMessage, emoji: string) {
  await s.sendMessage(msg.key.remoteJid!, { react: { text: emoji, key: msg.key } }).catch(() => {});
}

// ── Messages the bot starts itself ──────────────────────────────

export function isConnected() {
  return !!sock && status.state === 'open';
}

export async function sendText(jid: string, text: string) {
  if (!sock || status.state !== 'open') throw new Error('WhatsApp not connected');
  await sock.sendMessage(jid, { text });
}

/** A message people can reply to like any other bot reply ("undo", 👍 on its drafts). */
export async function sendBotMessage(jid: string, text: string, o: { jobId: number; expenseIds?: number[]; draftIds?: number[] }) {
  if (!sock || status.state !== 'open') throw new Error('WhatsApp not connected');
  const sent = await sock.sendMessage(jid, { text });
  if (sent?.key.id) {
    store.saveBotMessage(sent.key.id, jid, o.jobId, o.expenseIds ?? []);
    if (o.draftIds?.length) store.attachDraftsToMessage(o.draftIds, sent.key.id);
  }
}

/** DM the owner (alerts). False when there is no owner number or no connection. */
export async function sendToOwner(text: string): Promise<boolean> {
  if (!config.bot.ownerPhone || !sock || status.state !== 'open') return false;
  await sock.sendMessage(`${config.bot.ownerPhone}@s.whatsapp.net`, { text });
  return true;
}

/** After a crash or restart mid-message, say so: the sender can't tell whether their expense made it. */
async function notifyInterrupted() {
  const jobs = interrupted.filter((j) => j.wa_group_jid && isJidGroup(j.wa_group_jid) && !j.dry_run && Date.now() - j.created_at < 30 * 60_000);
  interrupted = [];
  for (const j of jobs) {
    const done = store.expensesByJob(j.id).map((e) => oneLine(JSON.parse(e.spec) as ExpenseSpec));
    const what = `${j.sender_name ?? 'someone'}'s message "${(j.text ?? '').slice(0, 80)}"`;
    await sendText(
      j.wa_group_jid!,
      done.length
        ? `⚠️ I restarted while handling ${what}. This did get added: ${done.join(', ')}. If something is missing, send it again.`
        : `⚠️ I restarted while handling ${what} and nothing was added. Please send it again.`,
    ).catch(() => {});
  }
}

export function knownParticipants(jid: string) {
  return participantContacts(groupCache.get(jid)?.meta ?? null);
}
