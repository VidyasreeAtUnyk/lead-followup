import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { getLead, insertProposal } from "../db/queries.js";
import { ToolError } from "../domain/errors.js";

const schema = z.object({
  lead_id: z.number().int().positive(),
  proposed_time: z.string().min(1),
});

export const proposeViewing: ToolDefinition<z.infer<typeof schema>> = {
  name: "propose_viewing",
  description:
    "Propose a property viewing for human approval. Only valid when the lead's stage is 'qualified'.",
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
    if (lead.stage !== "qualified") {
      throw new ToolError(
        "INVALID_TRANSITION",
        `propose_viewing requires stage 'qualified'; lead is currently '${lead.stage}'.`
      );
    }

    return insertProposal(db, {
      lead_id: input.lead_id,
      type: "viewing",
      content: `Property viewing proposed for ${input.proposed_time}`,
      proposed_time: input.proposed_time,
    });
  },
};
