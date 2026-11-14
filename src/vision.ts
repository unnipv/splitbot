import { config, type ModelRef } from './config.ts';
import { chat, looseJson, visionModels, type ContentPart } from './llm.ts';
import { logger } from './log.ts';

const log = logger('vision');

const PROMPT = `You read photos of bills, receipts, invoices, payment screenshots (UPI/GPay/PhonePe/card) and booking confirmations.
Extract what is needed to log the expense. Respond with ONLY a JSON object:
{
  "is_bill": true|false,            // false if the image is not a bill/receipt/payment proof
  "merchant": string|null,
  "date": "YYYY-MM-DD"|null,
  "currency": "ISO 4217 code"|null, // infer from symbols, country, language (₹=INR, ฿=THB, ¥=JPY/CNY, € =EUR...)
  "total": number|null,             // the final amount actually paid, after tax/service/discounts/tip
  "subtotal": number|null,
  "tax_and_charges": number|null,
  "tip": number|null,
  "items": [{"name": string, "qty": number|null, "amount": number}],  // line items if legible, else []
  "payer_hint": string|null,        // name on a payment screenshot or card, if visible
  "notes": string|null              // anything ambiguous, e.g. "two totals visible", "partly cut off"
}
Use numbers without thousands separators. Never invent values that are not visible.`;

export interface BillData {
  is_bill: boolean;
  merchant: string | null;
  date: string | null;
  currency: string | null;
  total: number | null;
  subtotal: number | null;
  tax_and_charges: number | null;
  tip: number | null;
  items: { name: string; qty: number | null; amount: number }[];
  payer_hint: string | null;
  notes: string | null;
  /** Set by code when two models read different totals: the expense is then drafted, never pushed straight away. */
  uncertain?: boolean;
}

/** Line items that add up to the total or subtotal (within 1%) — a cheap check that the model read the bill right. */
function reconciles(bill: BillData): boolean {
  const items = bill.items ?? [];
  if (!items.length) return true;
  const sum = items.reduce((a, it) => a + (Number(it.amount) || 0), 0);
  return [bill.total, bill.subtotal].some((t) => t && Math.abs(sum - t) <= t * 0.01 + 1);
}

async function readWith(models: ModelRef[], image: { data: Buffer; mime: string }, caption: string) {
  const url = `data:${image.mime};base64,${image.data.toString('base64')}`;
  const media: ContentPart =
    image.mime === 'application/pdf' ? { type: 'file', file: { filename: 'bill.pdf', file_data: url } } : { type: 'image_url', image_url: { url } };
  const res = await chat(
    models,
    [
      { role: 'system', content: PROMPT },
      { role: 'user', content: [{ type: 'text', text: caption ? `Message sent with the image: "${caption}"` : 'Extract the bill.' }, media] },
    ],
    { temperature: 0, timeoutMs: 45_000 },
  );
  const bill = looseJson<BillData>(res.content ?? '');
  log.info(`Read bill (${res.model}): ${bill.merchant ?? '?'} ${bill.currency ?? ''} ${bill.total ?? '?'} (${bill.items?.length ?? 0} items)`);
  return { bill, model: res.model };
}

const DOESNT_ADD_UP = 'line items do not add up to the total — double-check the reading';
const withNote = (bill: BillData, note: string): BillData => ({ ...bill, notes: [bill.notes, note].filter(Boolean).join('; ') });

/**
 * Stage 1 for images and PDFs: a vision/OCR model turns the bill into structured data the agent model can reason over.
 * With VISION_CROSSCHECK the first two models read it at the same time: matching totals are trusted, different totals
 * mark the reading uncertain. Otherwise (or when a reading fails) models are tried in order and the first whose line
 * items add up wins.
 */
export async function readBill(image: { data: Buffer; mime: string }, caption: string): Promise<BillData | { error: string }> {
  let models = visionModels();
  if (image.mime === 'application/pdf') {
    // Only OpenRouter takes PDFs through the OpenAI-style API.
    models = models.filter((m) => m.provider === 'openrouter');
    if (!models.length) return { error: 'PDF bills need an OpenRouter vision model (VISION_MODELS)' };
  }
  let first: BillData | undefined;
  let lastErr: unknown;
  let start = 0;

  if (config.llm.visionCrosscheck && models.length >= 2) {
    const [a, b] = await Promise.allSettled([readWith([models[0]], image, caption), readWith([models[1]], image, caption)]);
    const ok = [a, b].filter((r) => r.status === 'fulfilled').map((r) => r.value.bill);
    if (ok.length === 2) {
      const [x, y] = ok;
      const primary = reconciles(x) ? x : reconciles(y) ? y : x;
      const agree =
        x.total != null && y.total != null && Math.abs(x.total - y.total) <= Math.max(x.total, y.total) * 0.005 + 0.01 &&
        (!x.currency || !y.currency || x.currency === y.currency);
      if (agree) return reconciles(primary) ? primary : withNote(primary, DOESNT_ADD_UP);
      log.warn(`Vision models disagree: ${x.currency ?? ''} ${x.total} vs ${y.currency ?? ''} ${y.total}`);
      return { ...withNote(primary, `two readings of this bill disagree: total ${x.currency ?? ''} ${x.total} vs ${y.currency ?? ''} ${y.total}`), uncertain: true };
    }
    if (ok.length === 1) {
      if (reconciles(ok[0])) return ok[0];
      first = ok[0];
    } else {
      lastErr = (a as PromiseRejectedResult).reason;
    }
    start = 2;
  }

  for (let i = start; i < models.length; i++) {
    try {
      const { bill, model } = await readWith(models.slice(i), image, caption);
      if (reconciles(bill)) return bill;
      log.warn(`Items from ${model} don't add up to the total; trying the next vision model`);
      first ??= bill;
      // The chain may have fallen through to a later model; continue after the one that answered.
      i = Math.max(i, models.findIndex((m) => m.id === model));
    } catch (err) {
      lastErr = err;
      break; // chat() already tried every remaining model
    }
  }
  if (first) return withNote(first, DOESNT_ADD_UP);
  log.error('Bill extraction failed', lastErr);
  return { error: lastErr instanceof Error ? lastErr.message : String(lastErr) };
}
