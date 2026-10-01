/**
 * Input validation, time-series, and exit-code table tests.
 *
 * The input tests encode a product decision worth stating out loud: an action
 * that silently accepts a malformed input is worse than one that refuses,
 * because the CI author finds out about it on someone else's machine.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS, parseInputs, readRawInputs } from "../src/inputs.js";
import { EXIT, EXIT_DOC } from "../src/exits.js";
import { isUuid } from "../src/client.js";
import { buildSeries, formatMs, formatUtc, renderLatencySparkline } from "../src/render/sparkline.js";

const UUID = "4c1f9e2a-3b7d-4c8e-9f1a-2b3c4d5e6f70";

/** Mimics @actions/core.getInput: (name, default) -> string. */
const getInput = (over = {}) => (name, fallback = "") => over[name] ?? fallback;

/** parseInputs() takes the raw bag that readRawInputs() produces. */
const raw = (over = {}) => ({ ...DEFAULTS, ...over });

/* ── Input plumbing ────────────────────────────────────────────────────── */

test("readRawInputs falls back to declared defaults", () => {
  const bag = readRawInputs(getInput());
  assert.equal(bag["fail-on"], "down");
  assert.equal(bag["base-url"], "https://reliastra.com/api");
  assert.equal(bag["result-format"], "text");
});

test("readRawInputs passes supplied values through", () => {
  const bag = readRawInputs(getInput({ "fail-on": "degraded,down" }));
  assert.equal(bag["fail-on"], "degraded,down");
});

test("blank inputs fall back rather than becoming empty strings", () => {
  const bag = readRawInputs(getInput({ "fail-on": "   " }));
  assert.equal(bag["fail-on"], "down");
});

/* ── dependency is required ────────────────────────────────────────────── */

test("a missing dependency is a usage error naming the input", () => {
  assert.throws(
    () => parseInputs(raw({ dependency: "" })),
    (error) => {
      assert.equal(error.exitCode, EXIT.USAGE);
      assert.match(error.message, /dependency/);
      return true;
    },
  );
});

/* ── Mode selection is unambiguous ─────────────────────────────────────── */

test("token plus a UUID selects authenticated mode", () => {
  const config = parseInputs(raw({ dependency: UUID, token: "rel_abc123" }));
  assert.equal(config.mode, "authenticated");
  assert.equal(config.token, "rel_abc123");
});

test("no token plus a slug selects public mode", () => {
  const config = parseInputs(raw({ dependency: "stripe", token: "" }));
  assert.equal(config.mode, "public");
  assert.equal(config.token, null);
});

test("token plus a slug is rejected rather than silently downgraded", () => {
  assert.throws(
    () => parseInputs(raw({ dependency: "stripe", token: "rel_abc123" })),
    (error) => error.exitCode === EXIT.USAGE,
  );
});

test("a UUID with no token is rejected: it cannot reach an authenticated endpoint", () => {
  assert.throws(
    () => parseInputs(raw({ dependency: UUID, token: "" })),
    (error) => error.exitCode === EXIT.USAGE,
  );
});

/* ── Numeric bounds ────────────────────────────────────────────────────── */

test("out-of-range numbers are rejected with the valid range stated", () => {
  assert.throws(
    () => parseInputs(raw({ dependency: "stripe", "timeout-seconds": "9999" })),
    (error) => {
      assert.equal(error.exitCode, EXIT.USAGE);
      assert.match(error.hint, /1-600/);
      return true;
    },
  );
});

test("non-numeric numbers are rejected", () => {
  assert.throws(
    () => parseInputs(raw({ dependency: "stripe", retries: "many" })),
    (error) => error.exitCode === EXIT.USAGE,
  );
});

test("a negative latency threshold is rejected", () => {
  assert.throws(
    () => parseInputs(raw({ dependency: "stripe", "latency-threshold-ms": "-5" })),
    (error) => error.exitCode === EXIT.USAGE,
  );
});

test("an empty latency threshold means no threshold, not zero", () => {
  const config = parseInputs(raw({ dependency: "stripe", "latency-threshold-ms": "" }));
  assert.equal(config.latencyThresholdMs, null);
});

/* ── Enumerations ──────────────────────────────────────────────────────── */

test("result-format only accepts text or json", () => {
  assert.equal(parseInputs(raw({ dependency: "stripe", "result-format": "json" })).resultFormat, "json");
  assert.throws(
    () => parseInputs(raw({ dependency: "stripe", "result-format": "yaml" })),
    (error) => error.exitCode === EXIT.USAGE,
  );
});

test("incident-status only accepts all, open or resolved", () => {
  for (const value of ["all", "open", "resolved"]) {
    assert.equal(parseInputs(raw({ dependency: "stripe", "incident-status": value })).incidentStatus, value);
  }
  assert.throws(
    () => parseInputs(raw({ dependency: "stripe", "incident-status": "maybe" })),
    (error) => error.exitCode === EXIT.USAGE,
  );
});

test("annotate accepts the usual boolean spellings", () => {
  assert.equal(parseInputs(raw({ dependency: "stripe", annotate: "false" })).annotate, false);
  assert.equal(parseInputs(raw({ dependency: "stripe", annotate: "no" })).annotate, false);
  assert.equal(parseInputs(raw({ dependency: "stripe", annotate: "true" })).annotate, true);
  assert.throws(
    () => parseInputs(raw({ dependency: "stripe", annotate: "maybe" })),
    (error) => error.exitCode === EXIT.USAGE,
  );
});

test("base-url must be http(s) and parseable", () => {
  assert.throws(
    () => parseInputs(raw({ dependency: "stripe", "base-url": "not-a-url" })),
    (error) => error.exitCode === EXIT.USAGE,
  );
  assert.throws(
    () => parseInputs(raw({ dependency: "stripe", "base-url": "file:///etc/passwd" })),
    (error) => error.exitCode === EXIT.USAGE,
  );
  assert.equal(
    parseInputs(raw({ dependency: "stripe", "base-url": "https://x.test/api/" })).baseUrl,
    "https://x.test/api",
  );
});

/* ── UUID guard ────────────────────────────────────────────────────────── */

test("isUuid accepts the canonical form and rejects lookalikes", () => {
  assert.equal(isUuid(UUID), true);
  assert.equal(isUuid(UUID.toUpperCase()), true);
  assert.equal(isUuid("stripe"), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid(null), false);
  assert.equal(isUuid(`${UUID}-extra`), false);
});

/* ── Exit table mirrors the CLI ────────────────────────────────────────── */

test("exit codes match cli/cmd/reliastra/main.go", () => {
  assert.deepEqual(
    {
      ok: EXIT.OK,
      usage: EXIT.USAGE,
      api: EXIT.API,
      auth: EXIT.AUTH,
      unverified: EXIT.UNVERIFIED,
      denied: EXIT.DENIED,
      network: EXIT.NETWORK,
      interrupt: EXIT.INTERRUPT,
    },
    { ok: 0, usage: 1, api: 2, auth: 3, unverified: 4, denied: 5, network: 6, interrupt: 130 },
  );
});

test("every exit code has documentation", () => {
  for (const code of Object.values(EXIT)) {
    assert.ok(EXIT_DOC[code], `exit ${code} must be documented`);
  }
});

/* ── Time series ───────────────────────────────────────────────────────── */

test("buildSeries sorts oldest to newest regardless of API order", () => {
  const series = buildSeries([
    { executed_at: "2026-10-01T03:00:00Z", latency_ms: 300, is_up: true },
    { executed_at: "2026-10-01T01:00:00Z", latency_ms: 100, is_up: false },
    { executed_at: "2026-10-01T02:00:00Z", latency_ms: 200, is_up: true },
  ]);
  assert.deepEqual(series.latencies, [100, 200, 300]);
  assert.deepEqual(series.ups, [false, true, true]);
  assert.equal(series.failures, 1);
});

test("buildSeries reports no data honestly rather than inventing zeros", () => {
  const series = buildSeries([]);
  assert.equal(series.hasData, false);
  assert.equal(series.count, 0);
  assert.equal(series.min, null);
  assert.equal(series.max, null);
});

test("missing latencies are excluded from min and max, not treated as zero", () => {
  const series = buildSeries([
    { executed_at: "2026-10-01T01:00:00Z", latency_ms: null, is_up: true },
    { executed_at: "2026-10-01T02:00:00Z", latency_ms: 500, is_up: true },
  ]);
  assert.equal(series.min, 500, "a null latency must not drag the minimum to 0");
});

test("a missing latency renders as a gap, not as an instant response", () => {
  const series = buildSeries([
    { executed_at: "2026-10-01T01:00:00Z", latency_ms: 100, is_up: true },
    { executed_at: "2026-10-01T02:00:00Z", latency_ms: null, is_up: true },
    { executed_at: "2026-10-01T03:00:00Z", latency_ms: 900, is_up: true },
  ]);
  const { text } = renderLatencySparkline(series, { unicode: true });
  assert.equal(text.length, 3);
  assert.equal(text[1], " ", "the gap must be a space");
});

test("a flat series renders at full height rather than dividing by zero", () => {
  const series = buildSeries(
    Array.from({ length: 3 }, (_, i) => ({
      executed_at: `2026-10-01T0${i}:00:00Z`,
      latency_ms: 250,
      is_up: true,
    })),
  );
  const { text, legend } = renderLatencySparkline(series, { unicode: true });
  assert.match(legend, /flat/);
  assert.equal(new Set(text).size, 1);
});

test("buildSeries honours the width cap and keeps the newest samples", () => {
  const series = buildSeries(
    Array.from({ length: 100 }, (_, i) => ({
      executed_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      latency_ms: 100 + i,
      is_up: true,
    })),
    { width: 10 },
  );
  assert.equal(series.count, 10);
  assert.equal(series.latencies.at(-1), 199);
});

/* ── Formatting ────────────────────────────────────────────────────────── */

test("formatMs switches units at one second", () => {
  assert.equal(formatMs(0), "0 ms");
  assert.equal(formatMs(999), "999 ms");
  assert.equal(formatMs(1000), "1.00 s");
  assert.equal(formatMs(4180), "4.18 s");
});

test("formatMs renders an em dash for absent data rather than 0 ms", () => {
  assert.equal(formatMs(null), "—");
  assert.equal(formatMs(undefined), "—");
  assert.equal(formatMs(Number.NaN), "—");
});

test("formatUtc is explicit about UTC and time zone", () => {
  assert.equal(formatUtc("2026-10-01T17:42:18Z"), "2026-10-01 17:42:18 UTC");
  assert.equal(formatUtc(null), "—");
});