import fs from 'node:fs';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  jidDecode,
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
import { confirmDrafts, handleMessage, type AgentResult } from './agent.ts';
import { config } from './config.ts';
import * as store from './db.ts';
import { denialFor, type Denial } from './denial.ts';
import { checkMessage, offtopicStrike } from './guard.ts';
import { bus, errMsg, logger } from './log.ts';

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
    }
    if (u.connection === 'close') {
      const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log.warn('Logged out from WhatsApp — clearing session; scan a new QR to link again');
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
      const run = () => onReaction(s, r.key, r.reaction.text!, r.reaction.key ?? {});
      const next = (queues.get(jid) ?? Promise.resolve()).then(run);
      queues.set(jid, next.catch((err) => log.error('Reaction handling failed', err)));
    }
  });

  s.ev.on('groups.upsert', (groups) => {
    for (const g of groups) {
      groupCache.set(g.id, { at: Date.now(), meta: g });
      const known = store.getGroupLink(g.id);
      store.upsertGroup(g.id, g.subject);
      if (!known) {
        log.info(`Added to group "${g.subject}"`);
        sendText(
          g.id,
          `👋 Hi, I'm Splitbot. I log expenses to Splitwise.\n\nFirst, tell me which Splitwise group to use: tag me with e.g. _"use Goa Trip"_.\nThen tag me with expenses like _"dinner 2400"_ or send a bill photo with me tagged.`,
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

function imageOf(content: proto.IMessage | undefined | null): { kind: 'image' | 'document'; mime: string } | null {
  if (content?.imageMessage) return { kind: 'image', mime: content.imageMessage.mimetype ?? 'image/jpeg' };
  const doc = content?.documentMessage;
  if (doc?.mimetype?.startsWith('image/')) return { kind: 'document', mime: doc.mimetype };
  return null;
}

async function download(s: WASocket, msg: WAMessage, mime: string) {
  const data = await downloadMediaMessage(msg, 'buffer', {}, { logger: baileysLogger, reuploadRequest: s.updateMediaMessage });
  return { data, mime };
}

async function onMessage(s: WASocket, msg: WAMessage) {
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast' || msg.key.fromMe || !msg.message) return;
  const ts = Number(msg.messageTimestamp ?? 0) * 1000;
  if (ts && Date.now() - ts > MAX_AGE_MS) return;

  const content = normalizeMessageContent(msg.message);
  if (!content || content.protocolMessage || content.reactionMessage) return;

  if (!isJidGroup(jid)) return onDirectMessage(s, msg, content);

  const senderIds = splitIds([msg.key.participant, (msg.key as any).participantAlt]);
  const sender = store.resolveContact({ ...senderIds, pushName: msg.pushName ?? null });
  const rawText = textOf(content).trim();
  const ctx = contextInfoOf(content);
  const mentioned = ctx?.mentionedJid ?? [];

  // Rewrite "@9198…" / "@1234…(lid)" mention tokens to names so the model can reason about them.
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

  for (const t of config.bot.triggers) if (text.toLowerCase().startsWith(t)) text = text.slice(t.length).trim();

  const prev = queues.get(jid) ?? Promise.resolve();
  const next = prev.then(() => handleTrigger(s, msg, { jid, sender, text, content, ctx, quotedId, repliedToBot, repliedToRoast, history: hist.slice(0, -1) }));
  queues.set(jid, next.catch(() => {}));
  await next;
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

  const ownImg = imageOf(m.content);
  const quotedContent = m.ctx?.quotedMessage ? normalizeMessageContent(m.ctx.quotedMessage) : undefined;
  const quotedImg = imageOf(quotedContent);

  // Cheap gate before any LLM call: off-topic chatter, spam, muted people, rate limits.
  const rejection = checkMessage({
    sender: m.sender,
    groupJid: m.jid,
    text: m.text,
    hasImage: !!(ownImg || quotedImg),
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
    text: m.text,
    hasImage: !!(ownImg || quotedImg),
    dryRun: false,
  });
  if (jobId === null) return; // already handled (redelivery)
  bus.emit('job', { id: jobId });
  log.info(`Job #${jobId} from ${m.sender.push_name ?? '?'} in "${meta?.subject ?? m.jid}": ${m.text}`);

  await react(s, msg, '⏳');
  try {
    const images: { data: Buffer; mime: string }[] = [];
    if (ownImg) images.push(await download(s, msg, ownImg.mime));
    else if (quotedImg && quotedContent) {
      const fake: WAMessage = { key: { remoteJid: m.jid, id: m.quotedId, participant: m.ctx?.participant }, message: quotedContent };
      images.push(await download(s, fake, quotedImg.mime));
    }

    const botMsg = m.quotedId ? store.getBotMessage(m.quotedId) : undefined;
    const quoted = quotedContent
      ? {
          text: textOf(quotedContent),
          fromBot: m.repliedToBot,
          expenseIds: botMsg?.expense_ids ?? [],
          draftIds: m.quotedId ? store.draftsForBotMessage(m.quotedId).map((d) => d.id) : [],
        }
      : undefined;

    const result = await handleMessage({
      jobId,
      groupJid: m.jid,
      groupName: meta?.subject ?? null,
      sender: m.sender,
      text: m.text,
      images,
      quoted,
      recentChat: m.history,
      participants: participantContacts(meta),
    });

    if (result.offTopic) {
      // Same escalation as the free filter (roast → sticker → silence); not saved as a bot message, so replies to it are just chat.
      const denial = await denialFor(
        { reason: 'off-topic (model)', kind: 'offtopic', strike: offtopicStrike(m.sender.id) },
        { name: m.sender.push_name ?? 'aliya', text: m.text },
      );
      await sendDenial(s, m.jid, msg, denial);
      store.finishJob(jobId, { status: 'done', reply: denial?.text ?? (denial?.sticker ? '[sticker]' : '[ignored]'), trace: result.trace });
      await react(s, msg, '');
    } else {
      await sendResult(s, m.jid, msg, jobId, result);
      store.finishJob(jobId, { status: 'done', reply: result.reply, trace: result.trace });
      await react(s, msg, result.expenseIds.length ? '✅' : result.draftIds.length ? '📝' : '');
    }
  } catch (err) {
    log.error(`Job #${jobId} failed`, err);
    store.finishJob(jobId, { status: 'error', error: errMsg(err) });
    await react(s, msg, '❌');
    await s.sendMessage(m.jid, { text: `⚠️ Couldn't process that: ${errMsg(err).slice(0, 200)}` }, { quoted: msg }).catch(() => {});
  }
  bus.emit('job', { id: jobId });
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
  const sent = await s.sendMessage(jid, { text: result.reply }, { quoted });
  if (sent?.key.id) {
    store.saveBotMessage(sent.key.id, jid, jobId, result.expenseIds);
    store.attachDraftsToMessage(result.draftIds, sent.key.id);
  }
}

/** 👍 / ✅ on a bot draft message confirms it. */
async function onReaction(s: WASocket, key: proto.IMessageKey, emoji: string, reactor: proto.IMessageKey) {
  const jid = key.remoteJid;
  if (!jid || !key.id || !/^(👍|✅|👌|☑️|✔️|💯)[🏻🏼🏽🏾🏿]?$/u.test(emoji)) return;
  const drafts = store.draftsForBotMessage(key.id);
  if (!drafts.length) return;
  const ids = splitIds([reactor.participant, (reactor as any).participantAlt]);
  const who = store.resolveContact(ids);
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
  try {
    const result = await confirmDrafts(jid, drafts.map((d) => d.id), jobId);
    await sendResult(s, jid, draftMsg, jobId, result);
    store.finishJob(jobId, { status: 'done', reply: result.reply, trace: result.trace });
  } catch (err) {
    log.error(`Job #${jobId} failed`, err);
    store.finishJob(jobId, { status: 'error', error: errMsg(err) });
    await s.sendMessage(jid, { text: `⚠️ Couldn't add that: ${errMsg(err).slice(0, 200)}` }).catch(() => {});
  }
  bus.emit('job', { id: jobId });
}

async function onDirectMessage(s: WASocket, msg: WAMessage, content: proto.IMessage) {
  const ids = splitIds([msg.key.remoteJid, (msg.key as any).remoteJidAlt]);
  if (!config.bot.ownerPhone || ids.pn !== config.bot.ownerPhone) return;
  const text = textOf(content).trim().toLowerCase();
  if (text === 'status' || text === 'ping') {
    await s.sendMessage(msg.key.remoteJid!, { text: `🟢 Splitbot up. Groups linked: ${store.listGroupLinks().filter((g) => g.splitwise_group_id).length}` });
  }
}

async function react(s: WASocket, msg: WAMessage, emoji: string) {
  await s.sendMessage(msg.key.remoteJid!, { react: { text: emoji, key: msg.key } }).catch(() => {});
}

export async function sendText(jid: string, text: string) {
  if (!sock || status.state !== 'open') throw new Error('WhatsApp not connected');
  await sock.sendMessage(jid, { text });
}

export function knownParticipants(jid: string) {
  return participantContacts(groupCache.get(jid)?.meta ?? null);
}
