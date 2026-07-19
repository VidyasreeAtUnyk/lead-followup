import type { DatabaseSync } from "node:sqlite";
import type { AnyToolDefinition } from "./types.js";
import { getLeadContext } from "./getLeadContext.js";
import { checkContactEligibility } from "./checkContactEligibility.js";
import { findMatchingProperties } from "./findMatchingProperties.js";
import { getPropertyMarketData } from "./getPropertyMarketData.js";
import { proposeMessage } from "./proposeMessage.js";
import { proposeViewing } from "./proposeViewing.js";
import { sendMessage } from "./sendMessage.js";
import { reactivateLead } from "./reactivateLead.js";
import { escalateToAgent } from "./escalateToAgent.js";
import { logNote } from "./logNote.js";
import { ToolError, isToolError } from "../domain/errors.js";
import { insertAudit } from "../db/queries.js";

export const TOOLS: AnyToolDefinition[] = [
  getLeadContext,
  checkContactEligibility,
  findMatchingProperties,
  getPropertyMarketData,
  proposeMessage,
  proposeViewing,
  sendMessage,
  reactivateLead,
  escalateToAgent,
  logNote,
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export interface DispatchResult {
  ok: boolean;
  output: unknown;
}

/**
 * Single choke point through which every agent tool call passes: validates
 * input with the tool's own Zod schema, runs it, and unconditionally writes
 * an audit_log row (success or typed failure) tagged actor='agent' -- this is
 * what makes `history <lead_id>` a complete reconstruction of the run.
 *
 * `leadId` is the lead this run is currently processing, used purely for
 * audit attribution -- it is independent of whatever id fields happen to be
 * in the tool's own input (e.g. get_property_market_data takes property_id,
 * not lead_id).
 */
export function dispatchToolCall(
  db: DatabaseSync,
  leadId: number,
  toolName: string,
  rawInput: unknown
): DispatchResult {
  const tool = TOOLS_BY_NAME.get(toolName);
  if (!tool) {
    const err = new ToolError("INVALID_INPUT", `Unknown tool '${toolName}'.`);
    insertAudit(db, { lead_id: leadId, tool_name: toolName, input_json: rawInput, output_json: err.toJSON(), actor: "agent" });
    return { ok: false, output: err.toJSON() };
  }

  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    const err = new ToolError("INVALID_INPUT", `Invalid input for ${toolName}: ${parsed.error.message}`);
    insertAudit(db, { lead_id: leadId, tool_name: toolName, input_json: rawInput, output_json: err.toJSON(), actor: "agent" });
    return { ok: false, output: err.toJSON() };
  }

  try {
    const output = tool.execute(db, parsed.data);
    insertAudit(db, { lead_id: leadId, tool_name: toolName, input_json: parsed.data, output_json: output, actor: "agent" });
    return { ok: true, output };
  } catch (e) {
    const err = isToolError(e) ? e : new ToolError("INVALID_INPUT", String((e as Error)?.message ?? e));
    insertAudit(db, { lead_id: leadId, tool_name: toolName, input_json: parsed.data, output_json: err.toJSON(), actor: "agent" });
    return { ok: false, output: err.toJSON() };
  }
}
