import type OpenAI from "openai";
import type { Test } from "./testHelpers.js";
import { assertTrue, createTestDb } from "./testHelpers.js";
import { isParkedOnEscalation, insertAudit } from "../db/queries.js";
import { dispatchToolCall } from "../tools/index.js";
import { runAgentForLead } from "../agent/loop.js";

function seedMinimalLead(db: ReturnType<typeof createTestDb>, id: number): void {
  db.prepare(
    `INSERT INTO leads (id, name, contact, source, segment, stage, do_not_contact, contact_count)
     VALUES ($id, 'Test Lead', 'test@example.com', 'website_form', 'prospect', 'new', 0, 0)`
  ).run({ $id: id } as never);
}

// createCompletionWithRetry always calls .create(params).withResponse() --
// see the equivalent comment in retry.test.ts for why this shape matters.
function makeThrowingClient(status: number, headers?: Record<string, string>): OpenAI {
  return {
    chat: {
      completions: {
        create: () => ({
          withResponse: async () => {
            const err = new Error("simulated failure") as Error & { status: number; headers?: Record<string, string> };
            err.status = status;
            err.headers = headers;
            throw err;
          },
        }),
      },
    },
  } as unknown as OpenAI;
}

export const escalationTests: Test[] = [
  {
    name: "isParkedOnEscalation: a genuine model-decided escalation parks the lead",
    run: () => {
      const db = createTestDb();
      seedMinimalLead(db, 1);
      const result = dispatchToolCall(db, 1, "escalate_to_agent", {
        lead_id: 1,
        reason: "Contradictory signals from the lead",
      });
      assertTrue(result.ok, "expected escalate_to_agent to succeed");
      assertTrue(isParkedOnEscalation(db, 1), "a genuine (non-system-triggered) escalation should park the lead");
    },
  },
  {
    name: "isParkedOnEscalation: a system_triggered escalation (infra failure) does NOT park the lead",
    run: () => {
      const db = createTestDb();
      seedMinimalLead(db, 1);
      const result = dispatchToolCall(db, 1, "escalate_to_agent", {
        lead_id: 1,
        reason: "LLM call failed after retries: simulated",
        system_triggered: true,
      });
      assertTrue(result.ok, "expected escalate_to_agent to succeed");
      assertTrue(
        !isParkedOnEscalation(db, 1),
        "a system_triggered escalation (infra hiccup, not a model judgment call) should not park the lead"
      );
    },
  },
  {
    name: "runAgentForLead's own safety-net escalations (llm_call_failed) are system_triggered and don't park",
    run: async () => {
      const db = createTestDb();
      seedMinimalLead(db, 1);
      const stubClient = makeThrowingClient(429, { "retry-after": "2" });

      const result = await runAgentForLead(db, 1, stubClient, { maxRetries: 1, baseDelayMs: 5 });

      assertTrue(result.outcome.kind === "escalated", `expected escalated, got ${result.outcome.kind}`);
      assertTrue(
        !isParkedOnEscalation(db, 1),
        "the agent loop's own safety-net escalation must not permanently park the lead -- it should be retried automatically next pass"
      );
    },
  },
  {
    name: "a human 'retry' action (new audit row) un-parks a genuinely parked lead",
    run: () => {
      const db = createTestDb();
      seedMinimalLead(db, 1);
      dispatchToolCall(db, 1, "escalate_to_agent", { lead_id: 1, reason: "do_not_contact concern" });
      assertTrue(isParkedOnEscalation(db, 1), "sanity check: lead should start parked");

      insertAudit(db, {
        lead_id: 1,
        tool_name: "retry_lead",
        input_json: { lead_id: 1 },
        output_json: { ok: true, unparked: true },
        actor: "human",
      });

      assertTrue(!isParkedOnEscalation(db, 1), "a newer audit row (the human retry action) should un-park the lead");
    },
  },
];
