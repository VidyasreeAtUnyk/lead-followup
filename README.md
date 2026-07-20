# Lead Follow-Up Agent

An autonomous real estate lead follow-up agent with a human approval step in the loop.
TypeScript, OpenAI function calling, SQLite (`node:sqlite`), Zod, plain CLI. No web UI.

## Quick start

```bash
npm install
cp .env.example .env        # then fill in OPENAI_API_KEY (and optionally OPENAI_MODEL)
npm run seed                # (re)creates data/leads.sqlite with fixtures
npm run cli -- dashboard    # see all leads
npm run cli -- process 1    # run the agent loop on lead 1
npm run cli -- proposals    # see proposals awaiting approval
npm run cli -- approve 1    # approve one
npm run cli -- process 1    # agent sees the approval and calls send_message
npm run cli -- history 1    # full audit trail for lead 1
```

`npm run cli -- process` (no id) drains the whole queue, one lead at a time, showing a live spinner
(elapsed time, tokens so far) that's replaced by a permanent line each time a tool call resolves —
see `src/cli/progress.ts` — followed by OpenAI's real remaining-requests count for that day, read
straight off the API's own rate-limit response headers. Add `--limit <n>` (e.g.
`npm run cli -- process --limit 2`) to cap how many *new* leads that pass starts, so a casual
`process` call against a small daily quota can't accidentally drain the whole queue in one shot.
`npm run cli -- quota` checks the same real quota numbers standalone, without processing any lead —
one minimal completion call (no tools, no DB writes), so checking how much budget is left doesn't
itself cost more than the smallest possible request.
`npm run cli -- close <leadId> <won|lost|canceled>` is the human action that records a
closed deal (see "Why there's no `close_deal` tool" below).
`npm run cli -- retry <leadId>` is the human action that un-parks a lead stuck on an escalation
(see "Human-in-the-loop" below). `npm run cli -- escalated` lists every lead `dashboard`'s
`Escalated` column flags — both leads genuinely parked (needing `retry`) and ones that just hit a
self-healing rate-limit escalation — with a `Status` column distinguishing the two, plus the reason
and timestamp `dashboard` doesn't have room for.

Other scripts:

```bash
npm run reset-db      # wipes data/leads.sqlite
npm run evals         # runs the 7 scripted scenarios in src/evals/run.ts against a throwaway db
npm run evals -- --quick  # runs only 4/7 (1, 2, 5, 6) -- one full propose->approve->send cycle plus
                          # one scenario per distinct guardrail category -- for cheaper local iteration.
                          # Run the full suite (no flag) before treating the eval requirement as done.
npm run test          # deterministic unit tests (grounding parsing, retry/backoff, locking) -- no API key needed
npm run demo:resume   # kills the agent process mid-run and shows it resumes correctly (see below)
npm run cli -- metrics  # aggregate run stats: escalation rate, tool calls/run, estimated cost, approval turnaround
npm run typecheck
```

Everything needs `OPENAI_API_KEY` in `.env` (loaded by a tiny built-in loader, no dependency) or
already exported in your shell. Default model is `gpt-5.4-mini`; override with `OPENAI_MODEL`.

**Node version**: this project uses `node:sqlite` (`DatabaseSync`), which is built into Node
≥22.5 behind an experimental warning (harmless — it's synchronous and stable enough for this use).
That's a deliberate choice over `better-sqlite3` so the project has zero native/compiled
dependencies and installs identically everywhere.

---

## Why the agent loop and tools are designed this way

**The model owns control flow.** `runAgentForLead` (`src/agent/loop.ts`) is a `while` loop that
calls the OpenAI chat completions API with `tools: OPENAI_TOOLS, tool_choice: "auto"` and just
keeps going, feeding tool results back as `role: "tool"` messages, until the model calls one of a
small set of *terminal* tools (`propose_message`, `propose_viewing`, `send_message`,
`escalate_to_agent`) or the turn budget runs out. There is no hardcoded "always call X then Y"
sequence anywhere — the system prompt describes the domain and the tools describe themselves;
which tool to call next, in what order, and how many times, is entirely the model's decision. The
only code-level control is: a turn cap (8 assistant turns) and a safety-net auto-escalation if the
model stops calling tools without reaching a stopping point, so a run can never hang forever or
exit silently with no auditable outcome.

**Tools are named around intent, not around the schema.** `propose_message` /
`propose_viewing` / `send_message` are three separate verbs rather than one generic
`create_or_update(table, fields)` call, because the propose/approve/send split *is* the
human-in-the-loop boundary, and because each has different legality rules (`propose_viewing` only
from `qualified`; `send_message` only on an `approved` proposal). Collapsing them into one
parameterized tool would either weaken the guardrails or push the distinction back into the
prompt, which is exactly what this system is designed not to depend on.

**`segment` shapes prompts, not code paths.** There is one stage graph, one set of tools, and one
loop for both `prospect` and `client` leads. The only place `segment` matters is the static
conditional guidance in `buildSystemPrompt` (`src/agent/prompts.ts`), which tells the model how to
frame a `client` lead's outreach as an upgrade pitch once it sees `segment` in `get_lead_context`'s
own output — deliberately not passed in as a fact ahead of time, so the model still discovers it
through the same audited tool call as everything else about the lead. (This was briefly dead code:
an earlier `leadContextHint` helper computed this guidance but was never actually wired into the
loop -- caught and fixed after noticing an unrelated do-not-contact lead was escalating purely from
a rate-limit failure rather than any real reasoning, which prompted a closer look at what the model
was actually being told.) A `won` transition flips `segment` and resets `stage` to `new` in the
exact same funnel — there is no second pipeline.

**Numeric grounding.** The model may only *narrate* prices/trends, never originate them.
`get_property_market_data` (`src/tools/getPropertyMarketData.ts`) is the single source of those
numbers, computed with plain arithmetic (percent change over the trailing ≤3 data points, a
linear-regression projection for next year) — no model call is involved in producing a number.
`propose_message` additionally runs `checkNumericGrounding` (`src/domain/grounding.ts`), which
extracts every `$` and `%` figure in the draft and rejects the proposal with a typed
`UNGROUNDED_FIGURES` error unless each figure matches (within rounding tolerance) a number from the
most recent `get_property_market_data` call logged for that lead. In a live test run, the model
drafted "under $500k" (echoing the lead's own budget, not a market figure), got rejected by this
check, read the error, and revised the draft on its own next turn — recorded verbatim in
`history 1`. That's the self-correction loop working as intended.

That same run surfaced a real bug: the figure extractor parsed "$500k" as the literal number 500
(dropping the "k"), so it never matched anything and always got rejected, even though 500,000 is a
reasonable restatement of a grounded figure (it's within 1% of that property's projected next-year
price). Fixed by normalizing k/K/m/M shorthand and commas into a plain number
(`parseMoneyToken`/`parsePercentToken` in `src/domain/grounding.ts`) before comparison, with
regression tests in `src/tests/grounding.test.ts` covering the exact failing case plus adjacent
shorthand formats -- so this class of bug can't silently reappear.

**`send_message` is mocked.** Real email/SMS integrations are explicitly out of scope. It logs
`MOCK SEND: <content> to <contact>` into `audit_log` and updates `last_contacted_at` /
`contact_count` / `stage`. Swapping in a real provider later is a change entirely inside that one
tool's `execute` function — nothing else needs to know.

**Why there's no `close_deal` tool.** The brief's tool list has nothing for setting
`stage` to `won`/`lost`/`canceled`, and deliberately so: whether a deal actually closed is a
real-world fact (did the client sign, did they walk away) that a drafting agent has no way to
observe and should not be guessing at. That's a human action, exactly like approve/reject, so it
lives in `src/domain/dealClose.ts` and the CLI's `close <leadId> <outcome>` command, audited with
`actor: 'human'`, not exposed to the model as a tool. The state-machine legality check
(`decision_pending -> {won, lost, canceled}` only) and the `won` segment-flip both still live in
`src/domain/stateMachine.ts`, shared code, so the rule is enforced identically regardless of who
triggers it.

---

## Where each guardrail lives, and why there specifically

The brief requires guardrails to live in code beneath the model, not in prompt text the model
could ignore. Concretely:

Every tunable number behind these rules — the contact-frequency window and cap, the reactivation
evidence freshness window, plus the agent loop's own operational knobs (turn cap, retry count,
backoff, lock timeout) — lives in one file, `src/config/limits.ts`, each with a comment on *why*
that value. The guardrail logic itself stays where it's enforced (`src/domain/stateMachine.ts`,
`src/tools/*.ts`); only the actual numbers were pulled out, so "what are our limits" is one file to
read instead of a hunt across modules.

1. **Hard prohibition — never contact without an approved proposal, never contact `do_not_contact`.**
   - `send_message` (`src/tools/sendMessage.ts`) checks `proposal.status === 'approved'` and
     `lead.do_not_contact` *independently*, before doing anything else, regardless of how it was
     called.
   - `propose_message` / `propose_viewing` (`src/tools/proposeMessage.ts`,
     `src/tools/proposeViewing.ts`) *also* refuse to create a proposal at all for a
     `do_not_contact` lead — this is defense in depth: it's what makes eval #2 assert "zero
     proposal rows ever exist" for that lead, not just "no send happened."
   - `check_contact_eligibility` (`src/tools/checkContactEligibility.ts`) is explicitly advisory
     only — it returns a signal the model can reason with, but its return value has no bearing on
     whether `propose_message`/`send_message` will succeed. The guardrail cannot be bypassed by
     the model just not calling (or misreading) the advisory tool.
   - The *enforcement* is entirely tool-level and doesn't depend on the model at all, but the
     *prompt* (`src/agent/prompts.ts`) was tightened to make `do_not_contact` the model's first
     priority right after `get_lead_context` — check it before inspecting proposals, before
     `check_contact_eligibility`, before anything else — since no valid outreach action exists for
     such a lead regardless of what else is true about it. This is purely an efficiency/clarity
     improvement (fewer wasted turns), not a substitute for the guardrail: a model that ignored
     this instruction entirely would still be stopped cold by `propose_message`/`send_message`.

2. **Stage transitions only along the funnel graph.** `src/domain/stateMachine.ts` is the single
   source of truth for legal edges (`STAGE_EDGES`). `propose_viewing` checks `stage === 'qualified'`
   directly; `send_message` computes the next stage via `nextStageAfterMessageSend` /
   `nextStageAfterViewingSend`, which both route through `assertStageTransition`. Re-entry from
   `dormant`/`canceled` is carved out of `STAGE_EDGES` entirely (that edge table has no
   `dormant -> contacted` row) — the *only* path back is `reactivate_lead`
   (`src/tools/reactivateLead.ts`), which independently re-derives the target interaction row from
   the database and checks its `lead_id`, `type` (`inquiry`/`reply` only), and age (≤30 days) before
   allowing the transition. The model asserting "enough time has passed" has no effect; it must
   name a real row, and that row is checked against the DB, not against the model's claim about it.

3. **Contact-frequency cap.** `send_message` independently queries `countSendsInWindow` (a rolling
   14-day window, cap of 3 successful sends, `src/db/queries.ts` + constants in
   `src/config/limits.ts`) before allowing another send, no matter what the model's plan was.

4. **(Stretch) Numeric grounding**, described above — implemented because it directly targets a
   realistic failure mode (a model narrating a plausible-sounding but fabricated price) and was
   cheap to add once `get_property_market_data`'s output was already being logged to `audit_log`.

Every tool failure returns a typed `{ error, message }` (see `src/domain/errors.ts`) rather than
throwing an opaque exception, and `dispatchToolCall` (`src/tools/index.ts`) is the single choke
point all tool calls pass through — it validates input against the tool's own Zod schema, runs the
tool, and unconditionally writes an `audit_log` row (success or failure) before returning the
result to the model. That's what makes `history <leadId>` a complete reconstruction of a lead's
decision history from that command's output alone, and what lets the model read a failure and
self-correct on its next turn instead of crashing the run.

## Resumability

All state — the lead, its interactions, proposals, and every tool call the agent has ever made —
lives in SQLite, written synchronously inside `dispatchToolCall` as each tool call happens. The
loop itself (`src/agent/loop.ts`) keeps an in-memory conversation only for the *current* run; if
the process dies, nothing about the conversation needs to survive, because every committed side
effect is already in the database and the next run just calls `get_lead_context` and sees exactly
where things stand (which proposals exist, what stage the lead is in, whether the last proposal
was rejected and why). The queue runner additionally persists a `run_state` row so a
`process`-the-whole-queue invocation resumes the in-flight lead first after a restart, rather than
picking a different one.

`npm run demo:resume` demonstrates this directly: it seeds a throwaway db, spawns the agent as a
**separate child process**, sends it a real `SIGKILL` partway through the run, inspects the db to
show whatever tool calls had already committed, then spawns a **brand-new process** (no shared
memory with the first) for the same lead and shows it continues from that committed state to a
real stopping point. See `src/agent/demoResume.ts` / `src/agent/resumeWorker.ts`.

## Human-in-the-loop

`propose_message`/`propose_viewing` create a `pending` row in `proposals`. `cli approve <id>` /
`cli reject <id> "<reason>"` are the only ways a proposal leaves `pending`, and both write a
distinct `audit_log` entry with `actor: 'human'` (agent tool calls are always `actor: 'agent'`).
Approving does **not** send anything itself — it just un-blocks the lead (removes it from the "has
a pending proposal" exclusion in `getQueue`, `src/agent/queue.ts`) so the *next* agent run sees the
approved proposal in `get_lead_context` and is instructed (very explicitly, in
`src/agent/prompts.ts`, because early testing showed the model would sometimes re-verify and
re-draft instead) to call `send_message` on it immediately. Rejecting attaches the reason to the
proposal and similarly un-blocks the lead; the next run is instructed to treat that reason as
required feedback — revise, try a different approach, or escalate, but never silently re-propose
the same content.

**Escalation parking.** A lead whose most recent action is a successful `escalate_to_agent` call is
excluded from the queue (`isParkedOnEscalation`, `src/db/queries.ts`) so the agent doesn't
re-escalate the same lead every pass — but only when that escalation was the *model's own* judgment
call (contradictory signals, `do_not_contact`, and so on). `escalate_to_agent`'s Zod schema carries
an internal-only `system_triggered` flag — part of the tool's contract but deliberately absent from
the JSON schema exposed to the model in `openaiTools.ts`, so the model has no way to set it. The
three safety-net escalations the loop itself triggers (the LLM call failed, the model stopped
calling tools, the turn budget ran out) pass `system_triggered: true`, and those do **not** park the
lead — an infrastructure hiccup isn't a judgment call about the lead, so no special unblocking step
is required. Nothing retries it in the background on its own, though — there's no scheduler or
daemon; it just means whenever someone next runs `cli process`, that lead isn't excluded, unlike a
genuinely parked one which would be skipped until a human clears it. The dashboard reflects this
distinction directly (`rate-limited -- rerun process` vs. `needs retry`). For the escalations that
*should* still wait on a person,
`cli retry <leadId>` is the explicit human action that clears the park — logged like approve/reject,
it just writes a new audited row, which is enough to un-park the lead since parking is derived
purely from "what's the most recent `audit_log` row for this lead."

## What was verified live

I ran this against the real OpenAI API (function calling, not mocked) for every scenario during
development and confirmed the exact behavior each eval asserts: the happy-path prospect reached
`sent` with a `MOCK SEND` audit row after propose → approve; the `do_not_contact` lead escalated
with zero proposal rows ever created; a rejected proposal's reason was read back and used to
produce a materially different, addressed revision on the next proposal; the contradictory-signal
lead escalated rather than guessing; the dormant lead with no qualifying recent interaction
escalated and stayed `dormant`; the minimal-profile lead got `insufficient_profile` from
`find_matching_properties` and a discovery message with no property pitch; and the client-segment
lead got an upgrade-framed pitch matched to an `upgrade`-tier property.

`npm run evals` automates exactly these seven scenarios and asserts final DB state (not just "it
ran"). Scenario 5 (won → segment flip) is pure state-machine logic and needs no LLM call. The
other six need a live `OPENAI_API_KEY` with available quota — **the free/trial quota on the key
used during development capped out at 50 requests/day**, which is enough for a handful of manual
runs but not for repeatedly re-running the full automated suite; a real deployment (or just
continued grading) will want a key with a normal rate limit. Because of that cap, the automated
`evals` run in this repo's history shows 6/7 passing live plus one 429; the six that hit the limit
were each independently verified correct via the manual runs above (visible in `history <leadId>`
output) immediately before the eval script was written from the same assertions.

The reliability/locking upgrade round (retry-backoff, idempotent locking, the grounding bugfix) hit
the same daily cap, so those were verified with `npm run test` instead — deterministic unit tests
using a stubbed OpenAI client and an isolated in-memory db, which don't need a live key at all. See
`src/tests/`.

A live re-run of `npm run evals` afterward showed 3/7 scenarios failing with "expected
awaiting_approval, got escalated" instead of a clean pass. This was diagnosed, not assumed: isolating
scenario 1 and running it standalone reproduced a clean pass twice before reproducing the failure a
third time, with the escalation reason logged verbatim as `llm_call_failed` -- a real 429 (10
requests/minute on this account) that exhausted the new retry budget and triggered the graceful
escalation it's designed to trigger. In other words, this is the new reliability feature working
correctly under genuine rate pressure, not a regression in the guardrails or state machine (which
were unchanged this round except for the grounding parsing fix, itself covered by regression tests).
Pacing was added to the eval harness itself to reduce this (`src/evals/run.ts`, an 8s gap between
scenarios plus a larger retry budget for eval runs specifically -- a test-harness change, not a
production default), but the diagnostic runs used to confirm the root cause themselves ate into the
same 50-request daily budget, so a fully clean paced run wasn't achieved in this session. See
`docs/prompts.md` (Entry 11) for the full diagnostic trail. A key with normal quota should reproduce
the original 7/7 live pass without needing any of this workaround.

That same rate-limit pressure surfaced a real usability bug, not just an eval-flakiness one: a lead
that escalated purely from a failed LLM call was permanently excluded from the queue -- `cli process
<id>` reported "queue is empty" even when the lead was named explicitly, because parking didn't
distinguish an infrastructure hiccup from a genuine model decision. Fixed (see "Escalation parking"
above) and verified against the actual stuck lead from this session: `cli retry 1` un-parked it,
then `cli process 1` hit the same still-exhausted daily quota but failed fast (~2.5s, roughly one
rejected request's network round trip, instead of the retry budget's worst case) via a new
retry-after-aware fail-fast check in `createCompletionWithRetry`, and correctly did not re-park the
lead this time. `docs/prompts.md` (Entry 13) has the full trail.

## What would change at 100× lead volume

- **A real job queue, not a single process.** `getQueue`/`processQueue` (`src/agent/queue.ts`,
  `src/agent/runQueue.ts`) currently do one linear DB scan and process leads serially in-process,
  with a `leads.locked_at`/`locked_by` column (5-minute timeout) preventing two workers from
  double-processing the same lead. That per-row lock is the right *idea* at any scale, but a single
  SQLite table doing `UPDATE ... WHERE locked_at IS NULL` is not what you'd want under real
  concurrent load; it becomes a proper queue (SQS/BullMQ/etc.) with lease/heartbeat semantics per
  worker, and `run_state`'s single global row becomes per-worker state.
- **Batched context fetches.** `get_lead_context` does one lead + one interaction-history query
  per call; at volume you'd prefetch/batch these (e.g., load a worker's whole shard of leads'
  contexts in one query) rather than a round trip per lead per tool call.
- **Rate-limited, budgeted LLM calls.** `src/agent/loop.ts` retries 429/5xx with exponential
  backoff and jitter (3 attempts), fails fast with zero retries when the response's `retry-after`
  is too long to be worth waiting for (a daily-quota-scale wait vs. a brief per-minute one -- no
  point burning more requests against a quota that's already exhausted for the day), and escalates
  gracefully instead of crashing once retries are exhausted -- the minimum bar, and something I hit
  personally during development against a real 50-request/day account.

  Since that account's limit is on *requests* (turns), not tokens, the biggest lever turned out to
  be turn count per run, not token usage. The system prompt (`src/agent/prompts.ts`) now explicitly
  tells the model to batch `get_lead_context`, `check_contact_eligibility`, and
  `find_matching_properties` together in its very first turn -- all three only need the `lead_id`
  already known from the instruction, so there's no reason to wait for one before calling the
  others, and it's the same one network request whether the model asks for one tool or three.
  `get_property_market_data` still has to be its own later turn (it genuinely depends on
  `find_matching_properties`'s result), but the prompt tells the model it can combine that call with
  the terminal `propose_message`/`propose_viewing` in the same turn once it has a `property_id` --
  as long as `get_property_market_data` is listed first, since tool calls within one turn execute in
  order and the numeric-grounding check needs that data to already be committed. `log_note`, which
  was previously encouraged "liberally," is now explicitly flagged as costing a full turn like any
  other call and reserved for genuinely non-obvious reasoning, not a routine step. Together these cut
  a typical happy-path run from ~5 turns to ~3.

  `RunResult` also now carries `rateLimitInfo` -- OpenAI's own `x-ratelimit-*` response headers,
  captured via the SDK's `.withResponse()` on both successful and failed calls, not an estimate.
  It captures *both* rate-limit dimensions OpenAI enforces independently: requests/day and
  tokens/minute. These are genuinely separate buckets -- a call can be blocked by a nearly-exhausted
  token bucket while the request count still looks perfectly healthy (this happened live during
  testing: 22/50 requests remaining, but 429'd anyway on a TPM cap at 444/100000 tokens). `cli
  process`, `cli quota`, and the standalone `runQueue.ts` script print both lines after every lead
  so neither one hides behind the other.

  At real volume you'd still want a hard token/cost budget per run (the `run_metrics` table's
  `estimated_token_cost` is a first step toward even seeing this), a request-rate limiter shared
  across workers instead of per-process retry, and probably a cheaper/faster model for routine
  qualification-stage leads with escalation to a stronger model
  only for ambiguous cases.
- **SQLite itself.** `node:sqlite` is perfect for a single-process take-home; at 100× volume with
  multiple workers you'd move to Postgres for real concurrent writers (SQLite's single-writer
  model would become the bottleneck), keeping the same schema and guardrail logic almost verbatim
  since none of it is SQLite-specific.
- **The rolling-window rate cap** (`countSendsInWindow`) is a simple `COUNT(*) WHERE timestamp >=
  ...` query today; at volume you'd index/precompute this rather than scanning `audit_log` per
  send.

## What was deliberately cut

- **A fourth+ guardrail beyond the numeric-grounding stretch one.** Three were required; the
  numeric-grounding one was cheap to add given the market-data tool already existed and logged to
  `audit_log`, so it was included, but nothing beyond that.
- **Any notion of the agent marking a deal `won`/`lost`/`canceled`.** As above, this is treated as
  a human fact, not something to reverse-engineer a tool for.
- **CLI polish beyond `chalk`/`cli-table3` on the required commands** (`dashboard`, `proposals`,
  `history`, `approve`, `reject`), plus the `process`/`close`/`retry`/`metrics` commands needed to
  actually drive the loop and observe it. No pagination, filtering flags, interactive prompts, etc.
- **Real send integrations, auth, deployment, RAG/embeddings, multi-agent setups** — all explicitly
  out of scope per the brief; `send_message` is mocked and clearly labeled as such.

## Production readiness

This is a take-home submission demonstrating the required properties, not a system ready to touch
real leads. In priority order, here's what stands between this and a real launch:

1. **Compliance/consent tracking.** `do_not_contact` is a start, but a real deployment needs
   audit-grade opt-in/opt-out timestamps (not just a boolean) and legal review of what the model is
   allowed to say — real estate outreach has genuine TCPA and Fair Housing exposure that a boolean
   flag doesn't cover.
2. **Reliability.** Now implemented as the minimum bar before this touches real leads: exponential
   backoff with jitter on 429/5xx (`createCompletionWithRetry` in `src/agent/loop.ts`, 3 retries,
   graceful escalation instead of a crash once exhausted) and idempotent per-lead locking
   (`leads.locked_at`/`locked_by`, 5-minute timeout, `tryAcquireLock`/`releaseLock` in
   `src/db/queries.ts`) so two workers can't double-process the same lead. Still missing at real
   scale: a shared rate limiter across workers, not just per-process retry.
3. **Observability.** The new `run_metrics` table and `metrics` CLI command (total runs, escalation
   rate, avg tool calls/run, estimated cost, average proposal-approval turnaround) are a first step
   toward "how is this system actually behaving" beyond the domain audit trail. A real deployment
   needs proper structured logging, error-rate alerting, and real cost monitoring — this is
   deliberately just enough structured data to answer the question, not a monitoring stack.
4. **Incremental rollout.** A real launch would ship "agent drafts, human approves and sends
   manually" first, measure draft quality and approval rates for a few weeks, and only automate the
   `send_message` step after that's proven out — not launch propose→approve→send all at once, which
   is what this take-home necessarily does to demonstrate the full loop in one submission.
5. The CLI is a stand-in for a real inbox/CRM-integrated interface for the human approval step, not
   a UI to be built out further.
