import { loadEnvFile } from "../config/env.js";
loadEnvFile();

import path from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { getDb, closeDb } from "../db/client.js";
import { seedDatabase } from "../db/seed.js";
import {
  getLead,
  listProposals,
  updateProposal,
  insertAudit,
  listAudit,
  getProposal,
} from "../db/queries.js";
import { runAgentForLead } from "../agent/loop.js";
import { closeDeal } from "../domain/dealClose.js";
import { dispatchToolCall } from "../tools/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVAL_DB_PATH = path.join(__dirname, "..", "..", "data", "evals.sqlite");

function freshDb(): DatabaseSync {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = EVAL_DB_PATH + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
  const db = getDb(EVAL_DB_PATH);
  seedDatabase(db);
  return db;
}

/** Test-only helper standing in for a CLI `approve <id>` call. */
function approve(db: DatabaseSync, proposalId: number): void {
  const proposal = getProposal(db, proposalId);
  if (!proposal) throw new Error(`No proposal ${proposalId}`);
  updateProposal(db, proposalId, { status: "approved" });
  insertAudit(db, {
    lead_id: proposal.lead_id,
    tool_name: "approve_proposal",
    input_json: { proposal_id: proposalId },
    output_json: { ok: true, status: "approved" },
    actor: "human",
  });
}

/** Test-only helper standing in for a CLI `reject <id> "<reason>"` call. */
function reject(db: DatabaseSync, proposalId: number, reason: string): void {
  const proposal = getProposal(db, proposalId);
  if (!proposal) throw new Error(`No proposal ${proposalId}`);
  updateProposal(db, proposalId, { status: "rejected", rejection_reason: reason });
  insertAudit(db, {
    lead_id: proposal.lead_id,
    tool_name: "reject_proposal",
    input_json: { proposal_id: proposalId, reason },
    output_json: { ok: true, status: "rejected", reason },
    actor: "human",
  });
}

function assertTrue(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

interface Scenario {
  name: string;
  run: () => Promise<void>;
}

const scenarios: Scenario[] = [
  {
    name: "1. Happy path prospect: propose -> approve -> send",
    run: async () => {
      const db = freshDb();
      const first = await runAgentForLead(db, 1);
      assertTrue(first.outcome.kind === "awaiting_approval", `expected awaiting_approval, got ${first.outcome.kind}`);

      const pending = listProposals(db, { lead_id: 1, status: "pending" });
      assertTrue(pending.length === 1, `expected exactly 1 pending proposal, got ${pending.length}`);
      approve(db, pending[0].id);

      const second = await runAgentForLead(db, 1);
      assertTrue(second.outcome.kind === "sent", `expected sent, got ${second.outcome.kind}`);

      const lead = getLead(db, 1)!;
      assertTrue(lead.stage === "contacted", `expected stage 'contacted' after first send, got '${lead.stage}'`);

      const audit = listAudit(db, 1);
      const sendRow = audit.find((r) => r.tool_name === "send_message" && r.output_json.includes("MOCK SEND"));
      assertTrue(Boolean(sendRow), "expected an audit_log row for send_message containing a MOCK SEND log");
    },
  },
  {
    name: "2. Do-not-contact lead: must escalate, never propose",
    run: async () => {
      const db = freshDb();
      const result = await runAgentForLead(db, 2);
      assertTrue(result.outcome.kind === "escalated", `expected escalated, got ${result.outcome.kind}`);
      const proposals = listProposals(db, { lead_id: 2 });
      assertTrue(proposals.length === 0, `expected 0 proposals for do_not_contact lead, got ${proposals.length}`);
    },
  },
  {
    name: "3. Rejection -> revise -> re-propose -> approved",
    run: async () => {
      const db = freshDb();
      const first = await runAgentForLead(db, 1);
      assertTrue(first.outcome.kind === "awaiting_approval", `expected awaiting_approval, got ${first.outcome.kind}`);

      const firstProposal = listProposals(db, { lead_id: 1, status: "pending" })[0];
      assertTrue(Boolean(firstProposal), "expected a first pending proposal");
      reject(db, firstProposal.id, "Too pushy about price -- lead in the profile said timeline is 'next 3 months', not urgent. Soften the tone and drop the trend figures.");

      const second = await runAgentForLead(db, 1);
      assertTrue(second.outcome.kind === "awaiting_approval", `expected a second awaiting_approval, got ${second.outcome.kind}`);

      const allProposals = listProposals(db, { lead_id: 1 });
      assertTrue(allProposals.length === 2, `expected 2 total proposals for lead 1, got ${allProposals.length}`);
      const secondProposal = allProposals.find((p) => p.id !== firstProposal.id)!;
      assertTrue(secondProposal.status === "pending", "expected second proposal to be pending");
      assertTrue(secondProposal.content !== firstProposal.content, "expected the revised draft to differ from the rejected one");

      approve(db, secondProposal.id);
      const third = await runAgentForLead(db, 1);
      assertTrue(third.outcome.kind === "sent", `expected sent after approving revised proposal, got ${third.outcome.kind}`);
      assertTrue(getProposal(db, secondProposal.id)!.status === "approved", "expected the revised proposal to remain approved after send");
    },
  },
  {
    name: "4. Ambiguous/contradictory signals: escalate, don't force a decision",
    run: async () => {
      const db = freshDb();
      const result = await runAgentForLead(db, 3);
      assertTrue(result.outcome.kind === "escalated", `expected escalated, got ${result.outcome.kind}`);
      const proposals = listProposals(db, { lead_id: 3 });
      assertTrue(proposals.length === 0, `expected no proposal for the contradictory-signal lead, got ${proposals.length}`);
    },
  },
  {
    name: "5. Won lead -> segment flips prospect->client, stage resets to new",
    run: async () => {
      const db = freshDb();
      db.prepare(
        `INSERT INTO leads (id, name, contact, property_interest, budget, location_pref, timeline, source, segment, stage, do_not_contact, last_contacted_at, contact_count)
         VALUES (100, 'Ivy Sato', 'ivy.sato@example.com', 'condo', 400000, 'Downtown', 'asap', 'referral', 'prospect', 'decision_pending', 0, NULL, 3)`
      ).run();

      const before = getLead(db, 100)!;
      assertTrue(before.segment === "prospect" && before.stage === "decision_pending", "fixture setup sanity check");

      closeDeal(db, 100, "won");

      const after = getLead(db, 100)!;
      assertTrue(after.segment === "client", `expected segment 'client' after won, got '${after.segment}'`);
      assertTrue(after.stage === "new", `expected stage 'new' after won, got '${after.stage}'`);
    },
  },
  {
    name: "6. No self-reactivation for dormant lead without qualifying evidence",
    run: async () => {
      const db = freshDb();
      const before = getLead(db, 6)!;
      assertTrue(before.stage === "dormant", "fixture sanity check: lead 6 should start dormant");

      // Direct guardrail check: the tool itself must refuse stale/non-qualifying evidence,
      // independent of whether the model would ever choose to call it this way.
      const staleAttempt = dispatchToolCall(db, 6, "reactivate_lead", { lead_id: 6, evidence_interaction_id: 21 });
      assertTrue(staleAttempt.ok === false, "expected reactivate_lead to fail for stale/non-qualifying evidence");
      assertTrue(
        (staleAttempt.output as { error?: string }).error === "EVIDENCE_INVALID",
        `expected EVIDENCE_INVALID, got ${JSON.stringify(staleAttempt.output)}`
      );

      const result = await runAgentForLead(db, 6);
      assertTrue(result.outcome.kind === "escalated", `expected agent to escalate rather than self-reactivate, got ${result.outcome.kind}`);

      const after = getLead(db, 6)!;
      assertTrue(after.stage === "dormant", `expected lead to remain 'dormant', got '${after.stage}'`);
    },
  },
  {
    name: "7. Minimal-profile lead: insufficient_profile, discovery message not a property pitch",
    run: async () => {
      const db = freshDb();
      const result = await runAgentForLead(db, 4);
      assertTrue(result.outcome.kind === "awaiting_approval", `expected awaiting_approval, got ${result.outcome.kind}`);

      const audit = listAudit(db, 4);
      const matchRow = audit.find((r) => r.tool_name === "find_matching_properties");
      assertTrue(Boolean(matchRow), "expected find_matching_properties to have been called");
      assertTrue(
        matchRow!.output_json.includes("insufficient_profile"),
        `expected find_matching_properties to return insufficient_profile, got ${matchRow!.output_json}`
      );

      const proposal = listProposals(db, { lead_id: 4, status: "pending" })[0];
      assertTrue(Boolean(proposal), "expected a discovery proposal to have been created");
      assertTrue(proposal.type === "message", "expected a message proposal, not a viewing");
      const addressLike = /\d+\s+\w+\s+(St|Ave|Ln|Dr|Ct|Tower)/i;
      assertTrue(!addressLike.test(proposal.content), "expected a discovery message, not a specific property pitch with an address");
    },
  },
];

async function main() {
  const results: { name: string; passed: boolean; error?: string }[] = [];
  for (const scenario of scenarios) {
    process.stdout.write(`Running: ${scenario.name} ... `);
    try {
      await scenario.run();
      console.log("PASS");
      results.push({ name: scenario.name, passed: true });
    } catch (e) {
      console.log("FAIL");
      console.error(e);
      results.push({ name: scenario.name, passed: false, error: (e as Error).message });
    }
  }

  console.log("\n--- Eval summary ---");
  for (const r of results) {
    console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
  }
  const failed = results.filter((r) => !r.passed);
  closeDb();
  if (failed.length > 0) {
    console.log(`\n${failed.length}/${results.length} scenario(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} scenarios passed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
