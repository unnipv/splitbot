import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const Env = z.object({
  SPLITWISE_CONSUMER_KEY: z.string().default(''),
  SPLITWISE_CONSUMER_SECRET: z.string().default(''),
  SPLITWISE_REDIRECT_URI: z.string().default('http://localhost:3000/api/splitwise/callback'),

  // Provider keys. LLM_API_KEY is the old name for the Groq key.
  OPENROUTER_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  CEREBRAS_API_KEY: z.string().optional(),
  SARVAM_API_KEY: z.string().optional(),

  // Ordered "provider:model" lists; each one falls back to the next (quota, outage, truncated reply).
  AGENT_MODELS: z.string().optional(),
  VISION_MODELS: z.string().optional(),
  // Model chain for Manglish roasts only (DENIAL_STYLE=manglish). Defaults to Sarvam when its key is set.
  ROAST_MODELS: z.string().optional(),

  BOT_TRIGGERS: z.string().default('@splitbot,splitbot'),
  DEFAULT_CURRENCY: z.string().default('INR'),
  TIMEZONE: z.string().default('Asia/Kolkata'),
  OWNER_PHONE: z.string().default(''),
  CONFIRM_MODE: z.enum(['auto', 'always', 'never']).default('auto'),
  // How the bot turns down off-topic messages: 'manglish' (roasts + sticker) or 'plain'.
  DENIAL_STYLE: z.enum(['plain', 'manglish']).default('plain'),

  // Abuse guards (checked before any LLM call)
  LIMIT_PER_PERSON_10MIN: z.coerce.number().default(6),
  LIMIT_PER_PERSON_DAY: z.coerce.number().default(30),
  LIMIT_PER_GROUP_DAY: z.coerce.number().default(100),
  MAX_MESSAGE_CHARS: z.coerce.number().default(600),
  // Above this (USD/day, OpenRouter-reported), only free providers are used.
  DAILY_BUDGET_USD: z.coerce.number().default(0.5),

  PORT: z.coerce.number().default(3000),
  DASHBOARD_USER: z.string().default('admin'),
  DASHBOARD_PASSWORD: z.string().default(''),
  DATA_DIR: z.string().default('./data'),
});

// Treat empty strings in .env as unset so defaults apply.
const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
const env = Env.parse(raw);

const dataDir = path.resolve(env.DATA_DIR);

export const PROVIDERS = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: env.OPENROUTER_API_KEY },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: env.GROQ_API_KEY ?? env.LLM_API_KEY },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: env.GEMINI_API_KEY },
  deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: env.DEEPSEEK_API_KEY },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', apiKey: env.CEREBRAS_API_KEY },
  // Indian lab; strong at Indic languages incl. Malayalam and romanized code-mixed text.
  sarvam: { baseUrl: 'https://api.sarvam.ai/v1', apiKey: env.SARVAM_API_KEY },
} as const;
export type ProviderName = keyof typeof PROVIDERS;

export interface ModelRef {
  provider: ProviderName;
  model: string;
  /** "provider:model[@effort]", for logs and the dashboard. */
  id: string;
  /** Reasoning effort (low | medium | high) for models that reason. */
  effort?: string;
}

/** Parse "openrouter:deepseek/deepseek-v4.1-flash, groq:openai/gpt-oss-120b@high"; entries without a key are skipped. */
export function parseModels(list: string): ModelRef[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => {
      const i = id.indexOf(':');
      const provider = id.slice(0, i) as ProviderName;
      if (!(provider in PROVIDERS)) throw new Error(`Unknown provider in "${id}" (use ${Object.keys(PROVIDERS).join(', ')})`);
      const [model, effort] = id.slice(i + 1).split('@');
      return { provider, model, id, effort: effort || undefined };
    })
    .filter((m) => PROVIDERS[m.provider].apiKey);
}

const hasOpenRouter = !!env.OPENROUTER_API_KEY;
// Picked with scripts/eval.ts (Nov 2026). DeepSeek V4.1 Flash with thinking off: 16/16 at ~2s. With thinking on it
// sometimes spirals for 8k tokens on simple messages. Qwen3.8 Max (can't turn thinking off) is the backup, Groq's free
// gpt-oss the last resort.
const defaultAgent = [
  hasOpenRouter && 'openrouter:deepseek/deepseek-v4.1-flash@off',
  hasOpenRouter && 'openrouter:qwen/qwen3.8-max-0902',
  'groq:openai/gpt-oss-120b@medium',
  'groq:openai/gpt-oss-20b@medium',
].filter(Boolean).join(',');
// Roasts (Manglish, DENIAL_STYLE=manglish): wit benefits from thinking, unlike expense parsing. DeepSeek with medium
// reasoning gave the best comebacks; Sarvam's conversational model is a fast Indic-native backup.
const defaultRoast = [
  hasOpenRouter && 'openrouter:deepseek/deepseek-v4.1-flash@medium',
  env.SARVAM_API_KEY && 'sarvam:sarvam-105b-conversations',
  !hasOpenRouter && 'groq:openai/gpt-oss-120b@medium',
].filter(Boolean).join(',');
const defaultVision = [
  hasOpenRouter && 'openrouter:deepseek/deepseek-v4.1-flash@off',
  hasOpenRouter && 'openrouter:qwen/qwen3-vl-235b-a22b-instruct',
  'groq:qwen/qwen3.8-27b',
].filter(Boolean).join(',');

export const config = {
  splitwise: {
    consumerKey: env.SPLITWISE_CONSUMER_KEY,
    consumerSecret: env.SPLITWISE_CONSUMER_SECRET,
    redirectUri: env.SPLITWISE_REDIRECT_URI,
    tokenFile: path.join(dataDir, 'splitwise-token.json'),
  },
  llm: {
    agent: parseModels(env.AGENT_MODELS ?? defaultAgent),
    vision: parseModels(env.VISION_MODELS ?? defaultVision),
    roast: parseModels(env.ROAST_MODELS ?? defaultRoast),
  },
  bot: {
    triggers: env.BOT_TRIGGERS.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
    defaultCurrency: env.DEFAULT_CURRENCY.toUpperCase(),
    timezone: env.TIMEZONE,
    ownerPhone: env.OWNER_PHONE.replace(/\D/g, ''),
    /** auto: draft only when the model is unsure · always: every expense is a draft · never: always push */
    confirmMode: env.CONFIRM_MODE,
    denialStyle: env.DENIAL_STYLE,
  },
  limits: {
    perPerson10Min: env.LIMIT_PER_PERSON_10MIN,
    perPersonDay: env.LIMIT_PER_PERSON_DAY,
    perGroupDay: env.LIMIT_PER_GROUP_DAY,
    maxChars: env.MAX_MESSAGE_CHARS,
    dailyBudgetUsd: env.DAILY_BUDGET_USD,
  },
  web: {
    port: env.PORT,
    user: env.DASHBOARD_USER,
    password: env.DASHBOARD_PASSWORD,
  },
  dataDir,
  waAuthDir: path.join(dataDir, 'wa-auth'),
  dbFile: path.join(dataDir, 'splitbot.db'),
};
