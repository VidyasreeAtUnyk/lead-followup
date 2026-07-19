import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { getLead } from "../db/queries.js";
import { ToolError } from "../domain/errors.js";

const schema = z.object({
  lead_id: z.number().int().positive(),
  reason: z.string().min(1),
});

export const escalateToAgent: ToolDefinition<z.infer<typeof schema>> = {
  name: "escalate_to_agent",
  description:
    "Terminal action for this run: hand the lead to a human agent with a reason (e.g. contradictory signals, do_not_contact, anything you shouldn't decide autonomously). No further tool calls should be made for this lead this run.",
  schema,
  execute: (db, input) => {
    const lead = getLead(db, input.lead_id);
    if (!lead) throw new ToolError("NOT_FOUND", `No lead with id ${input.lead_id}.`);
    return { ok: true as const, lead_id: input.lead_id, escalated: true, reason: input.reason };
  },
};
