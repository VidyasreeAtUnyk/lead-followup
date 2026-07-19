import type { DatabaseSync } from "node:sqlite";
import OpenAI from "openai";
import { OPENAI_TOOLS } from "./openaiTools.js";
import { buildSystemPrompt, buildUserTurn } from "./prompts.js";
import { dispatchToolCall } from "../tools/index.js";
import { getLead } from "../db/queries.js";

const TERMINAL_TOOLS = new Set(["propose_message", "propose_viewing", "send_message", "escalate_to_agent"]);
const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
const MAX_ASSISTANT_TURNS = 8;

export type RunOutcome =
  | { kind: "awaiting_approval"; toolName: string }
  | { kind: "sent" }
  | { kind: "escalated"; reason?: string }
  | { kind: "no_action_taken" };

export interface RunResult {
  leadId: number;
  outcome: RunOutcome;
  assistantTurns: number;
}

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Export it before running the agent (see README)."
    );
  }
  return new OpenAI({ apiKey });
}

/**
 * Processes exactly one lead for one run: load -> let the model choose tool
 * calls step by step, persisting after each one -> stop as soon as the lead
 * reaches a state that requires waiting (a pending proposal), is terminal for
 * this run (escalated), or a message was actually sent. Every side effect is
 * committed to SQLite as it happens, so killing the process at any point and
 * calling this again for the same leadId resumes coherently: get_lead_context
 * will simply reflect whatever already went through.
 */
export async function runAgentForLead(db: DatabaseSync, leadId: number, client: OpenAI = getClient()): Promise<RunResult> {
  const lead = getLead(db, leadId);
  if (!lead) throw new Error(`No lead with id ${leadId}`);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserTurn(leadId) },
  ];

  let turns = 0;
  let noToolCallStreak = 0;

  while (turns < MAX_ASSISTANT_TURNS) {
    turns += 1;
    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages,
      tools: OPENAI_TOOLS,
      tool_choice: "auto",
    });

    const choice = completion.choices[0];
    const message = choice.message;
    messages.push(message);

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      noToolCallStreak += 1;
      if (noToolCallStreak >= 2) {
        const result = dispatchToolCall(db, leadId, "escalate_to_agent", {
          lead_id: leadId,
          reason: `Agent stopped calling tools without reaching a decision. Last message: ${message.content ?? "(empty)"}`,
        });
        void result;
        return { leadId, outcome: { kind: "escalated", reason: "no_tool_call" }, assistantTurns: turns };
      }
      messages.push({
        role: "user",
        content:
          "You must end this turn by calling exactly one of: propose_message, propose_viewing, send_message, reactivate_lead, or escalate_to_agent. Call a tool now.",
      });
      continue;
    }
    noToolCallStreak = 0;

    for (const toolCall of toolCalls) {
      if (toolCall.type !== "function") continue;
      let args: unknown = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        args = {};
      }

      const result = dispatchToolCall(db, leadId, toolCall.function.name, args);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result.output),
      });

      if (result.ok && TERMINAL_TOOLS.has(toolCall.function.name)) {
        if (toolCall.function.name === "send_message") {
          return { leadId, outcome: { kind: "sent" }, assistantTurns: turns };
        }
        if (toolCall.function.name === "escalate_to_agent") {
          const output = result.output as { reason?: string };
          return { leadId, outcome: { kind: "escalated", reason: output.reason }, assistantTurns: turns };
        }
        return { leadId, outcome: { kind: "awaiting_approval", toolName: toolCall.function.name }, assistantTurns: turns };
      }
    }
  }

  const safetyNet = dispatchToolCall(db, leadId, "escalate_to_agent", {
    lead_id: leadId,
    reason: `Agent loop exceeded ${MAX_ASSISTANT_TURNS} turns without reaching a stopping point.`,
  });
  void safetyNet;
  return { leadId, outcome: { kind: "escalated", reason: "max_turns_exceeded" }, assistantTurns: turns };
}
