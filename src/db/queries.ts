import type { DatabaseSync } from "node:sqlite";
import type {
  Lead,
  Interaction,
  Proposal,
  AuditLogRow,
  Property,
  PropertyPriceHistory,
  Actor,
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

/**
 * True once the most recent audit_log entry for this lead is a successful
 * escalate_to_agent call -- used to keep the queue from re-escalating the
 * same lead every run. A human action (approve/reject) or a fresh tool call
 * writes a newer audit row and un-parks it.
 */
export function isParkedOnEscalation(db: DatabaseSync, leadId: number): boolean {
  const row = normalizeRow<{ tool_name: string; output_json: string } | undefined>(
    db
      .prepare("SELECT tool_name, output_json FROM audit_log WHERE lead_id = $lead_id ORDER BY id DESC LIMIT 1")
      .get(bind({ $lead_id: leadId }))
  );
  if (!row) return false;
  if (row.tool_name !== "escalate_to_agent") return false;
  try {
    const output = JSON.parse(row.output_json) as { escalated?: boolean };
    return Boolean(output.escalated);
  } catch {
    return false;
  }
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
