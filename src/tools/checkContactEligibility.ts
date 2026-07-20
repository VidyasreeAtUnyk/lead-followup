import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { getLead, countSendsInWindow } from "../db/queries.js";
import { ToolError } from "../domain/errors.js";
import { canReactivateFrom } from "../domain/stateMachine.js";
import { CONTACT_WINDOW_DAYS, MAX_SENDS_IN_WINDOW } from "../config/limits.js";

const schema = z.object({
  lead_id: z.number().int().positive(),
});

/**
 * Advisory only -- this is NOT where any guardrail is enforced. It exists so
 * the agent can reason about whether outreach is a good idea before spending
 * a propose_message/send_message call. The real enforcement for do_not_contact,
 * stage legality, and the rate cap lives inside propose_message/propose_viewing
 * and send_message themselves, in code the model cannot bypass.
 */
export const checkContactEligibility: ToolDefinition<z.infer<typeof schema>> = {
  name: "check_contact_eligibility",
  description:
    "Advisory check for whether a lead looks contactable right now (not a hard guardrail -- propose_message/send_message enforce the real rules regardless of what this returns).",
  schema,
  execute: (db, input) => {
    const lead = getLead(db, input.lead_id);
    if (!lead) throw new ToolError("NOT_FOUND", `No lead with id ${input.lead_id}.`);

    if (lead.do_not_contact) {
      return { eligible: false, reason: "Lead is marked do_not_contact." };
    }
    if (canReactivateFrom(lead.stage)) {
      return {
        eligible: false,
        reason: `Lead is in stage '${lead.stage}' and requires reactivate_lead with evidence before outreach.`,
      };
    }
    const since = new Date(Date.now() - CONTACT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const sends = countSendsInWindow(db, input.lead_id, since);
    if (sends >= MAX_SENDS_IN_WINDOW) {
      return {
        eligible: false,
        reason: `Already sent ${sends} messages in the last ${CONTACT_WINDOW_DAYS} days (cap is ${MAX_SENDS_IN_WINDOW}).`,
      };
    }
    return { eligible: true };
  },
};
