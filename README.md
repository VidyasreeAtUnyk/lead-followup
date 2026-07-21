# Lead Follow-Up Agent

An autonomous real estate lead follow-up agent with a human approval step in the loop.
TypeScript, OpenAI function calling, SQLite (`node:sqlite`), Zod, plain CLI. No web UI.

Full design rationale, bugs found, and decision trail: [docs/prompts.md](docs/prompts.md).

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

`npm run cli -- process` (no id) drains the whole queue, showing a live spinner per lead and the
real remaining-quota count (requests/day *and* tokens/minute) after each one. `--limit <n>` caps
how many new leads a single pass touches; `cli quota` checks the same numbers standalone with one
minimal request. `cli close <leadId> <won|lost|canceled>` and `cli retry <leadId>` are human
actions (see [Human-in-the-loop](#human-in-the-loop)). `cli escalated` lists every escalated lead,
distinguishing a genuine park (`needs retry`) from a self-healing rate-limit hit.

```bash
npm run reset-db          # wipes data/leads.sqlite
npm run evals              # runs the 7 scripted scenarios against a throwaway db
npm run evals -- --quick   # 4/7, for cheaper local iteration -- run the full suite before submitting
npm run test               # 26 deterministic unit tests, no API key needed
npm run demo:resume        # kills the agent mid-run and shows it resumes correctly
npm run cli -- metrics     # aggregate run stats
npm run typecheck
```

Requires `OPENAI_API_KEY` in `.env`. Default model `gpt-5.4-mini`, override with `OPENAI_MODEL`.
Uses `node:sqlite` (Node ≥22.5, experimental but stable for this use) instead of `better-sqlite3`
for zero native dependencies.

---

## Design principles

- **The model owns control flow, not correctness.** `runAgentForLead` (`src/agent/loop.ts`) loops
  until the model calls a terminal tool (`propose_message`, `propose_viewing`, `send_message`,
  `escalate_to_agent`) or hits an 8-turn cap with safety-net escalation. Which tool, in what order,
  is entirely the model's call — legality is enforced beneath it, not in the prompt.
- **Tools are named around intent.** `propose_message`/`propose_viewing`/`send_message` are
  separate verbs, not one generic mutation, because the propose→approve→send split *is* the
  human-in-the-loop boundary and each has different legality rules.
- **Numeric grounding.** The model may only narrate prices/trends from `get_property_market_data`'s
  output, never originate them; `propose_message` rejects any unmatched `$`/`%` figure.
- **`send_message` is mocked** (logs `MOCK SEND`, updates lead state) — real delivery is out of
  scope; swapping in a provider is an isolated change to one tool.
- **No `close_deal` tool.** Whether a deal actually closed is a real-world fact the model can't
  observe — it's a human action (`cli close`), not something the model decides.

## Guardrails

Four, enforced inside each tool's `execute()`, independent of prompt wording — the prompt just
reduces wasted turns. Every tunable number (contact window/cap, reactivation freshness window,
turn cap, retry/backoff, lock timeout) lives in one place, `src/config/limits.ts`.

1. **Hard prohibition** — `send_message` and `propose_message` both independently refuse
   `do_not_contact` leads and unapproved sends; `check_contact_eligibility` is advisory only and
   has no bearing on enforcement (`src/tools/sendMessage.ts`, `proposeMessage.ts`).
2. **State machine** — `STAGE_EDGES` (`src/domain/stateMachine.ts`) is the sole source of legal
   transitions. Re-entry from `dormant`/`canceled` has exactly one door, `reactivate_lead`, which
   independently re-verifies the cited evidence (real row, right lead, qualifying type, ≤30 days).
3. **Contact-frequency cap** — no more than 3 sends per lead in a rolling 14-day window, checked
   live at send time (`src/tools/sendMessage.ts`).
4. **Numeric grounding** (stretch) — `checkNumericGrounding` (`src/domain/grounding.ts`) rejects
   any drafted `$`/`%` figure not verbatim from the most recent market-data call for that lead.

Every tool failure returns a typed `{ error, message }` (`src/domain/errors.ts`);
`dispatchToolCall` is the single choke point that validates input, runs the tool, and writes an
`audit_log` row unconditionally — so `history <leadId>` is a complete reconstruction from that
command alone.

**On prompt injection:** lead-submitted text (`interactions.detail`, `contact`) flows straight into
the model's context, unfiltered. Nothing prevents an injected instruction from appearing there. The
mitigation is structural, not prompt-level — every consequential tool re-checks its own rules in
code the model can't argue past, so an injection can change what the model *tries*, not what the
tools *allow*. Not specifically stress-tested; treat this as "covered by design," not "verified."

## Human-in-the-loop

`propose_message`/`propose_viewing` create a `pending` proposal and stop the run — no tool lets the
model skip approval. `cli approve`/`cli reject "<reason>"` are the only ways out of `pending`, both
audited with `actor: 'human'`. Approving un-blocks the lead so the *next* run sees the approved
proposal and sends it immediately; rejecting attaches the reason as feedback the next run must
actually address, not silently re-propose past.

**Escalation parking:** a lead whose last action was a genuine model-judgment `escalate_to_agent` is
excluded from the queue until a human runs `cli retry`. An internal-only `system_triggered` flag
(never exposed to the model) distinguishes that from the loop's own safety-net escalations
(LLM call failed, turns exhausted) — those don't park the lead, since an infrastructure hiccup isn't
a judgment call; the *next* `cli process` just picks it up again.

## Resumability

All state lives in SQLite, written synchronously as each tool call happens — nothing is held only
in memory. Killing the process mid-run and restarting resumes exactly where it left off, because
`get_lead_context` on the next run simply reflects whatever already committed. `npm run demo:resume`
proves this directly: spawns the agent as a child process, `SIGKILL`s it mid-run, then starts a
brand-new process (no shared memory) that continues from committed state to a real stopping point.

## Reliability

Built and tested against a genuinely constrained API quota, which forced real engineering:

- Retry with backoff+jitter on 429/5xx, failing fast (zero retries) when `retry-after` is too long
  to be worth waiting for.
- Graceful escalation, never a crash, when the LLM call fails after retries — classified `transient`
  (self-healing) vs. `parked` (genuine judgment call) so infrastructure hiccups don't permanently
  block a lead.
- Turn-batching in the prompt cut a typical run from ~5 turns to ~2-3, since each turn is one
  billable request regardless of tool-call count.
- Real quota visibility on *both* dimensions OpenAI enforces independently — requests/day and
  tokens/minute — since a run can 429 on an exhausted token bucket while requests/day looks
  perfectly healthy (found live, not assumed).
- `cli process --limit`, `evals --quick`, and `cli quota` all exist specifically so a small daily
  quota can't be drained by one careless invocation.

## Testing

**26 unit tests** (`npm test`, no API key): grounding parsing, retry/backoff, locking races,
escalation classification, quota capture, limit-capping. **7 scripted eval scenarios**
(`npm run evals`) against a real model, asserting final DB state — last full run: 7/7 passed live.

## Provider-agnostic proof

A side branch, `experiment/gemini-provider` (not part of this submission), swaps OpenAI for Gemini
behind the same entry point. The turn loop is duplicated rather than shared — deliberately, so the
graded path carries zero risk — but the guardrails, prompt, and audit trail are reused unchanged.
Same tests pass identically under a different model choosing the calls.

## What was deliberately cut

No web UI, no real send integration (SMS/email), no RAG/embeddings for property matching (plain
structured SQL filtering instead — the guardrail elsewhere already needs exact-match figures, so
semantic matching would add noise, not value), no `close_deal` tool (see above), no CLI polish
beyond what's needed to drive and observe the loop.

## Production readiness

In priority order, what stands between this and touching real leads:

1. **Compliance/consent tracking** beyond a boolean — audit-grade opt-in/opt-out timestamps and
   legal review (real estate outreach has real TCPA/Fair Housing exposure).
2. **Reliability** — retry/backoff and idempotent locking are implemented; a shared rate limiter
   across workers (not just per-process retry) is still missing at real scale.
3. **Observability** — `run_metrics` + `cli metrics` are a first step; a real deployment needs
   structured logging, alerting, and real cost monitoring.
4. **Incremental rollout** — ship draft-only first, measure approval rates, automate `send_message`
   only once that's proven — not all three stages at once, which this submission does by necessity.
5. The CLI stands in for a real inbox/CRM-integrated approval interface, not a UI to build out.

At 100× volume: a real job queue (not one linear DB scan with a lock column), batched context
fetches, a rate limiter shared across workers, and Postgres in place of SQLite for concurrent
writers — none of which requires changing the guardrail logic itself.
