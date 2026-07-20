/**
 * Every tunable limit/threshold in the system, in one place -- both the
 * business-rule guardrails (contact frequency, reactivation evidence) and
 * the operational tuning knobs (retries, turn cap, lock timeout). The point
 * is that "what are our actual limits" is one file to read, not a hunt
 * across domain/agent/db modules. Each value's own comment explains why
 * that specific number, not just what it's called.
 */

// -- Contact & outreach guardrails --
// Enforced in src/tools/checkContactEligibility.ts (advisory) and
// src/tools/sendMessage.ts (the actual hard enforcement).

/** Rolling window (days) the outreach rate cap is measured over. */
export const CONTACT_WINDOW_DAYS = 14;

/** Max sends to one lead inside CONTACT_WINDOW_DAYS before send_message refuses. */
export const MAX_SENDS_IN_WINDOW = 3;

/** Unanswered outreach attempts (no reply/inquiry back) before a lead goes dormant. */
export const MAX_UNANSWERED_ATTEMPTS = 3;

// -- Reactivation evidence guardrail --
// Enforced in src/tools/reactivateLead.ts -- the only legal path back from
// dormant/canceled to contacted.

/** How fresh the cited evidence interaction must be to qualify for reactivation. */
export const REACTIVATION_EVIDENCE_MAX_AGE_DAYS = 30;

/** Interaction types that count as genuine re-engagement evidence. */
export const REACTIVATION_EVIDENCE_TYPES = ["inquiry", "reply"] as const;

// -- Agent loop (src/agent/loop.ts) --

/** Hard ceiling on assistant turns per run before force-escalating (safety net, not expected to bind). */
export const MAX_ASSISTANT_TURNS = 8;

/** Retry attempts on a retryable (429/5xx) completion failure before escalating. */
export const DEFAULT_MAX_RETRIES = 3;

/** Base delay for exponential backoff between retries, before jitter. */
export const DEFAULT_BASE_DELAY_MS = 1000;

// If the API's own retry-after is longer than this, no amount of in-process
// backoff will succeed before the caller gives up anyway (e.g. a daily quota
// that resets in hours, not seconds) -- fail fast instead of burning more
// requests against a quota that's already exhausted for no chance of success.
export const MAX_WORTHWHILE_RETRY_AFTER_SECONDS = 30;

// Rough blended estimate, not real pricing -- good enough to compare run cost
// relatively (e.g. "this run cost 3x that one"), not to reconcile a bill.
export const ESTIMATED_COST_PER_TOKEN = 0.0000005;

/** OpenAI model used for every agent turn; override via OPENAI_MODEL env var. */
export const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

// -- Concurrency (src/db/queries.ts) --

/** A lead lock older than this is treated as an abandoned/crashed worker and can be re-acquired. */
export const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
