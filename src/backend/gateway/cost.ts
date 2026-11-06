import { db } from '../db/database';

interface PriceRow {
  model: string;
  input_per_1m: number;
  output_per_1m: number;
}

let cache: Map<string, PriceRow> | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60_000;

function load(): Map<string, PriceRow> {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;
  const rows = db.prepare('SELECT model, cost_per_1m_in AS input_per_1m, cost_per_1m_out AS output_per_1m FROM model_prices').all() as PriceRow[];
  cache = new Map(rows.map((r) => [r.model, r]));
  cacheAt = now;
  return cache;
}

export function invalidatePriceCache(): void {
  cache = null;
  cacheAt = 0;
}

export function priceFor(model: string | null | undefined): { input: number; output: number } {
  if (!model) return { input: 0, output: 0 };
  const prices = load();
  const exact = prices.get(model);
  if (exact) return { input: exact.input_per_1m, output: exact.output_per_1m };

  // Fall back to the cheapest known model rather than guessing high.
  const all = Array.from(prices.values());
  if (all.length === 0) return { input: 0, output: 0 };
  const cheapest = all.reduce((a, b) => (a.input_per_1m <= b.input_per_1m ? a : b));
  return { input: cheapest.input_per_1m, output: cheapest.output_per_1m };
}

/**
 * Cost of one request in USD. Token counts are rounded to non-negative integers
 * before this is called.
 */
export function costOf(model: string | null | undefined, promptTokens: number, completionTokens: number): number {
  const p = priceFor(model);
  const cost = (promptTokens / 1_000_000) * p.input + (completionTokens / 1_000_000) * p.output;
  return Math.round(cost * 1e8) / 1e8;
}

export function listPrices(): PriceRow[] {
  return db.prepare('SELECT model, cost_per_1m_in AS input_per_1m, cost_per_1m_out AS output_per_1m FROM model_prices ORDER BY model').all() as PriceRow[];
}

export function upsertPrice(model: string, inputPer1m: number, outputPer1m: number): void {
  const m = String(model || '').trim();
  if (!m) throw new Error('model is required');
  const inp = Number(inputPer1m);
  const out = Number(outputPer1m);
  if (!Number.isFinite(inp) || inp < 0 || !Number.isFinite(out) || out < 0) {
    throw new Error('input_per_1m and output_per_1m must be non-negative numbers');
  }
  db.prepare(
    `INSERT INTO model_prices (model, cost_per_1m_in, cost_per_1m_out, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(model) DO UPDATE SET
       cost_per_1m_in = excluded.cost_per_1m_in,
       cost_per_1m_out = excluded.cost_per_1m_out,
       updated_at = datetime('now')`
  ).run(m, inp, out);
  invalidatePriceCache();
}

/**
 * How much a key has spent, in USD, over a rolling calendar window (UTC).
 */
export function spendToday(keyId?: number): number {
  const row = (
    keyId === undefined
      ? db
          .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM usage_log WHERE created_at >= datetime('now', 'start of day')`)
          .get()
      : db
          .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM usage_log WHERE key_id = ? AND created_at >= datetime('now', 'start of day')`)
          .get(keyId)
  ) as { spent: number } | undefined;
  return Math.round((row?.spent || 0) * 1e8) / 1e8;
}

export function spendThisMonth(keyId?: number): number {
  const row = (
    keyId === undefined
      ? db
          .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM usage_log WHERE created_at >= datetime('now', 'start of month')`)
          .get()
      : db
          .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM usage_log WHERE key_id = ? AND created_at >= datetime('now', 'start of month')`)
          .get(keyId)
  ) as { spent: number } | undefined;
  return Math.round((row?.spent || 0) * 1e8) / 1e8;
}

/**
 * Convenience facade used by the admin routes.
 */
export const CostModel = {
  listPrices,
  setPrice: upsertPrice,
  priceFor,
  costOf,
  spendToday,
  spendThisMonth,
  invalidate: invalidatePriceCache
};
