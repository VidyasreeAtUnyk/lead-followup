import type OpenAI from "openai";
import type { Test } from "./testHelpers.js";
import { assertTrue, createTestDb } from "./testHelpers.js";
import { runAgentForLead } from "../agent/loop.js";
import { listAudit } from "../db/queries.js";

function seedMinimalLead(db: ReturnType<typeof createTestDb>, id: number): void {
  db.prepare(
    `INSERT INTO leads (id, name, contact, source, segment, stage, do_not_contact, contact_count)
     VALUES ($id, 'Test Lead', 'test@example.com', 'website_form', 'prospect', 'new', 0, 0)`
  ).run({ $id: id } as never);
}

function makeThrowingClient(status: number, message: string, headers?: Record<string, string>): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => {
          const err = new Error(message) as Error & { status: number; headers?: Record<string, string> };
          err.status = status;
          err.headers = headers;
          throw err;
        },
      },
    },
  } as unknown as OpenAI;
}

export const retryTests: Test[] = [
  {
    name: "runAgentForLead escalates gracefully (not a crash) when the LLM call fails after retries are exhausted",
    run: async () => {
      const db = createTestDb();
      seedMinimalLead(db, 1);
      const stubClient = makeThrowingClient(429, "simulated rate limit");

      const result = await runAgentForLead(db, 1, stubClient, { maxRetries: 2, baseDelayMs: 5 });

      assertTrue(result.outcome.kind === "escalated", `expected escalated outcome, got ${result.outcome.kind}`);

      const audit = listAudit(db, 1);
      const escalateRow = audit.find((r) => r.tool_name === "escalate_to_agent");
      assertTrue(Boolean(escalateRow), "expected an escalate_to_agent audit_log entry");
      assertTrue(
        escalateRow!.input_json.includes("LLM call failed after retries"),
        `expected a clear reason logged, got: ${escalateRow!.input_json}`
      );
    },
  },
  {
    name: "runAgentForLead does not retry a non-retryable error (e.g. 400) -- fails fast into escalation",
    run: async () => {
      const db = createTestDb();
      seedMinimalLead(db, 2);
      const stubClient = makeThrowingClient(400, "simulated bad request");
      const start = Date.now();

      const result = await runAgentForLead(db, 2, stubClient, { maxRetries: 3, baseDelayMs: 1000 });
      const elapsedMs = Date.now() - start;

      assertTrue(result.outcome.kind === "escalated", `expected escalated outcome, got ${result.outcome.kind}`);
      assertTrue(elapsedMs < 500, `expected a non-retryable error to fail fast with no backoff delay, took ${elapsedMs}ms`);
    },
  },
  {
    name: "runAgentForLead fails fast (no retries) on a 429 whose retry-after is too long to be worth waiting for",
    run: async () => {
      const db = createTestDb();
      seedMinimalLead(db, 3);
      // Mirrors a real daily-quota 429: a huge retry-after (e.g. 1728s) means
      // no amount of in-process backoff will succeed -- retrying is pure waste.
      const stubClient = makeThrowingClient(429, "simulated daily quota exhausted", { "retry-after": "1728" });
      const start = Date.now();

      const result = await runAgentForLead(db, 3, stubClient, { maxRetries: 5, baseDelayMs: 1000 });
      const elapsedMs = Date.now() - start;

      assertTrue(result.outcome.kind === "escalated", `expected escalated outcome, got ${result.outcome.kind}`);
      assertTrue(
        elapsedMs < 500,
        `expected to fail fast (skip all retries) when retry-after is too long to be worth it, took ${elapsedMs}ms`
      );
    },
  },
  {
    name: "runAgentForLead still retries a 429 with a short retry-after (worth waiting for)",
    run: async () => {
      const db = createTestDb();
      seedMinimalLead(db, 4);
      const stubClient = makeThrowingClient(429, "simulated brief rate limit", { "retry-after": "1" });

      const result = await runAgentForLead(db, 4, stubClient, { maxRetries: 2, baseDelayMs: 10 });

      assertTrue(result.outcome.kind === "escalated", `expected escalated outcome, got ${result.outcome.kind}`);
      const audit = listAudit(db, 4);
      const escalateRow = audit.find((r) => r.tool_name === "escalate_to_agent");
      assertTrue(
        Boolean(escalateRow) && escalateRow!.input_json.includes("LLM call failed after retries"),
        "expected it to still exhaust the (short) retry budget before escalating"
      );
    },
  },
];
