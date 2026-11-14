# 💸 Splitbot

A WhatsApp group member that logs shared expenses to Splitwise. Add a spare WhatsApp number to a trip group, tag it, and it creates the expense with the right split:

> **@Splitbot** dinner 2400, split with everyone except Rahul
>
> **@Splitbot** *(photo of a bill)* Priya paid
>
> **@Splitbot** cab 850 me and Arjun, taxi 300 everyone
>
> *(replying to the bot)* make it 2600 · undo · Rahul wasn't there
>
> **@Splitbot** I paid Rahul 500 back
>
> *(voice note, as a reply to the bot)* "cab to the airport, eight fifty, me and Arjun"
>
> **@Splitbot** who owes what? · summary · remember Dev doesn't drink · help

Every reply shows the exact split that goes to Splitwise:

```
🧾 *Thai dinner at Krua Thai Seafood*
💰 *THB 2,330.46* · Dining out
💳 Paid by *Arjun*

👥 Split equally + extras · 4 people
• Arjun — THB 617.93 (incl. THB 141.24 for own items + tax)
• Kiran — THB 617.93 (…)
• Vivek — THB 617.93 (…)
• Dev — THB 476.69
ℹ️ Assumed: you paid; currency THB from bill
✅ Added to Splitwise · #4123987
```

When the bot has to make a judgment call (a nickname it's not sure about, "those who came", a blurry total), it posts a **📝 draft** and asks. Reply *yes* or react 👍 to push it, or reply with a correction. When essential info is missing, it just asks.

Runs on a Raspberry Pi, with a small web dashboard for linking WhatsApp, mapping people, and seeing exactly what the bot did.

## How it works

```
WhatsApp group ──(Baileys, WhatsApp Web protocol)──▶ trigger? (@mention / reply to bot / "splitbot …")
                                                         │
                         bill photo? ──▶ vision/OCR model ─┤  (structured: merchant, total, currency, items)
                                                         ▼
                              agent model (tool calling) + context: Splitwise members, who's who,
                              recent chat, recent expenses, the message being replied to
                                                         │
               create / update / delete expense · balances · link member · link group
                                                         ▼
                        split math in code (exact to the paisa) ──▶ Splitwise API ──▶ reply in group
```

- **WhatsApp**: [Baileys](https://github.com/WhiskeySockets/Baileys) talks the WhatsApp Web protocol over a websocket. No headless Chrome, so it's light enough for a Pi. It links as a "linked device" on the bot's number, so that phone just needs to stay registered.
- **LLMs**: `AGENT_MODELS` and `VISION_MODELS` are ordered `provider:model` lists (OpenRouter, Groq, Gemini, DeepSeek, Cerebras). Each model falls back to the next when it hits a quota, has an outage, or returns an empty reply. With an OpenRouter key, the default is DeepSeek V4.1 Flash, then Qwen3.8 Max, then Groq's free gpt-oss-120b. These were chosen with `npm run eval`. Photos go through the vision chain first and come back as structured bill data.
- **Splits**: the model only decides *who* paid and *how* to split (equal / exact / percent / shares / "adjustment" for someone's extra drink). The amounts are computed in code in minor units, so they always add up.
- **People**: WhatsApp senders are linked to Splitwise members. The bot links people itself when names clearly match, and you can fix links in the dashboard.
- **Confirmations**: `CONFIRM_MODE=always` makes every expense a 📝 draft until someone reacts 👍/✅ or replies "yes" (also "ok", "sheri", "athe"…). `auto` pushes clear expenses right away and drafts only uncertain ones; `never` never waits.
- **Questions and polls**: when the bot needs a pick between a few choices ("Is Devu = Dev Nair?", "use the bill total or yours?") it sends a WhatsApp poll; the first vote answers it. Open questions are plain messages — reply to them. If a split doesn't add up (items more than the bill, say), the bot says what's off with the numbers, proposes a fix, and redoes it from your reply; the bill it already read is kept for the follow-up.
- **Bot tag**: expenses the bot adds are titled `[bot] Dinner` and their notes say *Added by Splitbot via WhatsApp · requested by Dev*, so they're easy to tell apart from ones added by hand. Change or clear the tag with `EXPENSE_TAG`.
- **Abuse guards** (`src/guard.ts`): before any LLM call, messages are dropped if they're off-topic (no number, photo, reply to the bot, or money word), too long, a repeat, from a muted person (mute them on the dashboard's Members table), or over the per-person/per-group rate limits. Rejections cost no tokens and appear on the Activity tab. With `DENIAL_STYLE=manglish`, the first off-topic message from a person gets a short AI-written Manglish roast, the second the "last warning ok" sticker (`assets/stickers/`), then silence. Past `DAILY_BUDGET_USD`, only free Groq models are used.
- **Safety**: duplicate deliveries are ignored (message id dedupe), each group is processed in order, bill photos are attached to the Splitwise expense as receipts, and every reply carries the expense id so "undo" works.
- **Who may do what**: a chat the bot is added to does nothing until the owner approves it — by tagging the bot there (needs `OWNER_PHONE`) or on the dashboard. Only the owner can pick or switch a chat's Splitwise group. The bot can only change or delete expenses of the chat's own Splitwise group, and it never re-links a person who is already linked (fix links on the dashboard).
- **Checks in code**: whatever the model thinks, an expense becomes a 📝 draft with a ⚠️ line when it looks like one already added (same bill photo, or same amount, day and payer — including ones added by hand in Splitwise), is dated in the future or over two months back, is over 5× the chat's biggest expense, or when two vision models read different totals off the bill (`VISION_CROSSCHECK`). After every write the shares Splitwise stored are compared with the computed ones. An expense edited in the Splitwise app is never overwritten from the bot's old copy.
- **No model needed**: *yes* / *no* / 👍 on a draft, *undo* on a receipt, *help*, *balances* and *summary* are answered by code — instant and free.
- **Memory**: a nickname the group confirmed once ("Devu" = Dev Nair) is remembered per chat. *"remember …"* saves a standing instruction for the chat. Both are editable on the dashboard, with per-chat currency, confirm mode and a nightly digest.
- **Settle up**: *"I paid Rahul 500"* is recorded as a Splitwise payment, not an expense.
- **Voice, PDFs, edits**: a voice note sent as a reply to the bot (or tagged in a reply to one) is transcribed with Whisper on Groq and the bot shows what it heard. PDF bills are read through OpenRouter. Editing a message the bot already acted on corrects the expense; deleting it gets an offer to undo.
- **Nothing lost quietly**: drafts nobody answered get one reminder (`NUDGE_AFTER_HOURS`); on shutdown the bot finishes the messages in progress, and after a crash it tells the chat which message was cut off. Splitwise calls time out instead of hanging. The owner is alerted by DM (and `ALERT_WEBHOOK`, e.g. an ntfy.sh topic) when Splitwise rejects the token, WhatsApp logs out, or a new chat wants approval.

## Setup

1. **Keys.** Put these in `.env` (see `.env.example`):
   - `SPLITWISE_CONSUMER_KEY` / `SECRET`: register an app at https://secure.splitwise.com/apps and set its callback URL to `SPLITWISE_REDIRECT_URI`. Then click **Connect Splitwise** on the dashboard. The OAuth token is stored in `data/splitwise-token.json`.
   - `OPENROUTER_API_KEY` (recommended): the default models are DeepSeek V4.1 Flash with reasoning off, then Qwen3.8 Max. At about 20 messages a day that's cents per week.
   - `GROQ_API_KEY` (optional, free): fallback models. Groq's free tier is about 200k tokens/day per model, enough for ~30 messages a day on its own.
   - `DASHBOARD_PASSWORD`: change it from `change-me`. Until you do, the dashboard only listens on 127.0.0.1.
   - `OWNER_PHONE`: your own WhatsApp number. Lets you approve and link chats from WhatsApp and receive alerts.
   - Optional: `CONFIRM_MODE`, `DENIAL_STYLE`, the rate limits and `DAILY_BUDGET_USD` (see `.env.example`).
2. **Try it locally:** `npm install && npm start`, then open http://localhost:3000 and go to **Playground**. Send a message once, then link "Playground" to a Splitwise group on **Groups**, and test with dry run on (bill photos work too).
3. **Deploy to the Pi** (Raspberry Pi OS 64-bit):
   ```bash
   ./deploy/deploy.sh pi@raspberrypi.local
   ```
   This syncs the code and installs Node 24 and a `splitbot` systemd service. It copies `.env` and the Splitwise token on the first deploy only.
4. **Link WhatsApp:** open `http://<pi-ip>:3000`. On the bot phone, go to WhatsApp → Linked devices → Link a device and scan the QR code. You can also use "Get pairing code".
5. **Add the bot number to the trip group.** It says hi and waits. Tag it yourself with *"use <Splitwise group name>"* (that approves the chat and links it), or approve and link it on the dashboard's Groups tab.

### Watching it from the road

The install script puts the dashboard on your tailnet with **Tailscale Serve**, at `https://<pi>.<tailnet>.ts.net`. That address only works from your own Tailscale devices; it is not Funnel. The first run prints a link to enable Serve for the tailnet. Until you do, `http://<pi-tailscale-ip>:3000` works over the tailnet. Don't port-forward the dashboard to the internet.

## Operations

- Logs: `journalctl -u splitbot -f`, or the dashboard's **Logs** tab
- Restart: `sudo systemctl restart splitbot`
- State lives in `data/`: SQLite db, WhatsApp session (`wa-auth/`), Splitwise token. Keep it private. A copy of the database is written to `data/backups/` every night (7 kept); copy that folder off the Pi if you want an off-device backup.
- Dashboard tabs: **Home** (what needs attention, response times, spend), **Groups** (approve, link, per-chat settings, people, nicknames), **Expenses** (pending drafts, everything the bot added, delete), **Activity** (every message with a timed trace, replay as a dry run, mark as wrong → `GET /api/eval-cases`), **Playground**, **Settings** (modes, limits and model lists, applied live), **Logs**.
- `GET /healthz` (no login) returns 200 only while WhatsApp and Splitwise are both connected, for an uptime checker.
- Changes to the dashboard are refused from other sites, and ten wrong passwords lock that address out for 15 minutes.
- `./deploy/install-pi.sh` installs a sandboxed systemd unit (writes only to `data/`). If your Pi was set up before this, run it once more on the Pi. `./deploy/harden-pi.sh` (watchdog, Wi-Fi recovery) is optional and run by hand.
- If WhatsApp logs the device out, the session is wiped and a new QR code appears on the dashboard.
- The Splitwise OAuth "Connect" button only works if `SPLITWISE_REDIRECT_URI` matches the callback URL registered on your Splitwise app. Once connected, the token in `data/` keeps working, so you can also connect on one machine and copy the file over.

## Dev

```bash
npm start          # node runs the TypeScript directly (type stripping, Node ≥ 22.18)
npm run dev        # restart on change
npm test           # split math, guards, and the agent end to end against a fake model and a fake Splitwise
npm run eval -- --group <splitwise_group_id> --me <your_user_id> --bill test/fixtures/thai-bill.png \
  --models openai/gpt-oss-120b:high,qwen/qwen3.8-27b   # accuracy eval against real models (dry run)
npm run typecheck
```

Layout: `src/whatsapp.ts` (connection, triggers, media), `src/agent.ts` (prompt + tools), `src/vision.ts` (bill OCR), `src/split.ts` (share math), `src/splitwise.ts` (API), `src/db.ts` (SQLite via `node:sqlite`), `src/settings.ts` (live settings), `src/cron.ts` (reminders, digest, backup), `src/alerts.ts`, `src/web/server.ts` + `public/` (dashboard).

> Note: Baileys is an unofficial WhatsApp client. Using it on a spare number for a personal bot is common, but WhatsApp can ban numbers that act like spam bots. The bot only speaks when tagged.

## License

MIT — see [LICENSE](LICENSE).
