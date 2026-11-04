import { config, PROVIDERS, type ModelRef } from './config.ts';
import { recordUsage, spendSince, startOfDay } from './db.ts';
import { logger } from './log.ts';

const log = logger('llm');

/** Minimal OpenAI-compatible chat client: works with Groq, OpenRouter, Gemini's OpenAI endpoint, DeepInfra, vLLM, Ollama… */

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface ChatOptions {
  tools?: ToolDef[];
  temperature?: number;
  /** Output cap; defaults high because reasoning models spend output tokens thinking. */
  maxTokens?: number;
}

export interface ChatResult {
  content: string | null;
  tool_calls: ToolCall[];
  usage: unknown;
  /** Which "provider:model" answered. */
  model: string;
}

/** Models whose daily quota ran out, skipped until the given time. */
const exhausted = new Map<string, number>();

class SkipModel extends Error {}

/**
 * Try each model in order. A model is skipped on daily-quota 429s, auth/billing errors, outages, or a reply
 * cut off before it said anything; the last model in the chain gets patient retries for per-minute limits.
 */
export async function chat(chain: ModelRef[], messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  let live = chain.filter((m) => (exhausted.get(m.id) ?? 0) < Date.now());
  // Over the daily budget: stick to free providers (Groq) if any are configured.
  if (spendSince(startOfDay()) >= config.limits.dailyBudgetUsd) {
    const free = live.filter((m) => m.provider === 'groq');
    if (free.length && free.length < live.length) {
      log.warn(`Daily budget $${config.limits.dailyBudgetUsd} reached — using free models only`);
      live = free;
    }
  }
  const candidates = live.length ? live : chain;
  if (!candidates.length) throw new Error('No LLM configured — add OPENROUTER_API_KEY or GROQ_API_KEY to .env');
  let lastErr: unknown;
  for (const [i, ref] of candidates.entries()) {
    try {
      return await callModel(ref, messages, opts, i === candidates.length - 1);
    } catch (err) {
      lastErr = err;
      if (i < candidates.length - 1) log.warn(`${ref.id} failed, falling back to ${candidates[i + 1].id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  throw lastErr;
}

async function callModel(ref: ModelRef, messages: ChatMessage[], opts: ChatOptions, isLast: boolean): Promise<ChatResult> {
  const provider = PROVIDERS[ref.provider];
  const body: Record<string, unknown> = {
    model: ref.model,
    messages,
    temperature: opts.temperature ?? 0.1,
    // Reasoning models spend output tokens thinking; a low cap leaves them nothing for the actual answer.
    max_tokens: opts.maxTokens ?? 8192,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  const effort = ref.effort;
  // OpenRouter: "@off" disables thinking, "@low|medium|high" sets effort, "@2000" caps thinking tokens.
  if (effort && ref.provider === 'openrouter') {
    body.reasoning = effort === 'off' ? { enabled: false } : /^\d+$/.test(effort) ? { max_tokens: Number(effort) } : { effort };
  }
  if (effort && ref.provider === 'groq' && ref.model.startsWith('openai/gpt-oss')) body.reasoning_effort = effort;

  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` };
  if (ref.provider === 'openrouter') headers['X-Title'] = 'Splitbot';

  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      if (!isLast) throw new SkipModel(`network error: ${err instanceof Error ? err.message : err}`);
      if (attempt < 3) continue;
      throw err;
    }
    if (res.status === 429) {
      const text = await res.clone().text();
      if (/per day|\(TPD\)|\(RPD\)/i.test(text)) {
        exhausted.set(ref.id, Date.now() + 60 * 60_000);
        throw new SkipModel(`daily quota used up for ${ref.id}`);
      }
    }
    if (res.status === 429 || res.status >= 500) {
      // Per-minute limits and blips: move on if something else can answer, otherwise wait it out.
      if (!isLast && attempt >= 1) throw new SkipModel(`${res.status} from ${ref.id}`);
      if (attempt < 6) {
        const wait = Math.min(Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt, isLast ? 60_000 : 5_000);
        log.warn(`${ref.id} → ${res.status}, retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
    }
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`LLM ${ref.id} failed (${res.status}): ${JSON.stringify(data.error ?? data).slice(0, 400)}`);
    const choice = data.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const content = typeof msg.content === 'string' ? stripThinking(msg.content) : null;
    const toolCalls = (msg.tool_calls ?? []) as ToolCall[];
    log.debug(`${ref.id} ${Date.now() - started}ms`, data.usage);
    const u = data.usage ?? {};
    recordUsage(ref.id, u.prompt_tokens ?? 0, u.completion_tokens ?? 0, Number(u.cost) || 0);
    // An empty reply is fine (the agent is told to stay quiet after recording); one cut off mid-reasoning is not.
    if (!content && !toolCalls.length && choice.finish_reason === 'length') {
      throw new Error(`${ref.id} ran out of tokens while reasoning`);
    }
    return { content, tool_calls: toolCalls, usage: data.usage, model: ref.id };
  }
}

function stripThinking(s: string) {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export const agentModels = () => config.llm.agent;
export const visionModels = () => config.llm.vision;

/** Parse JSON that a model may have wrapped in a ```json fence or surrounded with prose. */
export function looseJson<T = unknown>(s: string): T {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : s;
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
}
