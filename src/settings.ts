import { z } from 'zod';
import { config, parseModels } from './config.ts';
import * as store from './db.ts';

/**
 * Settings the dashboard can change without a restart. The .env values are the defaults; overrides live in the
 * database and are written onto `config`, which the rest of the code keeps reading as before.
 */

const count = (max: number) => z.coerce.number().int().min(1).max(max);
const chain = z.string().trim().min(1).max(600);

const Schema = z
  .object({
    confirmMode: z.enum(['auto', 'always', 'never']),
    denialStyle: z.enum(['plain', 'manglish']),
    perPerson10Min: count(1000),
    perPersonDay: count(10_000),
    perGroupDay: count(100_000),
    maxChars: z.coerce.number().int().min(50).max(5000),
    dailyBudgetUsd: z.coerce.number().min(0).max(1000),
    defaultCurrency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'use a 3-letter currency code').transform((s) => s.toUpperCase()),
    triggers: z.string().trim().min(1).max(200),
    visionCrosscheck: z.boolean(),
    agentModels: chain,
    visionModels: chain,
    roastModels: chain,
  })
  .strict();

export type Settings = z.infer<typeof Schema>;
const KEYS = Object.keys(Schema.shape) as (keyof Settings)[];
const PREFIX = 'cfg:';

function read(): Settings {
  return {
    confirmMode: config.bot.confirmMode,
    denialStyle: config.bot.denialStyle,
    perPerson10Min: config.limits.perPerson10Min,
    perPersonDay: config.limits.perPersonDay,
    perGroupDay: config.limits.perGroupDay,
    maxChars: config.limits.maxChars,
    dailyBudgetUsd: config.limits.dailyBudgetUsd,
    defaultCurrency: config.bot.defaultCurrency,
    triggers: config.bot.triggers.join(','),
    visionCrosscheck: config.llm.visionCrosscheck,
    agentModels: config.llm.chains.agent,
    visionModels: config.llm.chains.vision,
    roastModels: config.llm.chains.roast,
  };
}

/** What .env says, captured before any override is applied. */
const defaults: Settings = read();

function apply(s: Settings) {
  config.bot.confirmMode = s.confirmMode;
  config.bot.denialStyle = s.denialStyle;
  config.bot.defaultCurrency = s.defaultCurrency;
  config.bot.triggers = s.triggers.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  config.limits.perPerson10Min = s.perPerson10Min;
  config.limits.perPersonDay = s.perPersonDay;
  config.limits.perGroupDay = s.perGroupDay;
  config.limits.maxChars = s.maxChars;
  config.limits.dailyBudgetUsd = s.dailyBudgetUsd;
  config.llm.visionCrosscheck = s.visionCrosscheck;
  config.llm.chains = { agent: s.agentModels, vision: s.visionModels, roast: s.roastModels };
  config.llm.agent = parseModels(s.agentModels);
  config.llm.vision = parseModels(s.visionModels);
  config.llm.roast = parseModels(s.roastModels);
}

function overrides(): Partial<Settings> {
  const stored = store.allSettings(PREFIX);
  const out: Record<string, unknown> = {};
  // A stored value that no longer validates (schema changed) is ignored rather than breaking startup.
  for (const k of KEYS) {
    if (!(k in stored)) continue;
    const parsed = Schema.shape[k].safeParse(stored[k]);
    if (parsed.success) out[k] = parsed.data;
  }
  return out as Partial<Settings>;
}

export function loadSettings() {
  try {
    apply({ ...defaults, ...overrides() });
  } catch {
    apply(defaults); // e.g. a stored model chain names a provider that no longer exists
  }
}

export function getSettings() {
  return { values: read(), defaults, overridden: Object.keys(overrides()) };
}

/** Validate and store a patch; `null` puts a key back to its .env default. Throws a readable error on bad input. */
export function saveSettings(patch: Record<string, unknown>) {
  const resets = Object.keys(patch).filter((k) => patch[k] === null);
  const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null && v !== undefined));
  const parsed = Schema.partial().safeParse(changes);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  for (const k of resets) if (!KEYS.includes(k as keyof Settings)) throw new Error(`Unknown setting: ${k}`);

  const next = { ...defaults, ...overrides(), ...parsed.data };
  for (const k of resets) (next as Record<string, unknown>)[k] = defaults[k as keyof Settings];
  // A chain must leave at least one usable model (entries without an API key are dropped by parseModels).
  for (const k of ['agentModels', 'visionModels'] as const) {
    if (!parseModels(next[k]).length) throw new Error(`${k}: no model in this list has an API key configured`);
  }
  parseModels(next.roastModels);

  for (const [k, v] of Object.entries(parsed.data)) store.setSetting(PREFIX + k, v);
  for (const k of resets) store.setSetting(PREFIX + k, null);
  apply(next);
  return getSettings();
}
