import type { Test } from "./testHelpers.js";
import { assertEqual, assertTrue, createTestDb } from "./testHelpers.js";
import { parseMoneyToken, parsePercentToken, checkNumericGrounding } from "../domain/grounding.js";
import { insertAudit } from "../db/queries.js";

export const groundingTests: Test[] = [
  {
    name: "parseMoneyToken: $500k -> 500000 (regression for the shorthand false-positive bug)",
    run: () => assertEqual(parseMoneyToken("$500k"), 500_000, "$500k should parse to 500000"),
  },
  {
    name: "parseMoneyToken: $1.2M -> 1200000",
    run: () => assertEqual(parseMoneyToken("$1.2M"), 1_200_000, "$1.2M should parse to 1200000"),
  },
  {
    name: "parseMoneyToken: 1,200,000 (no $ sign) -> 1200000",
    run: () => assertEqual(parseMoneyToken("1,200,000"), 1_200_000, "comma-formatted bare number should parse to 1200000"),
  },
  {
    name: "parseMoneyToken: $480,000 (plain, no shorthand) -> 480000",
    run: () => assertEqual(parseMoneyToken("$480,000"), 480_000, "plain comma-formatted dollar amount should still parse correctly"),
  },
  {
    name: "parseMoneyToken: $500K (uppercase K) -> 500000",
    run: () => assertEqual(parseMoneyToken("$500K"), 500_000, "uppercase K suffix should be treated the same as lowercase k"),
  },
  {
    name: "parsePercentToken: 12% -> 12",
    run: () => assertEqual(parsePercentToken("12%"), 12, "12% should parse to 12"),
  },
  {
    name: "parsePercentToken: -3.5% -> -3.5",
    run: () => assertEqual(parsePercentToken("-3.5%"), -3.5, "negative percent should parse correctly"),
  },
  {
    name: "checkNumericGrounding: regression -- '$500k' no longer false-positives against a grounded projection",
    run: () => {
      const db = createTestDb();
      const leadId = 1;
      db.prepare(
        `INSERT INTO leads (id, name, contact, source, segment, stage, do_not_contact, contact_count)
         VALUES (1, 'Test Lead', 'test@example.com', 'website_form', 'prospect', 'new', 0, 0)`
      ).run();
      // Mirrors the live bug: property market data where 500000 doesn't appear
      // verbatim, but the projected next-year price (497333) is within the
      // guardrail's existing tolerance of a $500k restated budget.
      insertAudit(db, {
        lead_id: leadId,
        tool_name: "get_property_market_data",
        input_json: { property_id: 1 },
        output_json: {
          property: { price: 480000 },
          price_history: [
            { avg_price: 430000 },
            { avg_price: 445000 },
            { avg_price: 462000 },
            { avg_price: 480000 },
          ],
          trend: { percent_change_over_window: 7.9, projected_next_year_price: 497333 },
        },
        actor: "agent",
      });

      // This exact sentence (from the original draft that triggered the bug)
      // must not throw once shorthand parsing is fixed.
      let threw = false;
      try {
        checkNumericGrounding(db, leadId, "Hi Alice — thanks for your inquiry about houses under $500k in Suburbia.");
      } catch {
        threw = true;
      }
      assertTrue(!threw, "checkNumericGrounding should not reject '$500k' once it correctly parses to 500000");
    },
  },
  {
    name: "checkNumericGrounding: still rejects a genuinely fabricated figure",
    run: () => {
      const db = createTestDb();
      const leadId = 1;
      db.prepare(
        `INSERT INTO leads (id, name, contact, source, segment, stage, do_not_contact, contact_count)
         VALUES (1, 'Test Lead', 'test@example.com', 'website_form', 'prospect', 'new', 0, 0)`
      ).run();
      insertAudit(db, {
        lead_id: leadId,
        tool_name: "get_property_market_data",
        input_json: { property_id: 1 },
        output_json: {
          property: { price: 480000 },
          price_history: [{ avg_price: 430000 }],
          trend: { percent_change_over_window: 7.9, projected_next_year_price: 497333 },
        },
        actor: "agent",
      });

      let threw = false;
      try {
        checkNumericGrounding(db, leadId, "This property is a steal at $2M, up 40% this year!");
      } catch {
        threw = true;
      }
      assertTrue(threw, "a figure with no relation to the grounded market data should still be rejected");
    },
  },
];
