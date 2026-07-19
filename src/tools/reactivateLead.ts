import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { getLead, getInteraction, updateLead } from "../db/queries.js";
import { ToolError } from "../domain/errors.js";
import {
  canReactivateFrom,
  REACTIVATION_EVIDENCE_MAX_AGE_DAYS,
  REACTIVATION_EVIDENCE_TYPES,
} from "../domain/stateMachine.js";

const schema = z.object({
  lead_id: z.number().int().positive(),
  evidence_interaction_id: z.number().int().positive(),
});

/**
 * The only legal path back from dormant/canceled to contacted. The model
 * cannot simply assert "enough time has passed" -- it must cite a real,
 * recent, qualifying interaction row, and this tool independently verifies
 * that row exists and qualifies before moving the stage.
 */
export const reactivateLead: ToolDefinition<z.infer<typeof schema>> = {
  name: "reactivate_lead",
  description:
    "Move a dormant/canceled lead back to 'contacted'. Requires evidence_interaction_id referencing a real, recent inquiry/reply interaction for this lead. Fails with a typed error if the lead isn't in a reactivatable stage or the evidence doesn't qualify.",
  schema,
  execute: (db, input) => {
    const lead = getLead(db, input.lead_id);
    if (!lead) throw new ToolError("NOT_FOUND", `No lead with id ${input.lead_id}.`);

    if (!canReactivateFrom(lead.stage)) {
      throw new ToolError(
        "INVALID_TRANSITION",
        `Lead is in stage '${lead.stage}'. reactivate_lead only applies to leads in stage 'dormant' or 'canceled'.`
      );
    }

    const evidence = getInteraction(db, input.evidence_interaction_id);
    if (!evidence) {
      throw new ToolError("EVIDENCE_INVALID", `No interaction with id ${input.evidence_interaction_id} exists.`);
    }
    if (evidence.lead_id !== input.lead_id) {
      throw new ToolError(
        "EVIDENCE_INVALID",
        `Interaction ${input.evidence_interaction_id} belongs to a different lead, not ${input.lead_id}.`
      );
    }
    if (!(REACTIVATION_EVIDENCE_TYPES as readonly string[]).includes(evidence.type)) {
      throw new ToolError(
        "EVIDENCE_INVALID",
        `Interaction ${input.evidence_interaction_id} is of type '${evidence.type}'; reactivation requires one of: ${REACTIVATION_EVIDENCE_TYPES.join(", ")}.`
      );
    }
    const ageMs = Date.now() - new Date(evidence.timestamp).getTime();
    const maxAgeMs = REACTIVATION_EVIDENCE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    if (ageMs > maxAgeMs) {
      throw new ToolError(
        "EVIDENCE_INVALID",
        `Interaction ${input.evidence_interaction_id} is from ${evidence.timestamp}, older than the ${REACTIVATION_EVIDENCE_MAX_AGE_DAYS}-day freshness window required for reactivation.`
      );
    }

    updateLead(db, lead.id, { stage: "contacted" });
    return { ok: true as const, lead_id: lead.id, new_stage: "contacted" as const, evidence_interaction_id: evidence.id };
  },
};
