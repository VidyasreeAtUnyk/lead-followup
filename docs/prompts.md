# Build log

A chronological decision log for this project: what was asked, what was decided, and why. Meant to
be skimmable by a teammate who wants the reasoning trail behind the codebase, not a chat export.
All entries below are from the same build session, 2026-07-20.

## Entry 1 — Domain selection

Asked to pick one domain from a shortlist (support triage, appointment scheduling, order returns,
restaurant reservations, recruitment screening, real estate lead follow-up) for an agentic-system
take-home. Chose real estate lead follow-up over the alternatives for three reasons: it's the
domain that actually maps to the hiring company's own product, rather than a generic example; it
carries genuine regulatory constraints (Fair Housing, contact-frequency norms) that produce an
authentic hard-prohibition guardrail instead of an invented one; and it doubles as something
actually usable afterward rather than a throwaway exercise. This decision shaped everything
downstream — the guardrails, the seed data, and the production-readiness discussion in the README
all trace back to real estate specifically having real compliance stakes.

## Entry 2 — Segment vs. stage modeling

Initially considered a single flat lead-status field, then redesigned into two orthogonal fields:
`segment` (`prospect`/`client`, flips exactly once and permanently when a deal reaches `won`) and
`stage` (funnel position, modeled as a graph, not a line, with a `dormant` side-branch and
re-entry rules). The reasoning: a flat status can't cleanly represent "existing client being
pitched an upgrade" without either a second parallel pipeline or special-casing every tool. With
`segment` and `stage` split apart, a cold prospect, a ghosted lead, a cancelled-then-returning
lead, and an existing client's upgrade pitch all live in exactly the same tools and the same stage
graph — `segment` just reshapes the drafting instructions handed to the model, never the control
flow.

## Entry 3 — Re-entry requires evidence, not agent discretion

Decided that `reactivate_lead(lead_id, evidence_interaction_id)` must require a real, recent
interaction row as evidence, rather than trusting the model's own judgment that "enough time has
passed" to re-approach a `dormant` or `canceled` lead. This became a state-machine-level guardrail
enforced inside the tool itself (checking the interaction's `lead_id`, `type`, and age against the
database), not a soft instruction in the prompt — the whole point is that the model's own reasoning
about timing can't be the thing standing between a lead and unwanted re-contact.

## Entry 4 — Contact boundary design (propose → approve → send)

The agent never contacts a lead directly. `propose_message` writes a `pending` row; a human
approves or rejects it via the CLI; only then can the agent call `send_message`, which
independently re-checks `proposal.status === 'approved'` inside the tool itself. The goal was to
keep the *entire* lifecycle — including the eventual send — as agent tool calls, so the model still
owns control flow end-to-end, while hard-gating the one action that actually reaches a real person
below the model's judgment. The system doesn't trust the model to "only send after it sees an
approval" conversationally; the tool enforces it regardless of what the model believes happened.

## Entry 5 — Property matching, scoped deliberately

`find_matching_properties` is plain structured SQL filtering on budget/location/type/bedrooms,
explicitly not RAG or embeddings — that was called out as out of scope in the brief and there was
no reason to reach for it anyway at this data size. It returns `insufficient_profile` explicitly
when a lead has none of budget/location/type on file, rather than guessing at a property to pitch.
That specific behavior became eval scenario 7: a minimal-profile lead should get a qualifying
discovery message, not a property pitch.

## Entry 6 — Numeric grounding principle

Decided early that `get_property_market_data` computes trend/price figures with plain deterministic
arithmetic — a percent change over the trailing data points and a linear-regression next-year
projection — and never via a model call, and that the agent may only *narrate* those numbers, never
originate its own. A fabricated number in a client-facing real estate message is a real liability,
not a cosmetic bug, so this was treated as a first-class design decision rather than an incidental
one. Went further and implemented it as an enforced guardrail on `propose_message` (the optional
stretch guardrail from the brief): any `$`/`%` figure in a draft must trace back to the most recent
market-data call for that lead, or the proposal is rejected with a typed error.

## Entry 7 — UI scope decision

The brief explicitly lists "UI polish" as out of scope. Considered building a plain web UI for the
submission anyway, decided against it — spending graded-property time on something explicitly
excluded had no upside. Built a formatted CLI instead (`chalk`/`cli-table3`: `dashboard`,
`proposals`, a readable `history`) — terminal formatting, not a UI layer — and deliberately budgeted
it at under an hour, built only after the seven graded properties (agent loop, guardrails,
resumability, human-in-the-loop, audit trail, evals, property matching) were solid.

## Entry 8 — Production-readiness review

After the initial build was complete, was asked directly: "is this production ready, is this how an
org would do it?" Answered honestly: no. Identified and prioritized the real gaps — compliance/
consent tracking as the biggest one (`do_not_contact` is a start, not audit-grade consent),
reliability (no retry/backoff on LLM calls, no protection against two workers processing the same
lead concurrently), observability (a domain audit trail exists via `audit_log`, but no ops-level
metrics — error rates, cost per run, human approval turnaround), and rollout strategy (a real org
ships draft-and-approve first and automates sending only after weeks of measuring approval rates,
not the full propose→approve→send flow at once, which is what this take-home necessarily
demonstrates in one submission).

## Entry 9 — Bug found in review, fixed with regression tests

While re-verifying the system live, the numeric-grounding guardrail false-positived on shorthand
like "$500k" — it was extracted and parsed as the literal number 500 (the "k" was silently
dropped), so it never matched any grounded figure and always got rejected, even though 500,000 is a
reasonable restatement of a number already grounded in that property's market data (it falls within
the guardrail's own tolerance of the projected next-year price). Fixed by normalizing k/K/m/M
shorthand and thousands-commas into a plain number before comparison (`parseMoneyToken`/
`parsePercentToken` in `src/domain/grounding.ts`), and added regression tests for the exact failing
case plus adjacent formats ("$1.2M", "1,200,000", "12%") plus an end-to-end test replaying the exact
draft sentence that originally triggered the bug, so this class of bug can't silently reappear.

## Entry 10 — Reliability/observability follow-up

Added the three other items identified in the production-readiness review, scoped to "prove the
mechanism, don't build the platform": exponential backoff with jitter on OpenAI 429/5xx responses
(3 retries, escalating gracefully with a clear logged reason instead of crashing once exhausted);
idempotent per-lead locking (`leads.locked_at`/`locked_by`, 5-minute abandonment timeout) so two
workers racing for the same lead only let one proceed; and a lightweight `run_metrics` table plus a
`metrics` CLI command (total runs, escalation rate, avg tool calls/run, estimated token cost,
average proposal-approval turnaround) as a first step toward real observability. All three were
verified with deterministic unit tests (`npm run test`, a stubbed OpenAI client, isolated in-memory
dbs) rather than live API calls, since the dev key's 50-request/day quota was already exhausted from
earlier live verification — the full eval suite (`npm run evals`) was re-run afterward to confirm no
regressions to the seven required scenarios.
