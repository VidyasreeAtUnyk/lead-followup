import type { DatabaseSync } from "node:sqlite";
import type { Lead } from "../domain/types.js";
import { listLeads, listProposals, isParkedOnEscalation } from "../db/queries.js";

/**
 * Candidate leads for the agent to work: not already closed won/lost, no
 * proposal currently awaiting human approval, and not already parked on a
 * prior escalation this run cycle hasn't resolved.
 */
export function getQueue(db: DatabaseSync): Lead[] {
  return listLeads(db).filter((lead) => {
    if (lead.stage === "won" || lead.stage === "lost") return false;
    const pending = listProposals(db, { lead_id: lead.id, status: "pending" });
    if (pending.length > 0) return false;
    if (isParkedOnEscalation(db, lead.id)) return false;
    return true;
  });
}
