import type { FunctionDeclaration } from "@google/genai";
import { TOOLS } from "../tools/index.js";

/**
 * Gemini's equivalent of openaiTools.ts. Deliberately a separate, standalone
 * file rather than importing/reusing openaiTools.ts's internals -- this
 * whole experiment branch is meant to sit alongside the graded OpenAI
 * implementation without touching it, so the two tool-schema files are
 * intentionally duplicated rather than shared.
 *
 * Uses `parametersJsonSchema` (plain JSON Schema, mutually exclusive with
 * Gemini's own `parameters`/`Schema` enum-based format) so the same JSON
 * Schema shapes used for the OpenAI tools work here unchanged.
 */
const PARAMETERS: Record<string, unknown> = {
  get_lead_context: {
    type: "object",
    properties: { lead_id: { type: "integer" } },
    required: ["lead_id"],
  },
  check_contact_eligibility: {
    type: "object",
    properties: { lead_id: { type: "integer" } },
    required: ["lead_id"],
  },
  find_matching_properties: {
    type: "object",
    properties: { lead_id: { type: "integer" } },
    required: ["lead_id"],
  },
  get_property_market_data: {
    type: "object",
    properties: { property_id: { type: "integer" } },
    required: ["property_id"],
  },
  propose_message: {
    type: "object",
    properties: {
      lead_id: { type: "integer" },
      draft: { type: "string", description: "The full drafted outreach message text." },
    },
    required: ["lead_id", "draft"],
  },
  propose_viewing: {
    type: "object",
    properties: {
      lead_id: { type: "integer" },
      proposed_time: { type: "string", description: "Human-readable proposed viewing date/time." },
    },
    required: ["lead_id", "proposed_time"],
  },
  send_message: {
    type: "object",
    properties: { proposal_id: { type: "integer" } },
    required: ["proposal_id"],
  },
  reactivate_lead: {
    type: "object",
    properties: {
      lead_id: { type: "integer" },
      evidence_interaction_id: { type: "integer" },
    },
    required: ["lead_id", "evidence_interaction_id"],
  },
  escalate_to_agent: {
    type: "object",
    properties: {
      lead_id: { type: "integer" },
      reason: { type: "string" },
    },
    required: ["lead_id", "reason"],
  },
  log_note: {
    type: "object",
    properties: {
      lead_id: { type: "integer" },
      note: { type: "string" },
    },
    required: ["lead_id", "note"],
  },
};

export const GEMINI_FUNCTION_DECLARATIONS: FunctionDeclaration[] = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parametersJsonSchema: PARAMETERS[tool.name] ?? { type: "object", properties: {} },
}));
