import type { DatabaseSync } from "node:sqlite";
import { ToolError } from "./errors.js";

interface MarketDataOutput {
  property?: { price?: number };
  price_history?: { avg_price: number }[];
  trend?: { percent_change_over_window?: number | null; projected_next_year_price?: number | null };
}

/**
 * Normalizes a single money token -- with or without a leading '$', with or
 * without thousands commas, with an optional k/K (thousand) or m/M (million)
 * suffix -- into a plain number. Exported standalone so it can be unit
 * tested directly against exact strings, independent of the prose regex
 * that finds these tokens inside a full draft.
 */
export function parseMoneyToken(raw: string): number {
  const stripped = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  const suffixMatch = stripped.match(/^(-?[\d.]+)\s*([kKmM])$/);
  if (suffixMatch) {
    const value = Number(suffixMatch[1]);
    const multiplier = /[kK]/.test(suffixMatch[2]) ? 1_000 : 1_000_000;
    return Math.round(value * multiplier);
  }
  return Number(stripped);
}

function extractDollarFigures(text: string): number[] {
  const matches = text.match(/\$\s?[\d,]+(?:\.\d+)?\s?(?:[kKmM](?![a-zA-Z]))?/g) ?? [];
  return matches.map((m) => parseMoneyToken(m));
}

/** Normalizes a single percent token (e.g. "12%", "-3.5 %") into a plain number. */
export function parsePercentToken(raw: string): number {
  return Number(raw.trim().replace(/[%\s]/g, ""));
}

function extractPercentFigures(text: string): number[] {
  const matches = text.match(/-?\d+(?:\.\d+)?\s?%/g) ?? [];
  return matches.map((m) => parsePercentToken(m));
}

function approxEquals(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

/**
 * Stretch guardrail: before a draft is accepted as a proposal, any $ or %
 * figure it mentions must trace back to the most recent
 * get_property_market_data call logged for this lead in this run. Prevents
 * the model from narrating a price/trend it made up.
 */
export function checkNumericGrounding(db: DatabaseSync, leadId: number, draft: string): void {
  const dollars = extractDollarFigures(draft);
  const percents = extractPercentFigures(draft);
  if (dollars.length === 0 && percents.length === 0) return;

  const row = db
    .prepare(
      `SELECT output_json FROM audit_log
       WHERE lead_id = $lead_id AND tool_name = 'get_property_market_data'
       ORDER BY timestamp DESC, id DESC LIMIT 1`
    )
    .get({ $lead_id: leadId }) as { output_json: string } | undefined;

  if (!row) {
    throw new ToolError(
      "UNGROUNDED_FIGURES",
      "Draft mentions a $ or % figure but get_property_market_data has not been called yet for this lead. Call it first, then only narrate the numbers it returns."
    );
  }

  const data = JSON.parse(row.output_json) as MarketDataOutput;
  const allowedDollars = [
    data.property?.price,
    ...(data.price_history ?? []).map((h) => h.avg_price),
    data.trend?.projected_next_year_price ?? undefined,
  ].filter((n): n is number => typeof n === "number");
  const allowedPercents = [data.trend?.percent_change_over_window ?? undefined].filter(
    (n): n is number => typeof n === "number"
  );

  for (const d of dollars) {
    const ok = allowedDollars.some((a) => approxEquals(a, d, Math.max(1, a * 0.01)));
    if (!ok) {
      throw new ToolError(
        "UNGROUNDED_FIGURES",
        `Draft cites $${d.toLocaleString()} which does not match any figure from the last get_property_market_data call for this lead (allowed: ${allowedDollars
          .map((a) => `$${a.toLocaleString()}`)
          .join(", ") || "none"}). Revise the draft to only use those numbers.`
      );
    }
  }
  for (const p of percents) {
    const ok = allowedPercents.some((a) => approxEquals(a, p, 0.15));
    if (!ok) {
      throw new ToolError(
        "UNGROUNDED_FIGURES",
        `Draft cites ${p}% which does not match the trend figure from the last get_property_market_data call for this lead (allowed: ${allowedPercents.join(
          ", "
        ) || "none"}). Revise the draft to only use that number.`
      );
    }
  }
}
