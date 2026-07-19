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

`npm run cli -- process` (no id) drains the whole queue, one lead at a time.
`npm run cli -- close <leadId> <won|lost|canceled>` is the human action that records a
closed deal (see "Why there's no `close_deal` tool" below).

Other scripts:

```bash
npm run reset-db      # wipes data/leads.sqlite
npm run evals         # runs the 7 scripted scenarios in src/evals/run.ts against a throwaway db
npm run demo:resume   # kills the agent process mid-run and shows it resumes correctly (see below)
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
loop for both `prospect` and `client` leads. The only place `segment` matters is
`buildSystemPrompt`/the lead context handed to the model, which tells it to frame a `client`
lead's outreach as an upgrade pitch. A `won` transition flips `segment` and resets `stage` to
`new` in the exact same funnel — there is no second pipeline.

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
   `src/domain/stateMachine.ts`) before allowing another send, no matter what the model's plan was.

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

## What would change at 100× lead volume

- **A real job queue, not a single process.** `getQueue`/`processQueue` (`src/agent/queue.ts`,
  `src/agent/runQueue.ts`) currently do one linear DB scan and process leads serially in-process.
  At scale this becomes a proper queue (SQS/BullMQ/etc.) with many workers pulling leads, and
  `run_state`'s single-row "what am I resuming" design becomes a per-worker lease/heartbeat instead
  of one global row.
- **Batched context fetches.** `get_lead_context` does one lead + one interaction-history query
  per call; at volume you'd prefetch/batch these (e.g., load a worker's whole shard of leads'
  contexts in one query) rather than a round trip per lead per tool call.
- **Rate-limited, budgeted LLM calls.** Right now each run just calls the API and lets errors
  surface. At volume you'd want a token/request budget per run, backoff+retry on 429s (I hit this
  personally during development), and probably a cheaper/faster model for routine
  qualification-stage leads with escalation to a stronger model only for ambiguous cases.
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
  `history`, `approve`, `reject`), plus the `process`/`close` commands needed to actually drive the
  loop. No pagination, filtering flags, interactive prompts, etc.
- **Real send integrations, auth, deployment, RAG/embeddings, multi-agent setups** — all explicitly
  out of scope per the brief; `send_message` is mocked and clearly labeled as such.
