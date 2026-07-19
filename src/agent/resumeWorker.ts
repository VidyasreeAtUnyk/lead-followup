import { loadEnvFile } from "../config/env.js";
loadEnvFile();

import { getDb } from "../db/client.js";
import { runAgentForLead } from "./loop.js";

/**
 * Minimal standalone entry point: open the given db path and run one agent
 * turn-loop for one lead, then exit. Used both directly (`npm run process`
 * style single-lead runs) and as the child process spawned by
 * demoResume.ts, which kills it mid-run to prove resumability.
 */
async function main() {
  const dbPath = process.argv[2];
  const leadId = Number(process.argv[3]);
  if (!dbPath || !leadId) {
    console.error("Usage: resumeWorker.ts <dbPath> <leadId>");
    process.exit(1);
  }
  const db = getDb(dbPath);
  const result = await runAgentForLead(db, leadId);
  console.log(`WORKER_RESULT ${JSON.stringify(result)}`);
}

main().catch((e) => {
  console.error("WORKER_ERROR", e);
  process.exit(1);
});
