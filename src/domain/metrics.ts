import type { DatabaseSync } from "node:sqlite";
import { listRunMetrics } from "../db/queries.js";

export interface AggregateMetrics {
  totalRuns: number;
  escalationRate: number;
  avgToolCallsPerRun: number;
  totalEstimatedCost: number;
  avgApprovalTurnaroundMs: number | null;
}

/**
 * Derived from run_metrics (agent-run level stats) and proposals/audit_log
 * (human turnaround time) -- a lightweight first step toward "how is this
 * system actually behaving", not a real observability stack.
 */
export function computeAggregateMetrics(db: DatabaseSync): AggregateMetrics {
  const runs = listRunMetrics(db);
  const totalRuns = runs.length;
  const escalations = runs.filter((r) => r.outcome === "escalated").length;
  const escalationRate = totalRuns ? escalations / totalRuns : 0;
  const avgToolCallsPerRun = totalRuns ? runs.reduce((sum, r) => sum + r.tool_call_count, 0) / totalRuns : 0;
  const totalEstimatedCost = runs.reduce((sum, r) => sum + r.estimated_token_cost, 0);

  const proposals = db.prepare("SELECT id, created_at FROM proposals").all() as { id: number; created_at: string }[];
  const resolutions = db
    .prepare("SELECT input_json, timestamp FROM audit_log WHERE tool_name IN ('approve_proposal', 'reject_proposal')")
    .all() as { input_json: string; timestamp: string }[];

  const turnaroundsMs: number[] = [];
  for (const proposal of proposals) {
    const matches = resolutions
      .filter((r) => {
        try {
          return (JSON.parse(r.input_json) as { proposal_id?: number }).proposal_id === proposal.id;
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (matches.length === 0) continue;
    const delta = new Date(matches[0].timestamp).getTime() - new Date(proposal.created_at).getTime();
    turnaroundsMs.push(delta);
  }
  const avgApprovalTurnaroundMs =
    turnaroundsMs.length > 0 ? turnaroundsMs.reduce((a, b) => a + b, 0) / turnaroundsMs.length : null;

  return { totalRuns, escalationRate, avgToolCallsPerRun, totalEstimatedCost, avgApprovalTurnaroundMs };
}
