import type { Lead, Stage } from "./types.js";
import { ToolError } from "./errors.js";
import { MAX_UNANSWERED_ATTEMPTS } from "../config/limits.js";

/**
 * The funnel graph from the brief. This is the single source of truth for
 * which stage transitions are legal -- tools consult this instead of each
 * re-implementing their own notion of "allowed next stage".
 *
 * Deliberately NOT included here: dormant -> contacted and canceled -> contacted.
 * Those two edges exist in the domain but are only reachable through
 * `reactivate_lead`'s own evidence check (see reactivate.ts), never through
 * this generic edge table -- that's what makes "the agent decided enough time
 * had passed" impossible to satisfy by itself.
 */
export const STAGE_EDGES: Record<Stage, Stage[]> = {
  new: ["contacted"],
  contacted: ["qualified", "dormant"],
  qualified: ["viewing_scheduled", "dormant"],
  viewing_scheduled: ["decision_pending"],
  decision_pending: ["won", "lost", "canceled"],
  canceled: ["dormant"],
  dormant: [],
  won: [],
  lost: [],
};

export const REACTIVATABLE_STAGES: Stage[] = ["dormant", "canceled"];

// Contact-frequency, reactivation-evidence, and agent-loop limits all live in
// src/config/limits.ts now -- see that file for the single list of every
// tunable threshold in the system.

export function assertStageTransition(from: Stage, to: Stage): void {
  const allowed = STAGE_EDGES[from] ?? [];
  if (!allowed.includes(to)) {
    throw new ToolError(
      "INVALID_TRANSITION",
      `Cannot move lead from stage '${from}' to '${to}'. Allowed next stages from '${from}': ${
        allowed.length ? allowed.join(", ") : "(none -- terminal for this run)"
      }.`
    );
  }
}

export function canReactivateFrom(stage: Stage): boolean {
  return REACTIVATABLE_STAGES.includes(stage);
}

/** Lead has enough profile signal to be treated as "qualified" once contacted. */
export function hasSufficientProfile(lead: Pick<Lead, "budget" | "location_pref" | "property_interest">): boolean {
  return Boolean(lead.budget && lead.location_pref && lead.property_interest);
}

/**
 * Computes the stage a lead moves to after a message-type proposal is
 * successfully sent. Pure function so it's independently testable and so
 * `send_message` doesn't have to inline funnel logic.
 */
export function nextStageAfterMessageSend(
  lead: Pick<Lead, "stage" | "contact_count" | "budget" | "location_pref" | "property_interest">,
  hadRecentResponse: boolean
): Stage {
  const { stage } = lead;
  if (stage === "new") return "contacted";
  if (stage === "contacted") {
    if (hasSufficientProfile(lead) || hadRecentResponse) return "qualified";
    const attemptsAfterThis = lead.contact_count + 1;
    if (attemptsAfterThis >= MAX_UNANSWERED_ATTEMPTS && !hadRecentResponse) return "dormant";
    return "contacted";
  }
  if (stage === "qualified") return "qualified";
  if (stage === "viewing_scheduled") return "decision_pending";
  if (stage === "decision_pending") return "decision_pending";
  throw new ToolError(
    "INVALID_TRANSITION",
    `Lead is in stage '${stage}'. It must be reactivated via reactivate_lead before it can be contacted again.`
  );
}

/** Applied when a human records a viewing-proposal send: qualified -> viewing_scheduled. */
export function nextStageAfterViewingSend(stage: Stage): Stage {
  assertStageTransition(stage, "viewing_scheduled");
  return "viewing_scheduled";
}

export interface WonFlipResult {
  segment: "client";
  stage: "new";
}

/**
 * segment flips prospect -> client exactly once, permanently, the moment
 * stage reaches 'won'; stage simultaneously resets to 'new' so the same
 * lead re-enters the same funnel for an upgrade pitch instead of a second
 * pipeline being built for clients.
 */
export function applyWonTransition(lead: Pick<Lead, "stage">): WonFlipResult {
  assertStageTransition(lead.stage, "won");
  return { segment: "client", stage: "new" };
}
