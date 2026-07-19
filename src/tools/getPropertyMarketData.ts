import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { getProperty, listPriceHistory } from "../db/queries.js";
import { ToolError } from "../domain/errors.js";

const schema = z.object({
  property_id: z.number().int().positive(),
});

function linearRegressionNextYear(points: { year: number; avg_price: number }[]): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.year, 0);
  const sumY = points.reduce((s, p) => s + p.avg_price, 0);
  const sumXY = points.reduce((s, p) => s + p.year * p.avg_price, 0);
  const sumXX = points.reduce((s, p) => s + p.year * p.year, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const nextYear = points[points.length - 1].year + 1;
  return Math.round(slope * nextYear + intercept);
}

/**
 * The ONLY source of price/trend numbers in the system. All arithmetic here
 * is plain deterministic code -- no model call. Prompts instruct the agent
 * to narrate these numbers verbatim rather than invent its own, and the
 * (optional) numeric-grounding guardrail in propose_message cross-checks
 * that any $ or % figures in a draft trace back to this tool's last output.
 */
export const getPropertyMarketData: ToolDefinition<z.infer<typeof schema>> = {
  name: "get_property_market_data",
  description:
    "Returns price history for a property plus a deterministically computed trend (% change over the last up-to-3 data points, and a linear-regression projection for next year). This is the only legitimate source of price/trend figures -- never invent your own.",
  schema,
  execute: (db, input) => {
    const property = getProperty(db, input.property_id);
    if (!property) throw new ToolError("NOT_FOUND", `No property with id ${input.property_id}.`);
    const history = listPriceHistory(db, input.property_id);

    const window = history.slice(-3);
    let percentChangeOverWindow: number | null = null;
    if (window.length >= 2) {
      const first = window[0].avg_price;
      const last = window[window.length - 1].avg_price;
      percentChangeOverWindow = first === 0 ? null : Math.round(((last - first) / first) * 1000) / 10;
    }
    const projectedNextYearPrice = linearRegressionNextYear(window);

    return {
      property,
      price_history: history,
      trend: {
        window_years: window.map((w) => w.year),
        percent_change_over_window: percentChangeOverWindow,
        projected_next_year_price: projectedNextYearPrice,
      },
    };
  },
};
