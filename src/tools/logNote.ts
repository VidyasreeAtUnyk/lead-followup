import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { getLead } from "../db/queries.js";
import { ToolError } from "../domain/errors.js";

const schema = z.object({
  lead_id: z.number().int().positive(),
  note: z.string().min(1),
});

export const logNote: ToolDefinition<z.infer<typeof schema>> = {
  name: "log_note",
  description: "Record a free-form reasoning note against a lead. Always allowed, never mutates lead state.",
  schema,
  execute: (db, input) => {
    const lead = getLead(db, input.lead_id);
    if (!lead) throw new ToolError("NOT_FOUND", `No lead with id ${input.lead_id}.`);
    // The note itself is preserved in audit_log.input_json by the dispatcher --
    // no separate table needed since interactions.type has a fixed enum that
    // doesn't include "note".
    return { ok: true as const, logged: true };
  },
};
