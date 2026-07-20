import type { DatabaseSync } from "node:sqlite";
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { GEMINI_FUNCTION_DECLARATIONS } from "./geminiTools.js";
import { buildSystemPrompt, buildUserTurn } from "./prompts.js";
import { dispatchToolCall } from "../tools/index.js";
import { getLead, insertRunMetric } from "../db/queries.js";
import { nowIso } from "../db/client.js";
import type { RunOutcomeKind } from "../domain/types.js";
import type { RunResult, RunOutcome, ProgressCallback, RetryOptions, RateLimitInfo } from "./loop.js";

/**
 * Gemini equivalent of runAgentForLead (src/agent/loop.ts). Experiment-branch
 * only -- exists purely to demonstrate the same guardrails/loop/audit trail
 * work identically regardless of which model is doing the choosing, without
 * touching the graded OpenAI implementation at all. Deliberately duplicates
 * the turn-loop control flow rather than sharing it with loop.ts, so this
 * file can be deleted wholesale with zero risk to the OpenAI path.
 */

const TERMINAL_TOOLS = new Set(["propose_message", "propose_viewing", "send_message", "escalate_to_agent"]);
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
const MAX_ASSISTANT_TURNS = 8;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
// Rough blended estimate for Gemini Flash-tier pricing, not exact -- same
// "compare runs relatively" caveat as loop.ts's OpenAI estimate.
const ESTIMATED_COST_PER_TOKEN = 0.0000002;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: unknown): boolean {
  return status === 429 || (typeof status === "number" && status >= 500 && status < 600);
}

/**
 * Best-effort quota info for Gemini. Unlike OpenAI, the Gemini SDK exposes no
 * x-ratelimit-* headers on a successful response -- there is nothing to
 * capture on the happy path, full stop. The only place quota numbers show up
 * at all is inside a RESOURCE_EXHAUSTED (429) error's message text (a raw
 * JSON blob embedded in the string), so this only ever returns something on
 * that failure path, and only when the fields it looks for are actually
 * present. A miss returns undefined rather than a fabricated guess -- callers
 * must treat an absent RateLimitInfo as "unknown," not "quota is fine."
 */
function extractGeminiQuotaInfo(e: unknown): RateLimitInfo | undefined {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const quotaMatch = message.match(/"quotaValue"\s*:\s*"(\d+)"/);
  const retryDelayMatch = message.match(/"retryDelay"\s*:\s*"([^"]+)"/);
  const isExhausted = /RESOURCE_EXHAUSTED/.test(message);
  if (!isExhausted && !quotaMatch) return undefined;
  if (!quotaMatch && !retryDelayMatch) return undefined;
  return {
    limitRequests: quotaMatch ? Number(quotaMatch[1]) : undefined,
    // RESOURCE_EXHAUSTED means the bucket that tripped is at 0 right now --
    // this doesn't tell us which bucket (per-minute vs. per-day), only that
    // whichever one fired is exhausted.
    remainingRequests: isExhausted ? 0 : undefined,
    resetRequests: retryDelayMatch ? retryDelayMatch[1] : undefined,
    capturedAt: nowIso(),
  };
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set. Export it before running with MODEL_PROVIDER=gemini.");
  }
  return new GoogleGenAI({ apiKey });
}

async function generateWithRetry(
  ai: GoogleGenAI,
  params: { model: string; contents: Content[]; config: Record<string, unknown> },
  opts: RetryOptions,
  onRateLimitInfo?: (info: RateLimitInfo) => void
) {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await ai.models.generateContent(params as any);
    } catch (e) {
      lastError = e;
      const info = extractGeminiQuotaInfo(e);
      if (info) onRateLimitInfo?.(info);
      const status = (e as { status?: unknown })?.status;
      if (!isRetryableStatus(status) || attempt === maxRetries) throw e;
      const backoff = baseDelayMs * 2 ** attempt;
      const jittered = backoff / 2 + Math.random() * (backoff / 2);
      await sleep(jittered);
    }
  }
  throw lastError;
}

export async function runAgentForLeadGemini(
  db: DatabaseSync,
  leadId: number,
  retryOpts: RetryOptions = {},
  onProgress?: ProgressCallback,
  ai: GoogleGenAI = getGeminiClient()
): Promise<RunResult> {
  const lead = getLead(db, leadId);
  if (!lead) throw new Error(`No lead with id ${leadId}`);

  const startedAt = nowIso();
  let toolCallCount = 0;
  let totalTokens = 0;
  let lastRateLimitInfo: RateLimitInfo | undefined;

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
    return { leadId, outcome, assistantTurns: turns, rateLimitInfo: lastRateLimitInfo };
  }

  const contents: Content[] = [{ role: "user", parts: [{ text: buildUserTurn(leadId) }] }];

  let turns = 0;
  let noToolCallStreak = 0;

  while (turns < MAX_ASSISTANT_TURNS) {
    turns += 1;
    onProgress?.({ turn: turns, phase: "thinking", tokensSoFar: totalTokens });

    let response;
    try {
      response = await generateWithRetry(
        ai,
        {
          model: DEFAULT_GEMINI_MODEL,
          contents,
          config: {
            systemInstruction: buildSystemPrompt(),
            tools: [{ functionDeclarations: GEMINI_FUNCTION_DECLARATIONS }],
            automaticFunctionCalling: { disable: true },
          },
        },
        retryOpts,
        (info) => {
          lastRateLimitInfo = info;
        }
      );
    } catch (e) {
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

    totalTokens += response.usageMetadata?.totalTokenCount ?? 0;

    const functionCalls = response.functionCalls ?? [];
    if (functionCalls.length === 0) {
      noToolCallStreak += 1;
      contents.push({ role: "model", parts: [{ text: response.text ?? "" }] });
      if (noToolCallStreak >= 2) {
        toolCallCount += 1;
        dispatchToolCall(db, leadId, "escalate_to_agent", {
          lead_id: leadId,
          reason: `Agent stopped calling tools without reaching a decision. Last message: ${response.text ?? "(empty)"}`,
          system_triggered: true,
        });
        onProgress?.({ turn: turns, phase: "tool_call", toolName: "escalate_to_agent", tokensSoFar: totalTokens });
        return finish({ kind: "escalated", reason: "no_tool_call" }, turns);
      }
      contents.push({
        role: "user",
        parts: [
          {
            text: "You must end this turn by calling exactly one of: propose_message, propose_viewing, send_message, reactivate_lead, or escalate_to_agent. Call a tool now.",
          },
        ],
      });
      continue;
    }
    noToolCallStreak = 0;

    // Echo back the model's own parts verbatim (not reconstructed from just
    // the functionCalls getter) -- Gemini attaches an opaque thoughtSignature
    // to each functionCall part and rejects the next turn with a 400 if it's
    // missing when that call is echoed back into history.
    const modelParts: Part[] = response.candidates?.[0]?.content?.parts ?? functionCalls.map((fc) => ({ functionCall: fc }));
    contents.push({ role: "model", parts: modelParts });

    const responseParts: Part[] = [];
    for (const fc of functionCalls) {
      const name = fc.name ?? "";
      const args = fc.args ?? {};

      toolCallCount += 1;
      const result = dispatchToolCall(db, leadId, name, args);
      responseParts.push({
        functionResponse: { id: fc.id, name, response: { result: result.output } },
      });
      onProgress?.({ turn: turns, phase: "tool_call", toolName: name, tokensSoFar: totalTokens });

      if (result.ok && TERMINAL_TOOLS.has(name)) {
        if (name === "send_message") {
          return finish({ kind: "sent" }, turns);
        }
        if (name === "escalate_to_agent") {
          const output = result.output as { reason?: string };
          return finish({ kind: "escalated", reason: output.reason }, turns);
        }
        return finish({ kind: "awaiting_approval", toolName: name }, turns);
      }
    }

    contents.push({ role: "user", parts: responseParts });
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
