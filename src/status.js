/**
 * Verdict derivation.
 *
 * Every state handled here is a REAL state emitted by the Reliastra backend.
 * Nothing in this file invents a status the API cannot return. The mapping is
 * transcribed from:
 *
 *   backend/app/modules/checks/constants.py   -> CheckState, TARGET_STATES,
 *                                                INFRASTRUCTURE_STATES
 *   backend/app/modules/checks/schemas.py     -> CheckStateResponse
 *   backend/app/modules/dependencies/schemas.py -> alert_threshold_ms
 *
 * The important design decision: `degraded` is NOT a Reliastra vendor status.
 * The backend has no such state. It is DERIVED here, from two real fields, and
 * it is labelled as derived everywhere it is displayed. A reader of the job
 * summary must never think Reliastra published a vendor degradation verdict.
 */

import { usageError } from "./exits.js";

/** CheckState, verbatim from checks/constants.py. */
export const CHECK_STATE = Object.freeze({
  NEVER_CHECKED: "never_checked",
  AWAITING_SCHEDULE: "awaiting_scheduled_execution",
  QUEUED: "queued",
  EXECUTING: "executing",
  SUCCESSFUL: "successful",
  TARGET_FAILED: "target_failed",
  BLOCKED_BY_SECURITY_POLICY: "blocked_by_security_policy",
  DISPATCH_FAILED: "dispatch_failed",
  SCHEDULER_UNAVAILABLE: "scheduler_unavailable",
});

/** checks/constants.py TARGET_STATES. */
const TARGET_STATES = new Set([CHECK_STATE.SUCCESSFUL, CHECK_STATE.TARGET_FAILED]);

/** checks/constants.py INFRASTRUCTURE_STATES. RELIASTRA's own fault. */
const INFRASTRUCTURE_STATES = new Set([
  CHECK_STATE.DISPATCH_FAILED,
  CHECK_STATE.SCHEDULER_UNAVAILABLE,
]);

/** The probe never produced an observation. Nothing can be concluded. */
const UNVERIFIED_STATES = new Set([
  CHECK_STATE.NEVER_CHECKED,
  CHECK_STATE.AWAITING_SCHEDULE,
  CHECK_STATE.QUEUED,
  CHECK_STATE.EXECUTING,
]);

export const VERDICT = Object.freeze({
  UP: "up",
  DEGRADED: "degraded",
  DOWN: "down",
  BLOCKED: "blocked",
  UNVERIFIED: "unverified",
  PIPELINE_ERROR: "pipeline-error",
});

/**
 * Every condition fail-on may match against, in display order.
 * `stale` is orthogonal to the verdict: an observation can be both `up` and
 * `stale`, and a CI gate should be able to fail on either.
 */
export const CONDITIONS = Object.freeze([
  VERDICT.UP,
  VERDICT.DEGRADED,
  VERDICT.DOWN,
  VERDICT.BLOCKED,
  VERDICT.UNVERIFIED,
  VERDICT.PIPELINE_ERROR,
  "stale",
]);

/** Per-verdict one-line meaning, shown in the summary so nobody guesses. */
export const VERDICT_MEANING = Object.freeze({
  [VERDICT.UP]: "Last probe reached the target and it succeeded.",
  [VERDICT.DEGRADED]:
    "Derived, not a Reliastra status: the target answered successfully but latency met or exceeded the configured threshold.",
  [VERDICT.DOWN]: "The last probe reached the target and it failed.",
  [VERDICT.BLOCKED]:
    "Reliastra refused to send the probe (SSRF policy). This is an endpoint configuration problem, NOT a vendor outage.",
  [VERDICT.UNVERIFIED]:
    "No observation exists yet. Nothing can be concluded about the target.",
  [VERDICT.PIPELINE_ERROR]:
    "Reliastra could not run the probe (scheduler or broker). This is our failure, not the vendor's.",
});

/**
 * Turn one CheckStateResponse into a verdict.
 *
 * Unknown states throw rather than defaulting. If the backend adds a state,
 * this action must fail loudly on the contract drift instead of quietly
 * reporting something nobody verified.
 *
 * @param {object} input
 * @param {string} input.state              CheckStateResponse.state
 * @param {object|null} [input.lastResult]  CheckStateResponse.last_result
 * @param {number|null} [input.latencyThresholdMs] resolved threshold, or null
 * @param {boolean} [input.isStale]         CheckStateResponse.is_stale
 */
export function deriveVerdict({ state, lastResult = null, latencyThresholdMs = null, isStale = false }) {
  const latencyMs = numberOrNull(lastResult?.latency_ms);
  const statusCode = numberOrNull(lastResult?.status_code);

  // RELIASTRA's own pipeline failed. Highest precedence: it would be wrong to
  // report this as a vendor problem.
  if (INFRASTRUCTURE_STATES.has(state)) {
    return { verdict: VERDICT.PIPELINE_ERROR, latencyMs, statusCode, stale: isStale, degraded: false };
  }

  // SSRF refusal. Never a vendor outage.
  if (state === CHECK_STATE.BLOCKED_BY_SECURITY_POLICY) {
    return { verdict: VERDICT.BLOCKED, latencyMs, statusCode, stale: isStale, degraded: false };
  }

  if (UNVERIFIED_STATES.has(state)) {
    return { verdict: VERDICT.UNVERIFIED, latencyMs, statusCode, stale: isStale, degraded: false };
  }

  if (state === CHECK_STATE.TARGET_FAILED) {
    return { verdict: VERDICT.DOWN, latencyMs, statusCode, stale: isStale, degraded: false };
  }

  if (TARGET_STATES.has(state) && state === CHECK_STATE.SUCCESSFUL) {
    // `successful` with no recorded result is a contract violation, not an up.
    if (!lastResult) {
      return { verdict: VERDICT.UNVERIFIED, latencyMs, statusCode, stale: isStale, degraded: false };
    }
    const degraded =
      latencyThresholdMs !== null && latencyMs !== null && latencyMs >= latencyThresholdMs;
    return {
      verdict: degraded ? VERDICT.DEGRADED : VERDICT.UP,
      latencyMs,
      statusCode,
      stale: isStale,
      degraded,
    };
  }

  throw usageError(
    `Unrecognised check state "${state}".`,
    "The Reliastra API returned a state this action does not know. Refusing to guess. " +
      "Check the action version against the API contract in " +
      "backend/app/modules/checks/constants.py, then file an issue if the API changed.",
  );
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse the `fail-on` input into a set of conditions.
 *
 * Accepts a comma- or space-separated list, plus the shorthand `any`
 * (everything except `up`) and `never` (status alone never fails the job).
 * An unknown token is a usage error, not a silent no-op.
 */
export function parseFailOn(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (text === "" || text === "never" || text === "none" || text === "false") {
    return new Set();
  }
  if (text === "any" || text === "true" || text === "all") {
    return new Set(CONDITIONS.filter((c) => c !== VERDICT.UP));
  }
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  const set = new Set();
  for (const token of tokens) {
    if (token === "up" && tokens.length > 1) continue; // only meaningful alone
    if (!CONDITIONS.includes(token)) {
      throw usageError(
        `Unknown fail-on value "${token}".`,
        `Valid values: ${CONDITIONS.join(", ")}, any, never. ` +
          'Example: fail-on: "degraded,down".',
      );
    }
    set.add(token);
  }
  return set;
}

/** The conditions an observation actually trips. */
export function conditionsFor({ verdict, stale }) {
  const conditions = new Set([verdict]);
  if (stale) conditions.add("stale");
  return conditions;
}

/** Which fail-on tokens this observation matched, for the summary and logs. */
export function matchedConditions({ verdict, stale }, failOnSet) {
  const present = conditionsFor({ verdict, stale });
  return [...failOnSet].filter((condition) => present.has(condition));
}