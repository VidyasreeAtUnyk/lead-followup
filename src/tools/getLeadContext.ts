import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { getLead, listInteractions, listProposals } from "../db/queries.js";
import { ToolError } from "../domain/errors.js";

const schema = z.object({
  lead_id: z.number().int().positive(),
});

export const getLeadContext: ToolDefinition<z.infer<typeof schema>> = {
  name: "get_lead_context",
  description:
    "Fetch the full record for a lead plus its complete interaction history and any past proposals. Always call this first for a lead you haven't seen yet in this run.",
  schema,
  execute: (db, input) => {
    const lead = getLead(db, input.lead_id);
    if (!lead) throw new ToolError("NOT_FOUND", `No lead with id ${input.lead_id}.`);
    const interactions = listInteractions(db, input.lead_id);
    const proposals = listProposals(db, { lead_id: input.lead_id });
    return { lead, interactions, proposals };
  },
};
