import { config } from './config.ts';
import { bus, errMsg, logger } from './log.ts';
import { sendToOwner } from './whatsapp.ts';

const log = logger('alerts');
const lastSent = new Map<string, number>();
const HOUR = 3600_000;

/**
 * Things only the owner can fix (Splitwise token rejected, WhatsApp logged out, a new chat waiting for approval).
 * Any module raises one with `bus.emit('alert', { key, text })`; the same key is sent at most once an hour.
 * Delivery: a WhatsApp DM to OWNER_PHONE when connected, and ALERT_WEBHOOK (e.g. an ntfy.sh topic) when set,
 * which also works when WhatsApp itself is what broke.
 */
export function startAlerts() {
  bus.on('alert', (a: { key: string; text: string }) => {
    if (Date.now() - (lastSent.get(a.key) ?? 0) < HOUR) return;
    lastSent.set(a.key, Date.now());
    log.warn(a.text);
    sendToOwner(a.text).catch((err) => log.warn('Owner DM failed', errMsg(err)));
    const url = config.bot.alertWebhook;
    if (url) {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: 'Splitbot' }, body: a.text, signal: AbortSignal.timeout(10_000) }).catch(
        (err) => log.warn('Alert webhook failed', errMsg(err)),
      );
    }
  });
}
