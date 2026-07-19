import type { DatabaseSync } from "node:sqlite";
import type {
  Lead,
  Interaction,
  Proposal,
  AuditLogRow,
  Property,
  PropertyPriceHistory,
  Actor,
  RunMetric,
  RunOutcomeKind,
} from "../domain/types.js";
import { nowIso } from "./client.js";

// node:sqlite's TS types don't export SQLInputValue/SQLOutputValue, so we
// bind params as `any` at the call boundary here and cast rows back to our
// own domain types -- this file is the only place that does so.
type Params = Record<string, unknown>;

function bind(params: Params) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return params as any;
}

function normalizeRow<T>(row: unknown): T {
  return row as T;
}

function normalizeRows<T>(rows: unknown[]): T[] {
  return rows as T[];
}

export function getLead(db: DatabaseSync, id: number): Lead | undefined {
  const row = db.prepare("SELECT * FROM leads WHERE id = $id").get(bind({ $id: id }));
  return row ? normalizeRow<Lead>(row) : undefined;
}

export function listLeads(db: DatabaseSync): Lead[] {
  return normalizeRows<Lead>(db.prepare("SELECT * FROM leads ORDER BY id").all());
}

export function updateLead(db: DatabaseSync, id: number, patch: Partial<Lead>): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = $${k}`).join(", ");
  const params: Params = { $id: id };
  for (const k of keys) params[`$${k}`] = (patch as Record<string, unknown>)[k];
  db.prepare(`UPDATE leads SET ${setClause} WHERE id = $id`).run(bind(params));
}

export function insertInteraction(
  db: DatabaseSync,
  input: { lead_id: number; type: Interaction["type"]; timestamp?: string; detail?: string | null }
): Interaction {
  const timestamp = input.timestamp ?? nowIso();
  const result = db
    .prepare(
      "INSERT INTO interactions (lead_id, type, timestamp, detail) VALUES ($lead_id, $type, $timestamp, $detail)"
    )
    .run(
      bind({
        $lead_id: input.lead_id,
        $type: input.type,
        $timestamp: timestamp,
        $detail: input.detail ?? null,
      })
    );
  return getInteraction(db, Number(result.lastInsertRowid))!;
}

export function getInteraction(db: DatabaseSync, id: number): Interaction | undefined {
  const row = db.prepare("SELECT * FROM interactions WHERE id = $id").get(bind({ $id: id }));
  return row ? normalizeRow<Interaction>(row) : undefined;
}

export function listInteractions(db: DatabaseSync, leadId: number): Interaction[] {
  return normalizeRows<Interaction>(
    db
      .prepare("SELECT * FROM interactions WHERE lead_id = $lead_id ORDER BY timestamp ASC, id ASC")
      .all(bind({ $lead_id: leadId }))
  );
}

export function insertProposal(
  db: DatabaseSync,
  input: { lead_id: number; type: Proposal["type"]; content: string; proposed_time?: string | null }
): Proposal {
  const created_at = nowIso();
  const result = db
    .prepare(
      `INSERT INTO proposals (lead_id, type, content, status, rejection_reason, proposed_time, created_at)
       VALUES ($lead_id, $type, $content, 'pending', NULL, $proposed_time, $created_at)`
    )
    .run(
      bind({
        $lead_id: input.lead_id,
        $type: input.type,
        $content: input.content,
        $proposed_time: input.proposed_time ?? null,
        $created_at: created_at,
      })
    );
  return getProposal(db, Number(result.lastInsertRowid))!;
}

export function getProposal(db: DatabaseSync, id: number): Proposal | undefined {
  const row = db.prepare("SELECT * FROM proposals WHERE id = $id").get(bind({ $id: id }));
  return row ? normalizeRow<Proposal>(row) : undefined;
}

export function listProposals(db: DatabaseSync, filter?: { status?: Proposal["status"]; lead_id?: number }): Proposal[] {
  const clauses: string[] = [];
  const params: Params = {};
  if (filter?.status) {
    clauses.push("status = $status");
    params.$status = filter.status;
  }
  if (filter?.lead_id !== undefined) {
    clauses.push("lead_id = $lead_id");
    params.$lead_id = filter.lead_id;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return normalizeRows<Proposal>(
    db.prepare(`SELECT * FROM proposals ${where} ORDER BY created_at ASC, id ASC`).all(bind(params))
  );
}

export function updateProposal(db: DatabaseSync, id: number, patch: Partial<Proposal>): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = $${k}`).join(", ");
  const params: Params = { $id: id };
  for (const k of keys) params[`$${k}`] = (patch as Record<string, unknown>)[k];
  db.prepare(`UPDATE proposals SET ${setClause} WHERE id = $id`).run(bind(params));
}

export function insertAudit(
  db: DatabaseSync,
  input: { lead_id: number | null; tool_name: string; input_json: unknown; output_json: unknown; actor: Actor }
): AuditLogRow {
  const timestamp = nowIso();
  const result = db
    .prepare(
      `INSERT INTO audit_log (lead_id, tool_name, input_json, output_json, timestamp, actor)
       VALUES ($lead_id, $tool_name, $input_json, $output_json, $timestamp, $actor)`
    )
    .run(
      bind({
        $lead_id: input.lead_id,
        $tool_name: input.tool_name,
        $input_json: JSON.stringify(input.input_json),
        $output_json: JSON.stringify(input.output_json),
        $timestamp: timestamp,
        $actor: input.actor,
      })
    );
  return normalizeRow<AuditLogRow>(
    db.prepare("SELECT * FROM audit_log WHERE id = $id").get(bind({ $id: Number(result.lastInsertRowid) }))
  );
}

export function listAudit(db: DatabaseSync, leadId: number): AuditLogRow[] {
  return normalizeRows<AuditLogRow>(
    db.prepare("SELECT * FROM audit_log WHERE lead_id = $lead_id ORDER BY timestamp ASC, id ASC").all(bind({ $lead_id: leadId }))
  );
}

export function countSendsInWindow(db: DatabaseSync, leadId: number, sinceIso: string): number {
  const row = normalizeRow<{ cnt: number }>(
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM audit_log
         WHERE lead_id = $lead_id AND tool_name = 'send_message' AND timestamp >= $since
         AND json_extract(output_json, '$.ok') = 1`
      )
      .get(bind({ $lead_id: leadId, $since: sinceIso }))
  );
  return row.cnt;
}

export function listProperties(db: DatabaseSync): Property[] {
  return normalizeRows<Property>(db.prepare("SELECT * FROM properties ORDER BY id").all());
}

export function getProperty(db: DatabaseSync, id: number): Property | undefined {
  const row = db.prepare("SELECT * FROM properties WHERE id = $id").get(bind({ $id: id }));
  return row ? normalizeRow<Property>(row) : undefined;
}

export function listPriceHistory(db: DatabaseSync, propertyId: number): PropertyPriceHistory[] {
  return normalizeRows<PropertyPriceHistory>(
    db
      .prepare("SELECT * FROM property_price_history WHERE property_id = $property_id ORDER BY year ASC")
      .all(bind({ $property_id: propertyId }))
  );
}

export type EscalationStatus =
  | "none" // most recent action wasn't an escalation at all
  | "transient" // most recent action was a system_triggered (infra) escalation -- not blocked from the queue
  | "parked"; // most recent action was a genuine model-decided escalation -- needs a human `retry`

/**
 * Reads the single most recent audit_log row for a lead and classifies it.
 * "none" and "transient" both mean the lead is NOT excluded from the queue --
 * nothing runs in the background on its own (no daemon, no scheduler), but
 * whenever someone next runs `process`, this lead will be attempted like any
 * other, no special unblocking step required. The distinction from "parked"
 * exists purely so a human looking at the dashboard can tell "nothing has
 * happened" apart from "the last attempt just failed" instead of both
 * reading as identical blanks.
 */
export function getEscalationStatus(db: DatabaseSync, leadId: number): EscalationStatus {
  const row = normalizeRow<{ tool_name: string; output_json: string } | undefined>(
    db
      .prepare("SELECT tool_name, output_json FROM audit_log WHERE lead_id = $lead_id ORDER BY id DESC LIMIT 1")
      .get(bind({ $lead_id: leadId }))
  );
  if (!row || row.tool_name !== "escalate_to_agent") return "none";
  try {
    const output = JSON.parse(row.output_json) as { escalated?: boolean; system_triggered?: boolean };
    if (!output.escalated) return "none";
    return output.system_triggered ? "transient" : "parked";
  } catch {
    return "none";
  }
}

/**
 * True only for a genuine, model-decided escalation -- used to keep the
 * queue from re-escalating the same lead every run. A human action
 * (approve/reject/retry) or a fresh tool call writes a newer audit row and
 * un-parks it. A `system_triggered` escalation (the agent loop's own safety
 * net -- the LLM call failed, the model stopped calling tools, the turn
 * budget ran out) never parks: that's an infrastructure hiccup, not a
 * judgment call about the lead, so it's simply retried on the next pass.
 */
export function isParkedOnEscalation(db: DatabaseSync, leadId: number): boolean {
  return getEscalationStatus(db, leadId) === "parked";
}

export function insertRunMetric(
  db: DatabaseSync,
  input: {
    lead_id: number;
    started_at: string;
    ended_at: string;
    outcome: RunOutcomeKind;
    tool_call_count: number;
    estimated_token_cost: number;
  }
): void {
  db.prepare(
    `INSERT INTO run_metrics (lead_id, started_at, ended_at, outcome, tool_call_count, estimated_token_cost)
     VALUES ($lead_id, $started_at, $ended_at, $outcome, $tool_call_count, $estimated_token_cost)`
  ).run(
    bind({
      $lead_id: input.lead_id,
      $started_at: input.started_at,
      $ended_at: input.ended_at,
      $outcome: input.outcome,
      $tool_call_count: input.tool_call_count,
      $estimated_token_cost: input.estimated_token_cost,
    })
  );
}

export function listRunMetrics(db: DatabaseSync): RunMetric[] {
  return normalizeRows<RunMetric>(db.prepare("SELECT * FROM run_metrics ORDER BY id").all());
}

const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Idempotent locking guardrail: only one worker may hold a lead's lock at a
 * time. A lock older than LOCK_TIMEOUT_MS is treated as abandoned (the
 * process that held it presumably crashed) and can be re-acquired by anyone.
 */
export function tryAcquireLock(db: DatabaseSync, leadId: number, workerId: string, timeoutMs = LOCK_TIMEOUT_MS): boolean {
  const lead = getLead(db, leadId);
  if (!lead) return false;

  if (lead.locked_at && lead.locked_by) {
    const ageMs = Date.now() - new Date(lead.locked_at).getTime();
    if (ageMs < timeoutMs) return false; // still held by someone else and not expired
  }

  db.prepare("UPDATE leads SET locked_at = $now, locked_by = $worker WHERE id = $id").run(
    bind({ $now: nowIso(), $worker: workerId, $id: leadId })
  );
  return true;
}

/** Only releases the lock if this worker still holds it -- never clears a newer lock it doesn't own. */
export function releaseLock(db: DatabaseSync, leadId: number, workerId: string): void {
  db.prepare("UPDATE leads SET locked_at = NULL, locked_by = NULL WHERE id = $id AND locked_by = $worker").run(
    bind({ $id: leadId, $worker: workerId })
  );
}

export function getRunState(db: DatabaseSync): { current_lead_id: number | null } | undefined {
  const row = db.prepare("SELECT * FROM run_state WHERE id = 1").get();
  return row ? normalizeRow<{ current_lead_id: number | null }>(row) : undefined;
}

export function setRunState(db: DatabaseSync, leadId: number | null): void {
  db.prepare(
    `INSERT INTO run_state (id, current_lead_id, updated_at) VALUES (1, $lead_id, $updated_at)
     ON CONFLICT(id) DO UPDATE SET current_lead_id = $lead_id, updated_at = $updated_at`
  ).run(bind({ $lead_id: leadId, $updated_at: nowIso() }));
}
