export const SEGMENTS = ["prospect", "client"] as const;
export type Segment = (typeof SEGMENTS)[number];

export const STAGES = [
  "new",
  "contacted",
  "qualified",
  "viewing_scheduled",
  "decision_pending",
  "won",
  "lost",
  "canceled",
  "dormant",
] as const;
export type Stage = (typeof STAGES)[number];

export const INTERACTION_TYPES = ["page_view", "email_open", "reply", "inquiry"] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

export const PROPOSAL_TYPES = ["message", "viewing"] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

export const PROPOSAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPERTY_TIERS = ["standard", "upgrade"] as const;
export type PropertyTier = (typeof PROPERTY_TIERS)[number];

export const ACTORS = ["agent", "human"] as const;
export type Actor = (typeof ACTORS)[number];

export interface Lead {
  id: number;
  name: string;
  contact: string;
  property_interest: string | null;
  budget: number | null;
  location_pref: string | null;
  timeline: string | null;
  source: string;
  segment: Segment;
  stage: Stage;
  do_not_contact: 0 | 1;
  last_contacted_at: string | null;
  contact_count: number;
  locked_at: string | null;
  locked_by: string | null;
}

export interface Interaction {
  id: number;
  lead_id: number;
  type: InteractionType;
  timestamp: string;
  detail: string | null;
}

export interface Proposal {
  id: number;
  lead_id: number;
  type: ProposalType;
  content: string;
  status: ProposalStatus;
  rejection_reason: string | null;
  proposed_time: string | null;
  created_at: string;
}

export interface AuditLogRow {
  id: number;
  lead_id: number | null;
  tool_name: string;
  input_json: string;
  output_json: string;
  timestamp: string;
  actor: Actor;
}

export interface Property {
  id: number;
  address: string;
  area: string;
  type: string;
  price: number;
  bedrooms: number;
  tier: PropertyTier;
}

export interface PropertyPriceHistory {
  id: number;
  property_id: number;
  year: number;
  avg_price: number;
}

export const RUN_OUTCOMES = ["escalated", "proposal_created", "sent", "no_action"] as const;
export type RunOutcomeKind = (typeof RUN_OUTCOMES)[number];

export interface RunMetric {
  id: number;
  lead_id: number;
  started_at: string;
  ended_at: string;
  outcome: RunOutcomeKind;
  tool_call_count: number;
  estimated_token_cost: number;
}
