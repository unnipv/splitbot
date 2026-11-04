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

/** Stage 1 for images: a vision/OCR model turns the photo into structured text the agent model can reason over. */
export async function readBill(image: { data: Buffer; mime: string }, caption: string): Promise<BillData | { error: string }> {
  const url = `data:${image.mime};base64,${image.data.toString('base64')}`;
  try {
    const res = await chat(
      visionModels(),
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
    return bill;
  } catch (err) {
    log.error('Bill extraction failed', err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
