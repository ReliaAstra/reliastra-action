/**
 * Service configuration.
 *
 * LATENCY_BUDGET_MS is the p95 budget for an outbound call. The CI workflow
 * greps this constant so the Reliastra gate and the service cannot drift apart.
 */

export const STRIPE_API = process.env.STRIPE_API ?? "https://api.stripe.com/v1";

/** p95 budget for a charge request, in milliseconds. */
export const LATENCY_BUDGET_MS = 750;

/** Hard ceiling on every outbound request. */
export const TIMEOUT_MS = 5000;

/**
 * Submit a charge.
 *
 * Returns what was observed, not a verdict. `reachedTarget: false` means nobody
 * answered, which is a different failure from Stripe answering 503 and should
 * not be reported as a Stripe outage.
 *
 * @param {number} amountCents
 * @param {string} apiKey
 * @returns {Promise<{statusCode: number, latencyMs: number, reachedTarget: boolean}>}
 */
export async function charge(amountCents, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();

  try {
    const response = await fetch(`${STRIPE_API}/charges`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ amount: String(amountCents), currency: "usd" }),
      signal: controller.signal,
    });
    return {
      statusCode: response.status,
      latencyMs: Date.now() - start,
      reachedTarget: true,
    };
  } catch (error) {
    return {
      statusCode: 0,
      latencyMs: Date.now() - start,
      reachedTarget: false,
      error: error?.message ?? String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** A statement about latency, not about health. */
export function overBudget(result) {
  return result.latencyMs >= LATENCY_BUDGET_MS;
}