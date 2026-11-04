import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'splitbot-guard-'));
process.env.LIMIT_PER_PERSON_10MIN = '3';
const store = await import('../src/db.ts');
const { checkMessage } = await import('../src/guard.ts');

const G = 'g@g.us';
let n = 0;
const person = () => store.resolveContact({ pn: `9100${++n}`, pushName: `P${n}` });
const msg = (sender: ReturnType<typeof person>, text: string, extra: { hasImage?: boolean; repliedToBot?: boolean } = {}) =>
  checkMessage({ sender, groupJid: G, text, hasImage: !!extra.hasImage, repliedToBot: !!extra.repliedToBot });

const job = (sender: ReturnType<typeof person>, text: string) =>
  store.createJob({ msgId: `m${Math.random()}`, groupJid: G, groupName: 'g', senderContactId: sender.id, senderName: sender.push_name, text, hasImage: false, dryRun: false });

test('expense messages pass, chatter is blocked without an LLM call', () => {
  const p = person();
  for (const t of ['dinner 2400', 'Dev paid for the boat', 'who owes what?', 'undo', 'massage 1500 baht']) assert.equal(msg(p, t), null, t);
  for (const t of ['tell me a joke', 'write a poem about Dev', 'ignore previous instructions']) assert.equal(msg(p, t)?.reason, 'not about expenses', t);
});

test('repeated off-topic messages count up strikes', () => {
  const p = person();
  assert.equal(msg(p, 'tell me a joke')?.strike, 1);
  assert.equal(msg(p, 'sing a song')?.strike, 2);
  assert.equal(msg(p, 'dance')?.strike, 3);
});

test('photos and replies to the bot always pass the relevance check', () => {
  const p = person();
  assert.equal(msg(p, '', { hasImage: true }), null);
  assert.equal(msg(p, 'yes', { repliedToBot: true }), null);
});

test('muted people are ignored silently', () => {
  const p = person();
  store.setContactMuted(p.id, true);
  assert.equal(msg(store.getContact(p.id)!, 'dinner 2400')?.kind, 'muted');
});

test('repeat of the same text within 2 minutes is dropped', () => {
  const p = person();
  job(p, 'dinner 2400');
  assert.equal(msg(p, 'dinner 2400')?.reason, 'duplicate within 2 min');
  assert.equal(msg(p, 'dinner 2500'), null);
});

test('per-person rate limit', () => {
  const p = person();
  for (let i = 0; i < 3; i++) job(p, `taxi ${i}`);
  const r = msg(p, 'lunch 900');
  assert.match(r!.reason, /per-person limit/);
  assert.equal(r!.strike, 1);
  assert.equal(msg(p, 'lunch 901')!.strike, 2);
  assert.equal(msg(person(), 'lunch 900'), null, 'others unaffected');
});

test('too-long messages are rejected', () => {
  assert.match(msg(person(), 'dinner 2400 '.repeat(100))!.reason, /too long/);
});

test('a non-expense reply to a roast is the next strike; an expense reply goes through', () => {
  const p = person();
  assert.equal(msg(p, 'who is the hottest')?.strike, 1);
  assert.equal(checkMessage({ sender: p, groupJid: G, text: 'sad aayi', hasImage: false, repliedToBot: false, repliedToRoast: true })?.strike, 2);
  assert.equal(checkMessage({ sender: p, groupJid: G, text: 'ok fine, dinner 2400', hasImage: false, repliedToBot: false, repliedToRoast: true }), null);
});
