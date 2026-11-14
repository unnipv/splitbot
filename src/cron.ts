import fs from 'node:fs';
import path from 'node:path';
import { groupSummary } from './agent.ts';
import { config } from './config.ts';
import * as store from './db.ts';
import { oneLine, today } from './format.ts';
import { errMsg, logger } from './log.ts';
import type { ExpenseSpec } from './split.ts';
import * as wa from './whatsapp.ts';

const log = logger('cron');
const HOUR = 3600_000;

function localHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.bot.timezone, hour: '2-digit', hour12: false }).format(new Date())) % 24;
}

/**
 * A draft nobody answered is an expense that silently never reaches Splitwise. Each one gets a single reminder
 * (daytime only); reacting 👍 to the reminder, or replying yes, confirms the drafts it lists.
 */
async function nudgeDrafts() {
  const after = config.bot.nudgeAfterHours;
  const hour = localHour();
  if (!after || hour < 9 || hour >= 22 || !wa.isConnected()) return;
  const byGroup = new Map<string, store.Draft[]>();
  for (const d of store.draftsToNudge(after * HOUR)) byGroup.set(d.wa_group_jid, [...(byGroup.get(d.wa_group_jid) ?? []), d]);
  for (const [jid, drafts] of byGroup) {
    const link = store.getGroupLink(jid);
    if (!jid.endsWith('@g.us') || !link?.approved || !link.enabled) continue;
    const lines = drafts.map((d) => `• D${d.id} · ${oneLine(JSON.parse(d.spec) as ExpenseSpec)}`);
    const text = `📝 Still waiting for a yes — not in Splitwise yet:\n${lines.join('\n')}\n\n👉 React 👍 or reply *yes* to add ${drafts.length === 1 ? 'it' : 'them all'} · reply *no* to drop ${drafts.length === 1 ? 'it' : 'them'}`;
    try {
      // Mark first: a reminder that half-failed must not repeat every ten minutes.
      store.markNudged(drafts.map((d) => d.id));
      await wa.sendBotMessage(jid, text, { jobId: drafts[0].job_id ?? 0, draftIds: drafts.map((d) => d.id) });
      log.info(`Reminded "${link.wa_group_name ?? jid}" about ${drafts.length} draft(s)`);
    } catch (err) {
      log.warn('Draft reminder failed', errMsg(err));
    }
  }
}

/** Groups that turned the digest on get one message in the evening, on days something was logged. */
async function sendDigests() {
  if (localHour() !== config.bot.digestHour || !wa.isConnected()) return;
  const day = today();
  for (const g of store.listGroupLinks()) {
    if (!g.digest || !g.approved || !g.enabled || !g.splitwise_group_id || g.last_digest === day) continue;
    store.setGroupSettings(g.wa_group_jid, { last_digest: day });
    if (!store.listExpenses({ group: g.wa_group_jid, since: store.startOfDay(), limit: 1 }).length) continue;
    try {
      await wa.sendText(g.wa_group_jid, await groupSummary(g.wa_group_jid, '🌙 *Today*', store.startOfDay()));
    } catch (err) {
      log.warn(`Digest for ${g.wa_group_name ?? g.wa_group_jid} failed`, errMsg(err));
    }
  }
}

/** Once a night: a consistent copy of the database (7 kept), old traces and bookkeeping pruned, stale receipt photos removed. */
function maintain() {
  const day = today();
  if (localHour() !== 3 || store.getSetting('lastMaintenance') === day) return;
  store.setSetting('lastMaintenance', day);
  try {
    const dir = path.join(config.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    store.backupTo(path.join(dir, `splitbot-${day}.db`));
    const old = fs.readdirSync(dir).filter((f) => /^splitbot-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -7);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    store.prune();
    const receipts = path.join(config.dataDir, 'receipts');
    if (fs.existsSync(receipts)) {
      for (const f of fs.readdirSync(receipts)) {
        const file = path.join(receipts, f);
        if (Date.now() - fs.statSync(file).mtimeMs > store.DRAFT_TTL_MS + 24 * HOUR) fs.rmSync(file, { force: true });
      }
    }
    log.info(`Nightly maintenance done (backup splitbot-${day}.db)`);
  } catch (err) {
    log.error('Nightly maintenance failed', err);
  }
}

export function startCron() {
  const tick = () => {
    maintain();
    nudgeDrafts().catch((err) => log.warn('Nudge tick failed', errMsg(err)));
    sendDigests().catch((err) => log.warn('Digest tick failed', errMsg(err)));
  };
  setInterval(tick, 10 * 60_000).unref();
  setTimeout(tick, 60_000).unref();
}
