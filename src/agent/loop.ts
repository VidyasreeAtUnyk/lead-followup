import type { DatabaseSync } from "node:sqlite";
import OpenAI from "openai";
import { OPENAI_TOOLS } from "./openaiTools.js";
import { buildSystemPrompt, buildUserTurn } from "./prompts.js";
import { dispatchToolCall } from "../tools/index.js";
import { getLead, insertRunMetric } from "../db/queries.js";
import { nowIso } from "../db/client.js";
import type { RunOutcomeKind } from "../domain/types.js";

const TERMINAL_TOOLS = new Set(["propose_message", "propose_viewing", "send_message", "escalate_to_agent"]);
const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
const MAX_ASSISTANT_TURNS = 8;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
// Rough blended estimate, not real pricing -- good enough to compare run cost
// relatively (e.g. "this run cost 3x that one"), not to reconcile a bill.
const ESTIMATED_COST_PER_TOKEN = 0.0000005;

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: unknown): boolean {
  return status === 429 || (typeof status === "number" && status >= 500 && status < 600);
}

// If the API tells us how long to wait and it's longer than this, no amount
// of in-process backoff will make the retry succeed before the caller gives
// up anyway (e.g. a daily quota that resets in 20+ minutes, not 10 seconds).
// Retrying anyway just burns more requests against the same exhausted quota
// for zero chance of success -- fail fast instead.
const MAX_WORTHWHILE_RETRY_AFTER_SECONDS = 30;

function retryAfterSeconds(e: unknown): number | null {
  const headers = (e as { headers?: Record<string, string> })?.headers;
  const raw = headers?.["retry-after"];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Exponential backoff with jitter on 429/5xx only -- anything else (bad
 * request, auth failure, etc.) is not transient and is rethrown immediately
 * so we don't waste turns retrying something that will never succeed. Also
 * fails fast (no retries at all) when the server's own retry-after says the
 * wait would be pointless within this run -- see MAX_WORTHWHILE_RETRY_AFTER_SECONDS.
 */
async function createCompletionWithRetry(
  client: OpenAI,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  opts: RetryOptions = {}
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return (await client.chat.completions.create(params)) as OpenAI.Chat.Completions.ChatCompletion;
    } catch (e) {
      lastError = e;
      const status = (e as { status?: unknown })?.status;
      if (!isRetryableStatus(status)) throw e;
      const waitSeconds = retryAfterSeconds(e);
      if (waitSeconds !== null && waitSeconds > MAX_WORTHWHILE_RETRY_AFTER_SECONDS) throw e;
      if (attempt === maxRetries) throw e;
      const backoff = baseDelayMs * 2 ** attempt;
      const jittered = backoff / 2 + Math.random() * (backoff / 2);
      await sleep(jittered);
    }
  }
  throw lastError;
}

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

export interface RunProgress {
  turn: number;
  phase: "thinking" | "tool_call";
  toolName?: string;
  tokensSoFar: number;
}

export type ProgressCallback = (progress: RunProgress) => void;

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
 *
 * Public entry point used by every caller (CLI, runQueue, evals, tests).
 * Delegates to the Gemini implementation (experiment branch only --
 * src/agent/loopGemini.ts) when MODEL_PROVIDER=gemini, dynamically imported
 * so the OpenAI path never needs @google/genai loaded or GEMINI_API_KEY set,
 * and vice versa. Default behavior (no env var set) is unchanged: OpenAI,
 * exactly as before.
 *
 * An explicitly-passed `client` always wins over MODEL_PROVIDER, regardless
 * of what's in the environment: passing a client is a deliberate override
 * signal (this is exactly how tests inject a stub), and honoring it
 * unconditionally is what makes those tests deterministic no matter what a
 * developer's local .env happens to have set for their own manual testing.
 */
export async function runAgentForLead(
  db: DatabaseSync,
  leadId: number,
  client?: OpenAI,
  retryOpts: RetryOptions = {},
  onProgress?: ProgressCallback
): Promise<RunResult> {
  if (!client && process.env.MODEL_PROVIDER === "gemini") {
    const { runAgentForLeadGemini } = await import("./loopGemini.js");
    return runAgentForLeadGemini(db, leadId, retryOpts, onProgress);
  }
  return runAgentForLeadOpenAI(db, leadId, client ?? getClient(), retryOpts, onProgress);
}

async function runAgentForLeadOpenAI(
  db: DatabaseSync,
  leadId: number,
  client: OpenAI,
  retryOpts: RetryOptions,
  onProgress?: ProgressCallback
): Promise<RunResult> {
  const lead = getLead(db, leadId);
  if (!lead) throw new Error(`No lead with id ${leadId}`);

  const startedAt = nowIso();
  let toolCallCount = 0;
  let totalTokens = 0;

  function finish(outcome: RunOutcome, turns: number): RunResult {
    const outcomeToMetric: Record<RunOutcome["kind"], RunOutcomeKind> = {
      awaiting_approval: "proposal_created",
      sent: "sent",
      escalated: "escalated",
      no_action_taken: "no_action",
    };
    insertRunMetric(db, {
      lead_id: leadId,
      started_at: startedAt,
      ended_at: nowIso(),
      outcome: outcomeToMetric[outcome.kind],
      tool_call_count: toolCallCount,
      estimated_token_cost: totalTokens * ESTIMATED_COST_PER_TOKEN,
    });
    return { leadId, outcome, assistantTurns: turns };
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserTurn(leadId) },
  ];

  let turns = 0;
  let noToolCallStreak = 0;

  while (turns < MAX_ASSISTANT_TURNS) {
    turns += 1;
    onProgress?.({ turn: turns, phase: "thinking", tokensSoFar: totalTokens });

    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await createCompletionWithRetry(
        client,
        { model: DEFAULT_MODEL, messages, tools: OPENAI_TOOLS, tool_choice: "auto" },
        retryOpts
      );
    } catch (e) {
      // The LLM call itself failed after retries were exhausted -- this must
      // never crash the process or leave the lead mid-mutation. Escalate
      // gracefully with a clear reason instead.
      const message = e instanceof Error ? e.message : String(e);
      toolCallCount += 1;
      dispatchToolCall(db, leadId, "escalate_to_agent", {
        lead_id: leadId,
        reason: `LLM call failed after retries: ${message}`,
        system_triggered: true,
      });
      onProgress?.({ turn: turns, phase: "tool_call", toolName: "escalate_to_agent", tokensSoFar: totalTokens });
      return finish({ kind: "escalated", reason: "llm_call_failed" }, turns);
    }

    totalTokens += completion.usage?.total_tokens ?? 0;

    const choice = completion.choices[0];
    const message = choice.message;
    messages.push(message);

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      noToolCallStreak += 1;
      if (noToolCallStreak >= 2) {
        toolCallCount += 1;
        dispatchToolCall(db, leadId, "escalate_to_agent", {
          lead_id: leadId,
          reason: `Agent stopped calling tools without reaching a decision. Last message: ${message.content ?? "(empty)"}`,
          system_triggered: true,
        });
        onProgress?.({ turn: turns, phase: "tool_call", toolName: "escalate_to_agent", tokensSoFar: totalTokens });
        return finish({ kind: "escalated", reason: "no_tool_call" }, turns);
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

      toolCallCount += 1;
      const result = dispatchToolCall(db, leadId, toolCall.function.name, args);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result.output),
      });
      onProgress?.({ turn: turns, phase: "tool_call", toolName: toolCall.function.name, tokensSoFar: totalTokens });

      if (result.ok && TERMINAL_TOOLS.has(toolCall.function.name)) {
        if (toolCall.function.name === "send_message") {
          return finish({ kind: "sent" }, turns);
        }
        if (toolCall.function.name === "escalate_to_agent") {
          const output = result.output as { reason?: string };
          return finish({ kind: "escalated", reason: output.reason }, turns);
        }
        return finish({ kind: "awaiting_approval", toolName: toolCall.function.name }, turns);
      }
    }
  }

  toolCallCount += 1;
  dispatchToolCall(db, leadId, "escalate_to_agent", {
    lead_id: leadId,
    reason: `Agent loop exceeded ${MAX_ASSISTANT_TURNS} turns without reaching a stopping point.`,
    system_triggered: true,
  });
  onProgress?.({ turn: turns, phase: "tool_call", toolName: "escalate_to_agent", tokensSoFar: totalTokens });
  return finish({ kind: "escalated", reason: "max_turns_exceeded" }, turns);
}
