import type OpenAI from "openai";
import type { Test } from "./testHelpers.js";
import { assertTrue, createTestDb } from "./testHelpers.js";
import { runAgentForLead, type RunProgress } from "../agent/loop.js";

function seedMinimalLead(db: ReturnType<typeof createTestDb>, id: number): void {
  db.prepare(
    `INSERT INTO leads (id, name, contact, source, segment, stage, do_not_contact, contact_count)
     VALUES ($id, 'Test Lead', 'test@example.com', 'website_form', 'prospect', 'new', 0, 0)`
  ).run({ $id: id } as never);
}

interface ScriptedTurn {
  toolCalls: { name: string; args: Record<string, unknown> }[];
}

/** A scripted client that returns a fixed sequence of tool calls, each "costing" 100 tokens. */
function makeScriptedClient(turns: ScriptedTurn[]): OpenAI {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const turn = turns[callIndex];
          callIndex += 1;
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: turn.toolCalls.map((tc, i) => ({
                    id: `call_${callIndex}_${i}`,
                    type: "function",
                    function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                  })),
                },
              },
            ],
            usage: { total_tokens: 100, prompt_tokens: 80, completion_tokens: 20 },
          };
        },
      },
    },
  } as unknown as OpenAI;
}

export const progressTests: Test[] = [
  {
    name: "runAgentForLead reports thinking + tool_call progress events with accumulating token counts",
    run: async () => {
      const db = createTestDb();
      seedMinimalLead(db, 1);

      const stubClient = makeScriptedClient([
        { toolCalls: [{ name: "log_note", args: { lead_id: 1, note: "reviewing lead" } }] },
        { toolCalls: [{ name: "escalate_to_agent", args: { lead_id: 1, reason: "test scenario" } }] },
      ]);

      const events: RunProgress[] = [];
      const result = await runAgentForLead(db, 1, stubClient, undefined, (p) => events.push(p));

      assertTrue(result.outcome.kind === "escalated", `expected escalated outcome, got ${result.outcome.kind}`);

      const thinkingEvents = events.filter((e) => e.phase === "thinking");
      const toolCallEvents = events.filter((e) => e.phase === "tool_call");

      assertTrue(thinkingEvents.length === 2, `expected 2 'thinking' events (one per turn), got ${thinkingEvents.length}`);
      assertTrue(toolCallEvents.length === 2, `expected 2 'tool_call' events, got ${toolCallEvents.length}`);
      assertTrue(toolCallEvents[0].toolName === "log_note", `expected first tool_call event for log_note, got ${toolCallEvents[0].toolName}`);
      assertTrue(
        toolCallEvents[1].toolName === "escalate_to_agent",
        `expected second tool_call event for escalate_to_agent, got ${toolCallEvents[1].toolName}`
      );

      // tokensSoFar should reflect tokens accumulated up to and including that turn's completion.
      assertTrue(toolCallEvents[0].tokensSoFar === 100, `expected 100 tokens after first turn, got ${toolCallEvents[0].tokensSoFar}`);
      assertTrue(toolCallEvents[1].tokensSoFar === 200, `expected 200 tokens after second turn, got ${toolCallEvents[1].tokensSoFar}`);
      assertTrue(thinkingEvents[0].tokensSoFar === 0, "expected 0 tokens reported before the very first completion arrives");
    },
  },
];
