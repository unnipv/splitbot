import { config } from './config.ts';
import * as store from './db.ts';

/**
 * Cheap checks that run before any LLM call, so chatter, spam and jokes cost nothing.
 * Returns null to let the message through, or why it was stopped. What to say back is up to denial.ts.
 */
export interface Rejection {
  reason: string;
  kind: 'muted' | 'long' | 'duplicate' | 'offtopic' | 'limit';
  /** How many times this person was stopped for this kind within its window (1 = first time). */
  strike: number;
}

// Anything plausibly about money in the group. Kept generous: false negatives just cost one cheap LLM call.
const RELEVANT =
  /\d|₹|\$|€|£|฿|¥|\b(paid|pay|pays|paying|owe[sd]?|owing|split|share|expense|bill|cost|spent|spend|total|amount|balance|settle|who owes|undo|delete|remove|cancel|wrong|fix|change|update|correct|use|link|equally|everyone|except|without|half|each|rupees?|rs|inr|baht|thb|usd|eur|dollars?|euros?|added|draft)\b/i;

const strikes = new Map<string, { count: number; since: number }>();

function strike(key: string, windowMs: number): number {
  const cur = strikes.get(key);
  if (!cur || Date.now() - cur.since > windowMs) {
    strikes.set(key, { count: 1, since: Date.now() });
    return 1;
  }
  return ++cur.count;
}

/** Count an off-topic message the LLM caught (shares the counter with the free filter). */
export function offtopicStrike(senderId: number): number {
  return strike(`off:${senderId}`, 10 * 60_000);
}

export function checkMessage(m: {
  sender: store.Contact;
  groupJid: string;
  text: string;
  hasImage: boolean;
  /** Replying to a bot message that recorded something or asked a question. */
  repliedToBot: boolean;
  /** Replying to one of the bot's roasts or stickers. */
  repliedToRoast?: boolean;
}): Rejection | null {
  const { sender, groupJid, text } = m;
  const lim = config.limits;
  const TEN_MIN = 10 * 60_000;
  const DAY = 24 * 3600_000;

  if (sender.muted) return { reason: 'muted', kind: 'muted', strike: 1 };

  if (text.length > lim.maxChars) {
    return { reason: `too long (${text.length} chars)`, kind: 'long', strike: strike(`long:${sender.id}`, TEN_MIN) };
  }

  // Same text from the same person within 2 minutes: double send or spam.
  const prev = store.lastJobFrom(sender.id);
  if (prev && prev.text === text && !m.hasImage && Date.now() - prev.created_at < 2 * 60_000 && prev.status !== 'rejected') {
    return { reason: 'duplicate within 2 min', kind: 'duplicate', strike: 1 };
  }

  // A short "yes"/"sheri" while a draft is waiting may be a confirmation even without replying to it.
  const maybeConfirming = !m.repliedToRoast && text.length <= 40 && store.pendingDrafts(groupJid).length > 0;
  if (!m.hasImage && !m.repliedToBot && !maybeConfirming && !RELEVANT.test(text)) {
    return { reason: 'not about expenses', kind: 'offtopic', strike: strike(`off:${sender.id}`, TEN_MIN) };
  }

  if (store.countJobs({ senderContactId: sender.id }, Date.now() - TEN_MIN) >= lim.perPerson10Min) {
    return { reason: `per-person limit (${lim.perPerson10Min}/10 min)`, kind: 'limit', strike: strike(`10m:${sender.id}`, TEN_MIN) };
  }
  const today = store.startOfDay();
  if (store.countJobs({ senderContactId: sender.id }, today) >= lim.perPersonDay) {
    return { reason: `per-person limit (${lim.perPersonDay}/day)`, kind: 'limit', strike: strike(`day:${sender.id}`, DAY) };
  }
  if (store.countJobs({ groupJid }, today) >= lim.perGroupDay) {
    return { reason: `group limit (${lim.perGroupDay}/day)`, kind: 'limit', strike: strike(`gday:${groupJid}`, DAY) };
  }
  return null;
}
