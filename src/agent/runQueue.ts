import type { DatabaseSync } from "node:sqlite";
import type OpenAI from "openai";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../config/env.js";
loadEnvFile();
import { getDb, DEFAULT_DB_PATH } from "../db/client.js";
import { getRunState, setRunState, tryAcquireLock, releaseLock } from "../db/queries.js";
import { getQueue } from "./queue.js";
import { runAgentForLead, type RunResult, type ProgressCallback } from "./loop.js";

function defaultWorkerId(): string {
  return `worker-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface ProcessQueueHooks {
  /** Fired on every "thinking"/"tool_call" tick within a lead's run -- for live progress display. */
  onProgress?: (leadId: number, progress: Parameters<ProgressCallback>[0]) => void;
  /** Fired once a lead's run has fully resolved, with its final result. */
  onLeadResult?: (result: RunResult) => void;
}

/**
 * Processes the queue one lead at a time. All progress markers live in the
 * `run_state` row in SQLite, not in memory -- if this process is killed at
 * any point, the next invocation reads run_state and resumes the same lead
 * (which itself resumes coherently because every tool call it makes is
 * committed to SQLite immediately; see runAgentForLead).
 *
 * Idempotent locking: each lead is locked (leads.locked_at/locked_by) before
 * processing and released after, so if two workers race for the same lead,
 * only the one that wins tryAcquireLock proceeds -- the other skips it this
 * pass rather than double-processing. A lock older than the timeout is
 * treated as abandoned (crashed worker) and can be re-acquired by anyone.
 */
export async function processQueue(
  db: DatabaseSync,
  client?: OpenAI,
  only?: number,
  workerId: string = defaultWorkerId(),
  hooks: ProcessQueueHooks = {},
  limit?: number
): Promise<RunResult[]> {
  const results: RunResult[] = [];

  const resumeState = getRunState(db);
  if (resumeState?.current_lead_id != null && (only === undefined || only === resumeState.current_lead_id)) {
    const leadId = resumeState.current_lead_id;
    if (tryAcquireLock(db, leadId, workerId)) {
      try {
        const result = await runAgentForLead(db, leadId, client, undefined, (p) => hooks.onProgress?.(leadId, p));
        results.push(result);
        hooks.onLeadResult?.(result);
      } finally {
        setRunState(db, null);
        releaseLock(db, leadId, workerId);
      }
    }
  }

  const fullQueue = only !== undefined ? getQueue(db).filter((l) => l.id === only) : getQueue(db);
  // limit caps how many *new* leads this pass starts -- it doesn't count a
  // resumed in-progress lead above, since that one was already committed to
  // before this call and isn't a fresh request-budget decision.
  const queue = limit !== undefined ? fullQueue.slice(0, limit) : fullQueue;

  for (const lead of queue) {
    if (results.some((r) => r.leadId === lead.id)) continue;
    if (!tryAcquireLock(db, lead.id, workerId)) continue; // locked by another worker and not expired -- skip this pass
    setRunState(db, lead.id);
    try {
      const result = await runAgentForLead(db, lead.id, client, undefined, (p) => hooks.onProgress?.(lead.id, p));
      results.push(result);
      hooks.onLeadResult?.(result);
    } finally {
      setRunState(db, null);
      releaseLock(db, lead.id, workerId);
    }
  }

  return results;
}

async function main() {
  const arg = process.argv[2];
  const only = arg ? Number(arg) : undefined;
  const db = getDb(DEFAULT_DB_PATH);
  const results = await processQueue(db, undefined, only, undefined, {
    onProgress: (leadId, progress) => {
      const activity = progress.phase === "tool_call" ? `-> ${progress.toolName}` : "thinking...";
      console.log(`  [lead ${leadId}] turn ${progress.turn} ${activity} (~${progress.tokensSoFar} tokens)`);
    },
    onLeadResult: (result) => {
      console.log(`Lead ${result.leadId}: ${result.outcome.kind} (${result.assistantTurns} turn(s))`);
      const info = result.rateLimitInfo;
      if (info && (info.remainingRequests !== undefined || info.limitRequests !== undefined)) {
        const reset = info.resetRequests ? `, resets in ${info.resetRequests}` : "";
        console.log(`  Quota: ${info.remainingRequests ?? "?"}/${info.limitRequests ?? "?"} requests remaining${reset}`);
      }
    },
  });
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
