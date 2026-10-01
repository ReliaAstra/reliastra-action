import test from "node:test";
import assert from "node:assert/strict";

import { LATENCY_BUDGET_MS, TIMEOUT_MS, overBudget } from "../src/stripe.js";

test("the latency budget is declared in one place and is sane", () => {
  assert.equal(typeof LATENCY_BUDGET_MS, "number");
  assert.ok(LATENCY_BUDGET_MS > 0, "the budget must be positive");
  assert.ok(
    LATENCY_BUDGET_MS < TIMEOUT_MS,
    "the budget must be tighter than the hard timeout, or OverBudget can never fire",
  );
});

test("overBudget compares against the declared budget, inclusive", () => {
  assert.equal(overBudget({ latencyMs: LATENCY_BUDGET_MS - 1 }), false);
  assert.equal(overBudget({ latencyMs: LATENCY_BUDGET_MS }), true);
  assert.equal(overBudget({ latencyMs: LATENCY_BUDGET_MS + 500 }), true);
});

test("overBudget says nothing about health, only about latency", () => {
  // A 503 is a target failure but fast, so it is within budget. A 200 that took
  // 2s is within health but over budget. OverBudget must not conflate them.
  assert.equal(overBudget({ statusCode: 503, latencyMs: 80 }), false);
  assert.equal(overBudget({ statusCode: 200, latencyMs: LATENCY_BUDGET_MS + 1 }), true);
});