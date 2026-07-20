import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { getLead, getProposal, listInteractions, updateLead, countSendsInWindow } from "../db/queries.js";
import { nowIso } from "../db/client.js";
import { ToolError } from "../domain/errors.js";
import { nextStageAfterMessageSend, nextStageAfterViewingSend } from "../domain/stateMachine.js";
import { CONTACT_WINDOW_DAYS, MAX_SENDS_IN_WINDOW } from "../config/limits.js";

const schema = z.object({
  proposal_id: z.number().int().positive(),
});

export const sendMessage: ToolDefinition<z.infer<typeof schema>> = {
  name: "send_message",
  description:
    "Execute contact for a proposal that a human has already approved. This is mocked (logs MOCK SEND, no real integration). Fails if the proposal is not approved, the lead is do_not_contact, or the lead has already hit the outreach rate cap.",
  schema,
  execute: (db, input) => {
    const proposal = getProposal(db, input.proposal_id);
    if (!proposal) throw new ToolError("NOT_FOUND", `No proposal with id ${input.proposal_id}.`);

    // Guardrail 1 (hard prohibition), part A: only an approved proposal can ever be sent.
    if (proposal.status !== "approved") {
      throw new ToolError(
        "NOT_APPROVED",
        `Proposal ${input.proposal_id} has status '${proposal.status}', not 'approved'. It cannot be sent.`
      );
    }

    const lead = getLead(db, proposal.lead_id);
    if (!lead) throw new ToolError("NOT_FOUND", `No lead with id ${proposal.lead_id}.`);

    // Guardrail 1, part B: do_not_contact is re-checked here independently of propose_message.
    if (lead.do_not_contact) {
      throw new ToolError("DO_NOT_CONTACT", `Lead ${lead.id} is marked do_not_contact. Refusing to send.`);
    }

    // Guardrail 2: stage legality. A lead that went dormant/canceled after the
    // proposal was created must be reactivated before it can be contacted.
    if (lead.stage === "dormant" || lead.stage === "canceled") {
      throw new ToolError(
        "INVALID_TRANSITION",
        `Lead is in stage '${lead.stage}'. Call reactivate_lead with valid evidence before sending.`
      );
    }

    // Guardrail 3: contact-frequency cap, rolling window, enforced regardless of the agent's plan.
    const since = new Date(Date.now() - CONTACT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const sendsInWindow = countSendsInWindow(db, lead.id, since);
    if (sendsInWindow >= MAX_SENDS_IN_WINDOW) {
      throw new ToolError(
        "RATE_LIMITED",
        `Lead ${lead.id} has already been sent ${sendsInWindow} messages in the last ${CONTACT_WINDOW_DAYS} days (cap is ${MAX_SENDS_IN_WINDOW}). Refusing to send another.`
      );
    }

    const interactions = listInteractions(db, lead.id);
    const hadRecentResponse = interactions.some(
      (i) =>
        (i.type === "reply" || i.type === "inquiry") &&
        (!lead.last_contacted_at || i.timestamp > lead.last_contacted_at)
    );

    const nextStage =
      proposal.type === "viewing" ? nextStageAfterViewingSend(lead.stage) : nextStageAfterMessageSend(lead, hadRecentResponse);

    const timestamp = nowIso();
    updateLead(db, lead.id, {
      last_contacted_at: timestamp,
      contact_count: lead.contact_count + 1,
      stage: nextStage,
    });

    const logLine = `MOCK SEND: ${proposal.content} to ${lead.contact}`;
    return {
      ok: true as const,
      mock_send_log: logLine,
      lead_id: lead.id,
      previous_stage: lead.stage,
      new_stage: nextStage,
    };
  },
};
