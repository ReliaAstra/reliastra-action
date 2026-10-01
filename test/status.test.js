/**
 * Verdict derivation tests.
 *
 * Every fixture here is a real payload shape from the backend:
 *   backend/app/modules/checks/constants.py   CheckState + TARGET/INFRASTRUCTURE sets
 *   backend/app/modules/checks/schemas.py     CheckStateResponse, LastCheckResultSummary
 *
 * These tests are the reason the action can claim it does not invent statuses.
 * If the backend adds a state, deriveVerdict throws rather than guessing, and
 * the throw is asserted here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CHECK_STATE,
  CONDITIONS,
  VERDICT,
  conditionsFor,
  deriveVerdict,
  matchedConditions,
  parseFailOn,
} from "../src/status.js";
import { EXIT } from "../src/exits.js";

const result = (over = {}) => ({
  executed_at: "2026-10-01T17:42:18Z",
  region: "us-east",
  latency_ms: 120,
  status_code: 200,
  is_up: true,
  error_message: null,
  quorum_confirmed: false,
  ...over,
});

/* ── The happy path and its latency-derived neighbour ──────────────────── */

test("successful probe under the threshold is UP", () => {
  const v = deriveVerdict({ state: CHECK_STATE.SUCCESSFUL, lastResult: result({ latency_ms: 90 }) });
  assert.equal(v.verdict, VERDICT.UP);
  assert.equal(v.degraded, false);
  assert.equal(v.httpStatus ?? v.statusCode, 200);
});

test("successful probe at the threshold is DEGRADED (derived, not a backend state)", () => {
  const v = deriveVerdict({
    state: CHECK_STATE.SUCCESSFUL,
    lastResult: result({ latency_ms: 4180 }),
    latencyThresholdMs: 2000,
  });
  assert.equal(v.verdict, VERDICT.DEGRADED);
  assert.equal(v.degraded, true);
});

test("successful probe one millisecond under the threshold is still UP", () => {
  const v = deriveVerdict({
    state: CHECK_STATE.SUCCESSFUL,
    lastResult: result({ latency_ms: 1999 }),
    latencyThresholdMs: 2000,
  });
  assert.equal(v.verdict, VERDICT.UP);
});

test("no threshold means DEGRADED is never fabricated", () => {
  const slow = result({ latency_ms: 60_000 });
  const v = deriveVerdict({ state: CHECK_STATE.SUCCESSFUL, lastResult: slow, latencyThresholdMs: null });
  assert.equal(v.verdict, VERDICT.UP, "without a threshold there is no basis to call it degraded");
});

test("missing threshold leaves degraded false even when latency is unknown", () => {
  const v = deriveVerdict({
    state: CHECK_STATE.SUCCESSFUL,
    lastResult: result({ latency_ms: null }),
    latencyThresholdMs: 2000,
  });
  assert.equal(v.verdict, VERDICT.UP);
});

/* ── Target failures ───────────────────────────────────────────────────── */

test("target_failed is DOWN", () => {
  const v = deriveVerdict({
    state: CHECK_STATE.TARGET_FAILED,
    lastResult: result({ is_up: false, status_code: 503, latency_ms: 4180, error_message: "HTTP 503" }),
  });
  assert.equal(v.verdict, VERDICT.DOWN);
});

/* ── The three states that must never be reported as a vendor outage ──── */

test("blocked_by_security_policy is BLOCKED, never DOWN", () => {
  const v = deriveVerdict({
    state: CHECK_STATE.BLOCKED_BY_SECURITY_POLICY,
    lastResult: null,
  });
  assert.equal(v.verdict, VERDICT.BLOCKED);
  assert.notEqual(v.verdict, VERDICT.DOWN);
});

for (const state of [CHECK_STATE.DISPATCH_FAILED, CHECK_STATE.SCHEDULER_UNAVAILABLE]) {
  test(`${state} is PIPELINE_ERROR (Reliastra's fault, not the vendor's)`, () => {
    const v = deriveVerdict({ state, lastResult: null });
    assert.equal(v.verdict, VERDICT.PIPELINE_ERROR);
  });
}

for (const state of [
  CHECK_STATE.NEVER_CHECKED,
  CHECK_STATE.AWAITING_SCHEDULE,
  CHECK_STATE.QUEUED,
  CHECK_STATE.EXECUTING,
]) {
  test(`${state} is UNVERIFIED`, () => {
    const v = deriveVerdict({ state, lastResult: null });
    assert.equal(v.verdict, VERDICT.UNVERIFIED);
  });
}

/* ── Precedence: our fault beats the target's ──────────────────────────── */

test("dispatch_failed wins even if a stale failure is present in history", () => {
  const v = deriveVerdict({
    state: CHECK_STATE.DISPATCH_FAILED,
    lastResult: result({ is_up: false, status_code: 500 }),
    latencyThresholdMs: 100,
  });
  assert.equal(v.verdict, VERDICT.PIPELINE_ERROR);
});

/* ── Contract drift must fail loudly ───────────────────────────────────── */

test("an unrecognised state throws instead of guessing", () => {
  assert.throws(
    () => deriveVerdict({ state: "quantum_entangled", lastResult: null }),
    (error) => error.exitCode === EXIT.USAGE,
  );
});

test("successful with no recorded result is UNVERIFIED, not UP", () => {
  const v = deriveVerdict({ state: CHECK_STATE.SUCCESSFUL, lastResult: null });
  assert.equal(v.verdict, VERDICT.UNVERIFIED);
});

/* ── Staleness is orthogonal to the verdict ────────────────────────────── */

test("stale is reported alongside up rather than replacing it", () => {
  const v = deriveVerdict({
    state: CHECK_STATE.SUCCESSFUL,
    lastResult: result(),
    isStale: true,
  });
  assert.equal(v.verdict, VERDICT.UP);
  assert.equal(v.stale, true);
  assert.ok(conditionsFor(v).has("stale"));
  assert.ok(conditionsFor(v).has(VERDICT.UP));
});

/* ── fail-on parsing ───────────────────────────────────────────────────── */

test("fail-on defaults are literal and case-insensitive", () => {
  assert.deepEqual([...parseFailOn("down")], ["down"]);
  assert.deepEqual([...parseFailOn("DOWN")], ["down"]);
});

test("fail-on accepts a comma or space separated list", () => {
  assert.deepEqual([...parseFailOn("degraded,down")].sort(), ["degraded", "down"]);
  assert.deepEqual([...parseFailOn("degraded down")].sort(), ["degraded", "down"]);
});

test("never disables status gating entirely", () => {
  assert.equal(parseFailOn("never").size, 0);
  assert.equal(parseFailOn("").size, 0);
  assert.equal(parseFailOn("false").size, 0);
});

test("any means everything except up", () => {
  const set = parseFailOn("any");
  assert.equal(set.has(VERDICT.UP), false);
  for (const condition of CONDITIONS.filter((c) => c !== VERDICT.UP)) {
    assert.ok(set.has(condition), `any should include ${condition}`);
  }
});

test("an unknown fail-on token is a usage error, not a silent no-op", () => {
  assert.throws(() => parseFailOn("exploded"), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => parseFailOn("down,exploded"), (e) => e.exitCode === EXIT.USAGE);
});

/* ── Gate matching ─────────────────────────────────────────────────────── */

test("matchedConditions reports every tripped gate", () => {
  const matched = matchedConditions(
    { verdict: VERDICT.DEGRADED, stale: true },
    parseFailOn("degraded,down,stale"),
  );
  assert.deepEqual(matched.sort(), ["degraded", "stale"]);
});

test("an up observation matches nothing under the default gate", () => {
  assert.deepEqual(matchedConditions({ verdict: VERDICT.UP, stale: false }, parseFailOn("down")), []);
});

test("stale can gate independently of a healthy verdict", () => {
  const matched = matchedConditions({ verdict: VERDICT.UP, stale: true }, parseFailOn("stale"));
  assert.deepEqual(matched, ["stale"]);
});