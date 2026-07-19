#!/usr/bin/env node
import { loadEnvFile } from "../config/env.js";
loadEnvFile();

import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { getDb, DEFAULT_DB_PATH } from "../db/client.js";
import {
  listLeads,
  listProposals,
  getProposal,
  getLead,
  listAudit,
  updateProposal,
  insertAudit,
  isParkedOnEscalation,
  getEscalationStatus,
} from "../db/queries.js";
import { colorStage, truncate, formatTimestamp } from "./format.js";
import { RunProgressRenderer } from "./progress.js";
import { processQueue } from "../agent/runQueue.js";
import { closeDeal, type DealOutcome } from "../domain/dealClose.js";
import { isToolError } from "../domain/errors.js";
import { computeAggregateMetrics } from "../domain/metrics.js";

const program = new Command();
program.name("lead-followup").description("Real estate lead follow-up agent CLI");

function db() {
  return getDb(DEFAULT_DB_PATH);
}

program
  .command("dashboard")
  .description("Show all leads with segment, stage, last contact, pending proposals, and escalation status")
  .action(() => {
    const database = db();
    const leads = listLeads(database);
    const table = new Table({
      head: ["ID", "Name", "Segment", "Stage", "Last Contacted", "Pending Proposals", "Escalated"],
    });
    for (const lead of leads) {
      const pending = listProposals(database, { lead_id: lead.id, status: "pending" }).length;
      table.push([
        lead.id,
        lead.name,
        lead.segment,
        colorStage(lead.stage, Boolean(lead.do_not_contact)),
        formatTimestamp(lead.last_contacted_at),
        pending > 0 ? chalk.bold(String(pending)) : "0",
        formatEscalationStatus(getEscalationStatus(database, lead.id)),
      ]);
    }
    console.log(table.toString());
  });

function formatEscalationStatus(status: ReturnType<typeof getEscalationStatus>): string {
  if (status === "parked") return chalk.red("needs retry");
  // Nothing is retrying this in the background -- no daemon, no cron. It's
  // simply not blocked, so the *next time a person runs `process`* it will
  // be attempted again. Say that plainly rather than implying autonomous action.
  if (status === "transient") return chalk.yellow("rate-limited -- rerun process");
  return chalk.dim("--");
}

program
  .command("proposals")
  .description("Show all pending proposals awaiting human approval")
  .action(() => {
    const database = db();
    const pending = listProposals(database, { status: "pending" });
    const table = new Table({ head: ["ID", "Lead", "Type", "Content", "Created At"] });
    for (const p of pending) {
      const lead = getLead(database, p.lead_id);
      table.push([p.id, lead?.name ?? `#${p.lead_id}`, p.type, truncate(p.content), formatTimestamp(p.created_at)]);
    }
    console.log(table.toString());
    if (pending.length === 0) console.log(chalk.dim("No pending proposals."));
  });

program
  .command("escalated")
  .description("Show every lead the dashboard's Escalated column flags -- both needing a human retry and self-healing rate-limit hits")
  .action(() => {
    const database = db();
    // Same predicate as dashboard's "Escalated" column (status !== "none") --
    // this command must show a superset consistent with that column, or the
    // two disagree on what "escalated" means for the exact same lead.
    const escalated = listLeads(database)
      .map((lead) => ({ lead, status: getEscalationStatus(database, lead.id) }))
      .filter(({ status }) => status !== "none");
    const table = new Table({ head: ["ID", "Name", "Segment", "Stage", "Status", "Reason", "Escalated At"] });
    for (const { lead, status } of escalated) {
      const audit = listAudit(database, lead.id);
      const lastRow = audit[audit.length - 1];
      let reason = "";
      try {
        reason = (JSON.parse(lastRow.output_json) as { reason?: string }).reason ?? "";
      } catch {
        reason = "";
      }
      table.push([
        lead.id,
        lead.name,
        lead.segment,
        colorStage(lead.stage, Boolean(lead.do_not_contact)),
        formatEscalationStatus(status),
        truncate(reason, 60),
        formatTimestamp(lastRow.timestamp),
      ]);
    }
    console.log(table.toString());
    if (escalated.length === 0) {
      console.log(chalk.dim("No leads are currently escalated."));
    }
  });

program
  .command("history <leadId>")
  .description("Print the full chronological audit trail for a lead")
  .action((leadIdArg: string) => {
    const leadId = Number(leadIdArg);
    const database = db();
    const lead = getLead(database, leadId);
    if (!lead) {
      console.log(chalk.red(`No lead with id ${leadId}.`));
      return;
    }
    console.log(chalk.bold(`History for lead ${leadId} -- ${lead.name} (${lead.segment}/${lead.stage})`));
    const rows = listAudit(database, leadId);
    if (rows.length === 0) {
      console.log(chalk.dim("No audit entries yet."));
      return;
    }
    for (const row of rows) {
      const actorLabel = row.actor === "human" ? chalk.magenta("human") : chalk.blue("agent");
      console.log(`\n${chalk.dim(formatTimestamp(row.timestamp))}  [${actorLabel}] ${chalk.bold(row.tool_name)}`);
      console.log(`  input:  ${row.input_json}`);
      console.log(`  output: ${row.output_json}`);
    }
  });

program
  .command("approve <proposalId>")
  .description("Approve a pending proposal")
  .action((proposalIdArg: string) => {
    const proposalId = Number(proposalIdArg);
    const database = db();
    const proposal = getProposal(database, proposalId);
    if (!proposal) {
      console.log(chalk.red(`No proposal with id ${proposalId}.`));
      return;
    }
    if (proposal.status !== "pending") {
      console.log(chalk.red(`Proposal ${proposalId} is already '${proposal.status}'.`));
      return;
    }
    updateProposal(database, proposalId, { status: "approved" });
    insertAudit(database, {
      lead_id: proposal.lead_id,
      tool_name: "approve_proposal",
      input_json: { proposal_id: proposalId },
      output_json: { ok: true, status: "approved" },
      actor: "human",
    });
    console.log(chalk.green(`Approved proposal ${proposalId}.`));
  });

program
  .command("reject <proposalId> <reason>")
  .description("Reject a pending proposal with a reason")
  .action((proposalIdArg: string, reason: string) => {
    const proposalId = Number(proposalIdArg);
    const database = db();
    const proposal = getProposal(database, proposalId);
    if (!proposal) {
      console.log(chalk.red(`No proposal with id ${proposalId}.`));
      return;
    }
    if (proposal.status !== "pending") {
      console.log(chalk.red(`Proposal ${proposalId} is already '${proposal.status}'.`));
      return;
    }
    updateProposal(database, proposalId, { status: "rejected", rejection_reason: reason });
    insertAudit(database, {
      lead_id: proposal.lead_id,
      tool_name: "reject_proposal",
      input_json: { proposal_id: proposalId, reason },
      output_json: { ok: true, status: "rejected", reason },
      actor: "human",
    });
    console.log(chalk.yellow(`Rejected proposal ${proposalId}: ${reason}`));
  });

program
  .command("process [leadId]")
  .description("Run the agent loop over the queue (or a single lead id) -- requires OPENAI_API_KEY")
  .action(async (leadIdArg?: string) => {
    const only = leadIdArg ? Number(leadIdArg) : undefined;
    const database = db();

    let renderer: RunProgressRenderer | null = null;
    let activeLeadId: number | null = null;

    const results = await processQueue(database, undefined, only, undefined, {
      onProgress: (leadId, progress) => {
        if (activeLeadId !== leadId) {
          activeLeadId = leadId;
          const lead = getLead(database, leadId);
          renderer = new RunProgressRenderer();
          renderer.startLead(`Lead ${leadId}${lead ? ` (${lead.name})` : ""}`);
        }
        renderer?.onProgress(progress);
      },
      onLeadResult: (result) => {
        renderer?.finishLead(
          `${chalk.bold(result.outcome.kind)} -- Lead ${result.leadId} (${result.assistantTurns} turn(s))`
        );
        renderer = null;
        activeLeadId = null;
      },
    });

    if (results.length === 0) {
      console.log(chalk.dim("Queue is empty -- nothing to process."));
    }
  });

program
  .command("close <leadId> <outcome>")
  .description("Human action: record a deal outcome (won|lost|canceled) for a lead in decision_pending")
  .action((leadIdArg: string, outcomeArg: string) => {
    const leadId = Number(leadIdArg);
    const outcome = outcomeArg as DealOutcome;
    if (!["won", "lost", "canceled"].includes(outcome)) {
      console.log(chalk.red("Outcome must be one of: won, lost, canceled"));
      return;
    }
    const database = db();
    try {
      closeDeal(database, leadId, outcome);
      console.log(chalk.green(`Lead ${leadId} closed as '${outcome}'.`));
    } catch (e) {
      if (isToolError(e)) {
        console.log(chalk.red(`${e.error}: ${e.message}`));
      } else {
        throw e;
      }
    }
  });

program
  .command("retry <leadId>")
  .description("Human action: clear a lead's escalation park so the agent will process it again")
  .action((leadIdArg: string) => {
    const leadId = Number(leadIdArg);
    const database = db();
    const lead = getLead(database, leadId);
    if (!lead) {
      console.log(chalk.red(`No lead with id ${leadId}.`));
      return;
    }
    if (!isParkedOnEscalation(database, leadId)) {
      console.log(chalk.dim(`Lead ${leadId} isn't currently parked on an escalation -- nothing to do.`));
      return;
    }
    insertAudit(database, {
      lead_id: leadId,
      tool_name: "retry_lead",
      input_json: { lead_id: leadId },
      output_json: { ok: true, unparked: true },
      actor: "human",
    });
    console.log(chalk.green(`Lead ${leadId} un-parked -- it will be picked up on the next process run.`));
  });

program
  .command("metrics")
  .description("Show aggregate run metrics (escalation rate, tool calls, estimated cost, approval turnaround)")
  .action(() => {
    const database = db();
    const m = computeAggregateMetrics(database);
    const table = new Table();
    table.push(
      { "Total runs": String(m.totalRuns) },
      { "Escalation rate": `${(m.escalationRate * 100).toFixed(1)}%` },
      { "Avg tool calls / run": m.avgToolCallsPerRun.toFixed(1) },
      { "Total estimated cost": `$${m.totalEstimatedCost.toFixed(4)}` },
      {
        "Avg approval turnaround": m.avgApprovalTurnaroundMs === null ? chalk.dim("n/a (no resolved proposals yet)") : formatDuration(m.avgApprovalTurnaroundMs),
      }
    );
    console.log(table.toString());
  });

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

program.parseAsync(process.argv);
