import type OpenAI from "openai";
import type { Test } from "./testHelpers.js";
import { assertTrue, createTestDb } from "./testHelpers.js";
import { tryAcquireLock, releaseLock, getLead } from "../db/queries.js";
import { processQueue } from "../agent/runQueue.js";

function seedMinimalLead(db: ReturnType<typeof createTestDb>, id: number): void {
  db.prepare(
    `INSERT INTO leads (id, name, contact, source, segment, stage, do_not_contact, contact_count)
     VALUES ($id, 'Test Lead', 'test@example.com', 'website_form', 'prospect', 'new', 0, 0)`
  ).run({ $id: id } as never);
}

/** A stub client that hangs mid-run so we can assert the lock is held while a run is "in flight". */
function makeSlowClient(): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => {
          const err = new Error("stub should not actually be called in the lock-level test") as Error & { status: number };
          err.status = 500;
          throw err;
        },
      },
    },
  } as unknown as OpenAI;
}

/**
 * A stub client that resolves any lead in exactly one turn by escalating --
 * reads the lead id out of buildUserTurn's own message text ("Process lead id
 * N now...") since that's the only place the stub can see which lead this
 * particular call is for.
 */
function makeQuickEscalatingClient(): OpenAI {
  let callCounter = 0;
  return {
    chat: {
      completions: {
        create: (params: { messages: { role: string; content?: unknown }[] }) => ({
          withResponse: async () => {
            callCounter += 1;
            const userMsg = params.messages.find((m) => m.role === "user")?.content as string | undefined;
            const leadId = Number(userMsg?.match(/Process lead id (\d+)/)?.[1] ?? 0);
            return {
              data: {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: `call_${callCounter}`,
                          type: "function",
                          function: {
                            name: "escalate_to_agent",
                            arguments: JSON.stringify({ lead_id: leadId, reason: "quick test" }),
                          },
                        },
                      ],
                    },
                  },
                ],
                usage: { total_tokens: 10 },
              },
              response: { headers: { get: () => null } },
            };
          },
        }),
      },
    },
  } as unknown as OpenAI;
}

export const lockingTests: Test[] = [
  {
    name: "tryAcquireLock: two workers racing for the same lead -- only one acquires it",
    run: () => {
      const db = createTestDb();
      seedMinimalLead(db, 1);

      const workerAGotIt = tryAcquireLock(db, 1, "worker-A");
      const workerBGotIt = tryAcquireLock(db, 1, "worker-B");

      assertTrue(workerAGotIt, "worker-A should acquire the free lock");
      assertTrue(!workerBGotIt, "worker-B should be refused while worker-A's lock is fresh");

      const lead = getLead(db, 1)!;
      assertTrue(lead.locked_by === "worker-A", `expected lock to still be held by worker-A, got ${lead.locked_by}`);
    },
  },
  {
    name: "releaseLock: only the owning worker's release clears the lock; lock is then acquirable again",
    run: () => {
      const db = createTestDb();
      seedMinimalLead(db, 1);
      tryAcquireLock(db, 1, "worker-A");

      // worker-B doesn't own the lock -- its release must be a no-op.
      releaseLock(db, 1, "worker-B");
      assertTrue(getLead(db, 1)!.locked_by === "worker-A", "a non-owner's release must not clear the lock");

      releaseLock(db, 1, "worker-A");
      assertTrue(getLead(db, 1)!.locked_by === null, "the owner's release should clear the lock");

      const workerBGotItNow = tryAcquireLock(db, 1, "worker-B");
      assertTrue(workerBGotItNow, "worker-B should be able to acquire the lock once it's free");
    },
  },
  {
    name: "tryAcquireLock: an expired lock (older than the timeout) can be re-acquired by another worker",
    run: () => {
      const db = createTestDb();
      seedMinimalLead(db, 1);
      const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
      db.prepare("UPDATE leads SET locked_at = $t, locked_by = $w WHERE id = 1").run({
        $t: staleTimestamp,
        $w: "worker-crashed",
      } as never);

      const workerBGotIt = tryAcquireLock(db, 1, "worker-B", 5 * 60 * 1000);
      assertTrue(workerBGotIt, "a lock older than the timeout should be treated as abandoned and re-acquirable");
    },
  },
  {
    name: "processQueue: a second worker skips a lead currently locked by a first worker's in-flight run",
    run: async () => {
      const db = createTestDb();
      seedMinimalLead(db, 1);

      // Simulate worker A already mid-run by acquiring the lock directly
      // (standing in for a real in-flight processQueue call on another process).
      tryAcquireLock(db, 1, "worker-A");

      const stubClient = makeSlowClient();
      const resultsB = await processQueue(db, stubClient, 1, "worker-B");

      assertTrue(resultsB.length === 0, `expected worker-B to skip the locked lead, got ${resultsB.length} result(s)`);
      assertTrue(getLead(db, 1)!.locked_by === "worker-A", "lock should remain held by worker-A, untouched by worker-B's skip");
    },
  },
  {
    name: "processQueue: an optional limit caps how many new leads a single pass starts",
    run: async () => {
      const db = createTestDb();
      seedMinimalLead(db, 1);
      seedMinimalLead(db, 2);
      seedMinimalLead(db, 3);

      const stubClient = makeQuickEscalatingClient();
      const results = await processQueue(db, stubClient, undefined, undefined, {}, 2);

      assertTrue(results.length === 2, `expected exactly 2 leads processed with limit=2, got ${results.length}`);
      const untouchedLead = getLead(db, 3)!;
      assertTrue(
        untouchedLead.stage === "new",
        `expected the 3rd lead to be left untouched by the capped pass, got stage '${untouchedLead.stage}'`
      );
    },
  },
];
