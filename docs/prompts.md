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
earlier live verification. See Entry 11 for what happened when the live eval suite was re-run
afterward.

## Entry 11 — Live eval re-run surfaced rate limiting, not a regression

Re-ran `npm run evals` live once the dev key's quota appeared to free up partway through the
session. First attempt: 2/7 scenarios failed with "expected awaiting_approval, got escalated" on
scenarios 1 and 3. Diagnosed by reproducing scenario 1 standalone with full audit-log output —
it succeeded cleanly on the first two reproductions, which ruled out a deterministic code bug and
pointed at rate-limit flakiness instead. A third reproduction confirmed it directly: the escalation
was `llm_call_failed` with the underlying error being a 429 on requests-per-minute (limit 10/min) —
i.e. the new retry/backoff feature correctly rode out what it could and gracefully escalated once
its retry budget was exhausted, exactly as designed. That's the reliability feature working, not a
defect in it.

Added pacing to the eval harness itself (an 8-second gap between scenarios, a more generous
retry budget for eval runs specifically) since this is a test-harness concern, not a change to
production defaults or domain logic. Re-ran the full suite again: 3/7 failed this time, worse than
before, with the same escalation signature starting on scenario 1 immediately. Root cause: the
diagnostic reproductions used to confirm the RPM theory themselves consumed a meaningful slice of
the day's 50-request cap, so the very quota needed for a clean full run was partly gone before the
paced attempt even started. Decided not to keep spending the remaining daily budget chasing a clean
run (each attempt burns quota that could complete a future clean one) and to document this
precisely instead: the seven scenarios' domain logic is unchanged and was fully verified live before
this upgrade round (see the original README section on what was verified live); this round's new
code (grounding fix, retry/backoff, locking, metrics) was verified deterministically via `npm run
test` (15/15 passing, no API key needed); and the only new *failure mode* introduced is that a
sufficiently rate-limited account can turn a would-be `awaiting_approval` into an `escalated` --
which is the intended graceful-degradation behavior, not silent corruption or a crash. A fresh
`npm run evals` run on a day with unused quota (or a higher-tier key) should reproduce the original
7/7 pass; this is flagged as a known limitation of verifying against a free-tier key rather than a
gap in the implementation.

## Entry 12 — Live progress display for `cli process`

Asked to show live progress while a run is in flight -- elapsed time, tokens used, current tool --
similar to how Claude Code's own CLI shows its status. Added an optional `onProgress` callback to
`runAgentForLead`, firing on every "thinking" (about to call OpenAI) and "tool_call" (a tool just
resolved) tick with the turn number, tool name, and cumulative token count. `processQueue` forwards
this per-lead. `cli/progress.ts` renders it as a spinner (elapsed time, tokens) that gets replaced
by a permanent checkmark line each time a tool call completes, ending in a final outcome line.
Purely additive -- the callback is optional everywhere, so nothing about evals/tests/resumability
changes when it isn't supplied. Verified with a deterministic test (a scripted fake OpenAI client
returning canned tool calls, no live API needed) confirming the exact event sequence and token
counts, plus a direct visual check of the renderer's raw terminal output.

## Entry 13 — Escalation parking was too coarse, plus request-efficiency pass

Using the new progress display surfaced a real usability gap: a lead that had escalated purely
because the LLM call itself failed (a 429 during earlier testing) was permanently excluded from the
queue -- `cli process 1` reported "queue is empty" even when explicitly naming the lead, because
`isParkedOnEscalation` treated every escalation identically, whether the model made a genuine
judgment call (contradictory signals, do-not-contact) or the agent loop's own safety net gave up
after an infrastructure hiccup. There was also no way to un-park a lead short of wiping the database.

Fixed both, plus a related efficiency ask (the dev account's 50-request/day cap): `escalate_to_agent`
gained an internal-only `system_triggered` flag on its Zod schema -- present in the tool's contract
but deliberately absent from the JSON schema exposed to the model in `openaiTools.ts`, so the model
has no way to set it. The three safety-net call sites in `loop.ts` (LLM call failed, no tool call
returned, turn budget exceeded) now pass `system_triggered: true`; `isParkedOnEscalation` only parks
on an escalation where that flag is absent, i.e. one the model itself chose to make. A rate-limited
lead is simply no longer excluded from the queue, so the next time someone runs `process` (no
scheduler or background retry -- that still requires a person or script to invoke it) it's attempted
like any other lead, with no special unblocking step first. For the cases that
should still require a person (a genuine business escalation), added `cli retry <leadId>` -- a
human action, audited like approve/reject, that simply writes a new audit row so the lead falls out
of the park automatically (parking is derived purely from "what's the most recent audit_log row,"
so any newer row un-parks it without special-casing).

For the efficiency half of the ask: added a fail-fast path to the retry/backoff logic --
`createCompletionWithRetry` now reads the `retry-after` value off a 429's response headers, and if
it's longer than 30 seconds (a daily-quota-scale wait, not a brief per-minute one), skips all
retries and escalates immediately rather than burning 3+ more doomed requests against an already-
exhausted quota. Also added explicit prompt guidance (`prompts.ts`) encouraging the model to batch
independent read-only tool calls (get_lead_context, check_contact_eligibility,
find_matching_properties, get_property_market_data) into a single turn rather than one at a time,
since each turn is a full request against the rate limit regardless of how many tool calls it
contains. Verified all of this with new deterministic tests (`escalation.test.ts`, plus two new
cases in `retry.test.ts` for the fail-fast/still-retries-short-waits behavior), then confirmed live
against the actual parked lead from the session: `cli retry 1` un-parked it, `cli process 1` hit the
same still-exhausted daily quota but failed fast (~2.5s, consistent with one rejected request and no
wasted retries) and correctly did not re-park the lead this time.

## Entry 14 — Dashboard indicator was misleading, twice

Asked to explain why the dashboard still showed a lead's stage as `new` and "Escalated: no" right
after `cli process` had just printed `escalated`. Both were correct but the second one exposed a
real bug: the initial "Escalated" column collapsed "nothing has happened" and "the last run just
failed on a rate limit but isn't blocked" into the same `no`, which read as "nothing happened" right
after the user watched it escalate. Fixed by replacing the boolean with a three-state
`getEscalationStatus` ("none" / "transient" / "parked") so the dashboard can say `rate-limited,
retrying` distinctly from a lead that was never touched.

That label was then challenged directly: "is it really trying?" It wasn't -- "retrying" implied an
ongoing background process, but nothing runs on a schedule or daemon; the fail-fast logic from Entry
13 means zero retries happened within that failed call, and nothing will attempt the lead again
until a person (or script) explicitly runs `cli process` a second time. Relabeled to `rate-limited --
rerun process` and corrected the same overclaim ("retried automatically") everywhere it appeared --
README, this file, and the code comments in `queries.ts` -- to say plainly that the lead is merely
*not excluded* from the queue, not that anything is actively retrying it. Worth remembering as a
pattern: "automatically" and "self-heals" are easy words to reach for when describing a passive
"not blocked" state, and both overclaim unless something genuinely runs without being invoked.
