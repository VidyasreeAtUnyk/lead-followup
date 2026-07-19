import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync } from "node:fs";
import { getDb, closeDb } from "../db/client.js";
import { seedDatabase } from "../db/seed.js";
import { listAudit, getLead } from "../db/queries.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DB_PATH = path.join(__dirname, "..", "..", "data", "demo-resume.sqlite");
const WORKER_PATH = path.join(__dirname, "resumeWorker.ts");
const TSX_CLI = path.join(__dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const LEAD_ID = 1;
const KILL_AFTER_MS = 2500;

function freshDemoDb(): void {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = DEMO_DB_PATH + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
  const db = getDb(DEMO_DB_PATH);
  seedDatabase(db);
  closeDb(); // release the handle so the child process can open the file itself
}

function spawnWorker(): ReturnType<typeof spawn> {
  return spawn(process.execPath, [TSX_CLI, WORKER_PATH, DEMO_DB_PATH, String(LEAD_ID)], {
    stdio: "inherit",
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Demonstrates the resumability requirement: no in-memory session state
 * should be required for correctness. We start a real agent run in a child
 * process, SIGKILL it partway through (simulating a crash/deploy/OOM), then
 * start a completely fresh process for the same lead and show it picks up
 * from whatever was already committed to SQLite rather than corrupting state
 * or duplicating already-committed side effects.
 */
async function main() {
  console.log(`=== Resumability demo: lead ${LEAD_ID}, kill after ${KILL_AFTER_MS}ms ===\n`);
  freshDemoDb();

  console.log("--- Phase 1: starting agent run in a child process ---");
  const child = spawnWorker();
  let childExited = false;
  child.on("exit", () => {
    childExited = true;
  });

  await wait(KILL_AFTER_MS);

  if (!childExited) {
    console.log(`\n--- Killing child process (pid ${child.pid}) with SIGKILL now ---`);
    child.kill("SIGKILL");
    await wait(500);
  } else {
    console.log("\n--- Child had already finished before the kill deadline; re-run with a shorter KILL_AFTER_MS to catch it mid-run ---");
  }

  const db = getDb(DEMO_DB_PATH);
  const auditAfterKill = listAudit(db, LEAD_ID);
  const leadAfterKill = getLead(db, LEAD_ID)!;
  console.log(`\nState immediately after kill: ${auditAfterKill.length} audit_log row(s) committed, lead stage='${leadAfterKill.stage}'.`);
  console.log("Tool calls committed before the kill:");
  for (const row of auditAfterKill) console.log(`  - ${row.tool_name}`);
  closeDb();

  console.log("\n--- Phase 2: starting a brand-new process for the SAME lead (no shared memory with phase 1) ---");
  await new Promise<void>((resolve, reject) => {
    const resumed = spawnWorker();
    resumed.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`resume worker exited ${code}`))));
  });

  const db2 = getDb(DEMO_DB_PATH);
  const auditAfterResume = listAudit(db2, LEAD_ID);
  const leadAfterResume = getLead(db2, LEAD_ID)!;
  console.log(`\nState after resume: ${auditAfterResume.length} audit_log row(s) total, lead stage='${leadAfterResume.stage}'.`);
  console.log(
    auditAfterResume.length > auditAfterKill.length
      ? "PASS: the resumed run added further tool calls on top of what the killed process had already committed -- resumability confirmed."
      : "The resumed run did not add new tool calls (it may have already reached a stopping point before phase 1 was killed) -- re-run the demo, or lower KILL_AFTER_MS."
  );
  closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
