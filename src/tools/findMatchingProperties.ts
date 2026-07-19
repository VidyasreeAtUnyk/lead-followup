import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { getLead, listProperties } from "../db/queries.js";
import { ToolError } from "../domain/errors.js";

const schema = z.object({
  lead_id: z.number().int().positive(),
});

/**
 * Plain structured SQL-style filtering over the properties table -- budget,
 * location, type, bedrooms. Deliberately not RAG/embeddings (out of scope).
 * If the lead has no budget, location, or property type on file we refuse to
 * guess and return insufficient_profile so the agent asks discovery
 * questions instead of pitching a random listing.
 */
export const findMatchingProperties: ToolDefinition<z.infer<typeof schema>> = {
  name: "find_matching_properties",
  description:
    "Filter the properties table by the lead's budget/location/property type/bedrooms. Returns { status: 'insufficient_profile' } if the lead has none of budget, location_pref, or property_interest on file -- do not guess a listing in that case.",
  schema,
  execute: (db, input) => {
    const lead = getLead(db, input.lead_id);
    if (!lead) throw new ToolError("NOT_FOUND", `No lead with id ${input.lead_id}.`);

    if (!lead.budget && !lead.location_pref && !lead.property_interest) {
      return { status: "insufficient_profile" as const };
    }

    const all = listProperties(db);
    const preferredTier = lead.segment === "client" ? "upgrade" : "standard";

    const matches = all.filter((p) => {
      if (lead.budget && p.price > lead.budget * 1.1) return false;
      if (lead.location_pref && !p.area.toLowerCase().includes(lead.location_pref.toLowerCase())) return false;
      if (lead.property_interest && !p.type.toLowerCase().includes(lead.property_interest.toLowerCase())) return false;
      return true;
    });

    const sorted = [...matches].sort((a, b) => {
      const aTier = a.tier === preferredTier ? 0 : 1;
      const bTier = b.tier === preferredTier ? 0 : 1;
      return aTier - bTier;
    });

    return { status: "ok" as const, properties: sorted };
  },
};
