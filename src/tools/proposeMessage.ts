import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { getLead, insertProposal } from "../db/queries.js";
import { ToolError } from "../domain/errors.js";
import { checkNumericGrounding } from "../domain/grounding.js";

const schema = z.object({
  lead_id: z.number().int().positive(),
  draft: z.string().min(1),
});

export const proposeMessage: ToolDefinition<z.infer<typeof schema>> = {
  name: "propose_message",
  description:
    "Write a draft outreach message as a pending proposal for human approval. This does NOT contact the lead. Any $ or % figures in the draft must match the most recent get_property_market_data figures for this lead -- do not invent numbers.",
  schema,
  execute: (db, input) => {
    const lead = getLead(db, input.lead_id);
    if (!lead) throw new ToolError("NOT_FOUND", `No lead with id ${input.lead_id}.`);

    if (lead.do_not_contact) {
      throw new ToolError(
        "DO_NOT_CONTACT",
        `Lead ${input.lead_id} is marked do_not_contact. No proposal may be created for this lead -- escalate_to_agent instead.`
      );
    }
    if (lead.stage === "dormant" || lead.stage === "canceled") {
      throw new ToolError(
        "INVALID_TRANSITION",
        `Lead is in stage '${lead.stage}'. Call reactivate_lead with valid evidence before proposing outreach.`
      );
    }

    checkNumericGrounding(db, input.lead_id, input.draft);

    return insertProposal(db, { lead_id: input.lead_id, type: "message", content: input.draft });
  },
};
