import type OpenAI from "openai";
import { TOOLS } from "../tools/index.js";

/**
 * OpenAI function-calling tool definitions, one per domain tool. Written by
 * hand (rather than derived from the Zod schemas) so the JSON Schema sent to
 * the model is exactly what we intend -- the Zod schema remains the runtime
 * source of truth and is re-validated in dispatchToolCall regardless of what
 * the model sends.
 */
const PARAMETERS: Record<string, OpenAI.FunctionParameters> = {
  get_lead_context: {
    type: "object",
    properties: { lead_id: { type: "integer" } },
    required: ["lead_id"],
    additionalProperties: false,
  },
  check_contact_eligibility: {
    type: "object",
    properties: { lead_id: { type: "integer" } },
    required: ["lead_id"],
    additionalProperties: false,
  },
  find_matching_properties: {
    type: "object",
    properties: { lead_id: { type: "integer" } },
    required: ["lead_id"],
    additionalProperties: false,
  },
  get_property_market_data: {
    type: "object",
    properties: { property_id: { type: "integer" } },
    required: ["property_id"],
    additionalProperties: false,
  },
  propose_message: {
    type: "object",
    properties: {
      lead_id: { type: "integer" },
      draft: { type: "string", description: "The full drafted outreach message text." },
    },
    required: ["lead_id", "draft"],
    additionalProperties: false,
  },
  propose_viewing: {
    type: "object",
    properties: {
      lead_id: { type: "integer" },
      proposed_time: { type: "string", description: "Human-readable proposed viewing date/time." },
    },
    required: ["lead_id", "proposed_time"],
    additionalProperties: false,
  },
  send_message: {
    type: "object",
    properties: { proposal_id: { type: "integer" } },
    required: ["proposal_id"],
    additionalProperties: false,
  },
  reactivate_lead: {
    type: "object",
    properties: {
      lead_id: { type: "integer" },
      evidence_interaction_id: { type: "integer" },
    },
    required: ["lead_id", "evidence_interaction_id"],
    additionalProperties: false,
  },
  escalate_to_agent: {
    type: "object",
    properties: {
      lead_id: { type: "integer" },
      reason: { type: "string" },
    },
    required: ["lead_id", "reason"],
    additionalProperties: false,
  },
  log_note: {
    type: "object",
    properties: {
      lead_id: { type: "integer" },
      note: { type: "string" },
    },
    required: ["lead_id", "note"],
    additionalProperties: false,
  },
};

export const OPENAI_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = TOOLS.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: PARAMETERS[tool.name] ?? { type: "object", properties: {} },
  },
}));
