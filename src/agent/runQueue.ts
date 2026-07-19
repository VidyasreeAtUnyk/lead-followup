import type { DatabaseSync } from "node:sqlite";
import type OpenAI from "openai";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../config/env.js";
loadEnvFile();
import { getDb, DEFAULT_DB_PATH } from "../db/client.js";
import { getRunState, setRunState } from "../db/queries.js";
import { getQueue } from "./queue.js";
import { runAgentForLead, type RunResult } from "./loop.js";

/**
 * Processes the queue one lead at a time. All progress markers live in the
 * `run_state` row in SQLite, not in memory -- if this process is killed at
 * any point, the next invocation reads run_state and resumes the same lead
 * (which itself resumes coherently because every tool call it makes is
 * committed to SQLite immediately; see runAgentForLead).
 */
export async function processQueue(db: DatabaseSync, client?: OpenAI, only?: number): Promise<RunResult[]> {
  const results: RunResult[] = [];

  const resumeState = getRunState(db);
  if (resumeState?.current_lead_id != null && (only === undefined || only === resumeState.current_lead_id)) {
    const result = await runAgentForLead(db, resumeState.current_lead_id, client);
    results.push(result);
    setRunState(db, null);
  }

  const queue = only !== undefined ? getQueue(db).filter((l) => l.id === only) : getQueue(db);

  for (const lead of queue) {
    if (results.some((r) => r.leadId === lead.id)) continue;
    setRunState(db, lead.id);
    const result = await runAgentForLead(db, lead.id, client);
    results.push(result);
    setRunState(db, null);
  }

  return results;
}

async function main() {
  const arg = process.argv[2];
  const only = arg ? Number(arg) : undefined;
  const db = getDb(DEFAULT_DB_PATH);
  const results = await processQueue(db, undefined, only);
  for (const r of results) {
    console.log(`Lead ${r.leadId}: ${r.outcome.kind} (${r.assistantTurns} turn(s))`);
  }
  if (results.length === 0) {
    console.log("Queue is empty -- nothing to process.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
