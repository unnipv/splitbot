import { config } from './config.ts';
import './db.ts';
import { logger } from './log.ts';
import * as sw from './splitwise.ts';
import { startWeb } from './web/server.ts';
import { startWhatsApp } from './whatsapp.ts';

const log = logger('main');

log.info(`Splitbot starting — data in ${config.dataDir}`);
log.info(`Agent models: ${config.llm.agent.map((m) => m.id).join(' → ') || 'none'}`);
log.info(`Vision models: ${config.llm.vision.map((m) => m.id).join(' → ') || 'none'}`);
if (config.bot.denialStyle === 'manglish') log.info(`Roast models: ${config.llm.roast.map((m) => m.id).join(' → ')}`);
if (!config.llm.agent.length) log.warn('No LLM API key set (OPENROUTER_API_KEY / GROQ_API_KEY) — the bot will fail to process messages');

if (sw.isConnected()) {
  sw.currentUser()
    .then((u) => log.info(`Splitwise: connected as ${sw.swName(u)} (${u.id})`))
    .catch((err) => log.error('Splitwise token check failed', err));
} else {
  log.warn('Splitwise not connected — use the dashboard to connect');
}

startWeb();
startWhatsApp().catch((err) => log.error('WhatsApp failed to start', err));

process.on('unhandledRejection', (err) => log.error('Unhandled rejection', err));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`${sig} received, exiting`);
    process.exit(0);
  });
}
