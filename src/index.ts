import { startAlerts } from './alerts.ts';
import { config } from './config.ts';
import { startCron } from './cron.ts';
import * as store from './db.ts';
import { logger } from './log.ts';
import { loadSettings } from './settings.ts';
import * as sw from './splitwise.ts';
import { startWeb } from './web/server.ts';
import { setInterrupted, shutdown, startWhatsApp } from './whatsapp.ts';

const log = logger('main');

loadSettings(); // dashboard overrides on top of .env
log.info(`Splitbot starting — data in ${config.dataDir}`);
log.info(`Agent models: ${config.llm.agent.map((m) => m.id).join(' → ') || 'none'}`);
log.info(`Vision models: ${config.llm.vision.map((m) => m.id).join(' → ') || 'none'}${config.llm.visionCrosscheck ? ' (first two cross-checked)' : ''}`);
if (config.bot.denialStyle === 'manglish') log.info(`Roast models: ${config.llm.roast.map((m) => m.id).join(' → ')}`);
if (!config.llm.agent.length) log.warn('No LLM API key set (OPENROUTER_API_KEY / GROQ_API_KEY) — the bot will fail to process messages');
if (!config.bot.ownerPhone) log.warn('OWNER_PHONE is not set — new chats can only be approved and linked on the dashboard, and alerts have nowhere to go');

// Jobs that were mid-flight when the last process died would otherwise show as "running" forever.
const cutOff = store.interruptRunningJobs();
if (cutOff.length) log.warn(`${cutOff.length} message(s) were interrupted by the last restart`);
setInterrupted(cutOff);

if (sw.isConnected()) {
  sw.currentUser()
    .then((u) => log.info(`Splitwise: connected as ${sw.swName(u)} (${u.id})`))
    .catch((err) => log.error('Splitwise token check failed', err));
} else {
  log.warn('Splitwise not connected — use the dashboard to connect');
}

startAlerts();
startWeb();
startCron();
startWhatsApp().catch((err) => log.error('WhatsApp failed to start', err));

process.on('unhandledRejection', (err) => log.error('Unhandled rejection', err));
let exiting = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (exiting) process.exit(1); // second signal: stop waiting
    exiting = true;
    log.info(`${sig} received — finishing messages in progress, then exiting`);
    shutdown().finally(() => process.exit(0));
  });
}
