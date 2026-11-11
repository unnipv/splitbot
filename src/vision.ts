import { chat, looseJson, visionModels } from './llm.ts';
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
}

/** Line items that add up to the total or subtotal (within 1%) — a cheap check that the model read the bill right. */
function reconciles(bill: BillData): boolean {
  const items = bill.items ?? [];
  if (!items.length) return true;
  const sum = items.reduce((a, it) => a + (Number(it.amount) || 0), 0);
  return [bill.total, bill.subtotal].some((t) => t && Math.abs(sum - t) <= t * 0.01 + 1);
}

/**
 * Stage 1 for images: a vision/OCR model turns the photo into structured text the agent model can reason over.
 * If a model's line items don't add up, the next model gets a go; the first consistent reading wins.
 */
export async function readBill(image: { data: Buffer; mime: string }, caption: string): Promise<BillData | { error: string }> {
  const url = `data:${image.mime};base64,${image.data.toString('base64')}`;
  const models = visionModels();
  let first: BillData | undefined;
  let lastErr: unknown;
  for (let i = 0; i < models.length; i++) {
    try {
      const res = await chat(
        models.slice(i),
        [
          { role: 'system', content: PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: caption ? `Message sent with the image: "${caption}"` : 'Extract the bill.' },
              { type: 'image_url', image_url: { url } },
            ],
          },
        ],
        { temperature: 0 },
      );
      const bill = looseJson<BillData>(res.content ?? '');
      log.info(`Read bill (${res.model}): ${bill.merchant ?? '?'} ${bill.currency ?? ''} ${bill.total ?? '?'} (${bill.items?.length ?? 0} items)`);
      if (reconciles(bill)) return bill;
      log.warn(`Items from ${res.model} don't add up to the total; trying the next vision model`);
      first ??= bill;
      // The chain may have fallen through to a later model; continue after the one that answered.
      i = Math.max(i, models.findIndex((m) => m.id === res.model));
    } catch (err) {
      lastErr = err;
      break; // chat() already tried every remaining model
    }
  }
  if (first) return { ...first, notes: [first.notes, 'line items do not add up to the total — double-check the reading'].filter(Boolean).join('; ') };
  log.error('Bill extraction failed', lastErr);
  return { error: lastErr instanceof Error ? lastErr.message : String(lastErr) };
}
