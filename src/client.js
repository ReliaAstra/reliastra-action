/**
 * Reliastra API client.
 *
 * The contract below is transcribed from the running backend, not guessed:
 *
 *   GET {base}/v1/dependencies/{uuid}            -> DependencyResponse
 *       dependencies/schemas.py::DependencyResponse
 *   GET {base}/v1/checks/state/{uuid}           -> CheckStateResponse
 *       checks/schemas.py::CheckStateResponse
 *   GET {base}/v1/dependencies/{uuid}/results   -> PaginatedResponse[CheckResultResponse]
 *       platform/web/pagination.py::PaginatedResponse  { data[], pagination, total, page, size, pages }
 *   GET {base}/v1/public/incidents?vendor=slug  -> PublicIncidentListResponse   (no auth)
 *       incidents/public_schemas.py::PublicIncidentListResponse { items[], next_cursor, has_more }
 *   GET {base}/v1/public/incidents/{uuid}       -> PublicIncidentDetailResponse (no auth)
 *
 * Auth is `X-API-Key: rel_...`. api/deps.py also accepts a raw `rel_` value in
 * Authorization and `Authorization: ApiKey rel_...`, but X-API-Key is the
 * documented header, so that is what we send.
 *
 * Verified live:  GET https://reliastra.com/api/v1/public/incidents -> 200
 *                 GET .../v1/dependencies with a bad key            -> 401
 */

import { EXIT, ReliastraError, apiError, authError, networkError, usageError } from "./exits.js";

export const DEFAULT_BASE_URL = "https://reliastra.com/api";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return UUID_RE.test(String(value ?? "").trim());
}

/** Network-level failures that mean "we never reached the API". */
const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

export class ReliastraClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl      API root, no trailing slash
   * @param {string|null} opts.token   `rel_...` API key, or null for public mode
   * @param {number} opts.timeoutMs    per-request timeout
   * @param {number} opts.retries      extra attempts for transient failures
   * @param {number} opts.backoffMs    base delay for exponential backoff
   */
  constructor({ baseUrl = DEFAULT_BASE_URL, token = null, timeoutMs = 30_000, retries = 2, backoffMs = 500 } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.backoffMs = backoffMs;
    this.onRetry = null; // (info) => void, wired by the live renderer
  }

  get authenticated() {
    return Boolean(this.token);
  }

  url(path, query) {
    const qs = query
      ? Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  headers() {
    const headers = {
      Accept: "application/json",
      "User-Agent": "reliastra-action/1.0.0 (+https://github.com/ReliaAstra/reliastra-action)",
    };
    if (this.token) headers["X-API-Key"] = this.token;
    return headers;
  }

  /**
   * One request with timeout and bounded retries.
   *
   * Retries cover only transient conditions: network errors, 429 and 5xx.
   * A 401 or 404 is a fact about the request, so repeating it is pointless and
   * would only delay a clear error.
   */
  async request(path, { query, method = "GET", expectJson = true } = {}) {
    const url = this.url(path, query);
    let lastError = null;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) {
        const delay = this.backoffMs * 2 ** (attempt - 1);
        this.onRetry?.({ attempt, delay, url });
        await sleep(delay);
      }
      try {
        return await this.#attempt(url, method, expectJson);
      } catch (error) {
        lastError = error;
        // Must test against the CLASS. The `*Error` exports are arrow-function
        // factories and therefore have no `.prototype`, so `instanceof` against
        // them throws "Function has non-object prototype 'undefined'".
        if (error instanceof ReliastraError && !error.retryable) throw error;
      }
    }
    throw lastError;
  }

  async #attempt(url, method, expectJson) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: this.headers(),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === "AbortError") {
        throw networkError(
          `Request to ${hostOf(url)} timed out after ${this.timeoutMs}ms.`,
          "Reliastra did not answer in time. This is not an observation of your dependency.",
        );
      }
      if (NETWORK_CODES.has(error?.code) || error?.name === "TypeError") {
        throw networkError(
          `Could not reach ${hostOf(url)}: ${error?.code ?? error?.message ?? "connection failed"}.`,
          "Network, DNS or TLS failure. Nothing was observed about your dependency.",
        );
      }
      throw apiError(`Request to ${hostOf(url)} failed: ${error?.message ?? error}`);
    }
    clearTimeout(timer);

    const status = response.status;

    if (status === 401 || status === 403) {
      throw authError(
        `Reliastra rejected the credentials (HTTP ${status}).`,
        status === 401
          ? "The token is missing, malformed, revoked or expired. Create a key at https://reliastra.com and store it as a repository secret."
          : "The token authenticated but lacks the scope for this operation.",
      );
    }

    if (status === 404) {
      throw usageError(
        `Not found (HTTP 404) on ${pathOf(url)}.`,
        "The dependency id does not exist, or it belongs to another organization and is therefore invisible to this token.",
      );
    }

    if (status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      const error = apiError(
        "Reliastra rate limited this request (HTTP 429).",
        retryAfter
          ? `Retry after ${retryAfter}s. Reduce workflow frequency or request a higher limit.`
          : "Reduce workflow frequency or request a higher limit.",
      );
      error.retryable = true;
      error.retryAfter = retryAfter;
      throw error;
    }

    if (status >= 500) {
      const error = apiError(
        `Reliastra returned HTTP ${status}.`,
        "The measurement service is failing. This says nothing about your dependency.",
      );
      error.retryable = true;
      throw error;
    }

    if (!response.ok) {
      throw apiError(
        `Reliastra returned HTTP ${status} for ${pathOf(url)}.`,
        "Unexpected status. The response body is in the job log.",
      );
    }

    if (!expectJson) return null;

    const text = await response.text();
    if (!text.trim()) {
      throw apiError("Reliastra returned an empty body.", "Expected JSON. The contract may have changed.");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw apiError(
        "Reliastra returned a body that is not JSON.",
        `First 200 bytes: ${text.slice(0, 200)}`,
      );
    }
  }

  /* ── Authenticated surface ────────────────────────────────────────────── */

  /** GET /v1/dependencies/{uuid} */
  async getDependency(dependencyId) {
    assertUuid(dependencyId);
    return this.request(`/v1/dependencies/${encodeURIComponent(dependencyId)}`);
  }

  /** GET /v1/checks/state/{uuid} -> CheckStateResponse */
  async getCheckState(dependencyId) {
    assertUuid(dependencyId);
    return this.request(`/v1/checks/state/${encodeURIComponent(dependencyId)}`);
  }

  /**
   * GET /v1/dependencies/{uuid}/results -> PaginatedResponse[CheckResultResponse]
   * Tolerates both the canonical `data` envelope and the legacy `items` alias,
   * because platform/web/pagination.py documents both.
   */
  async getResults(dependencyId, { page = 1, size = 20 } = {}) {
    assertUuid(dependencyId);
    const body = await this.request(`/v1/dependencies/${encodeURIComponent(dependencyId)}/results`, {
      query: { page, size },
    });
    const items = Array.isArray(body?.data) ? body.data : Array.isArray(body?.items) ? body.items : null;
    if (!items) {
      throw apiError(
        "Results response did not contain a `data` or `items` array.",
        "PaginatedResponse shape: { data, pagination, total, page, size, pages }.",
      );
    }
    return items;
  }

  /* ── Public surface (no auth) ─────────────────────────────────────────── */

  /** GET /v1/public/incidents?vendor=&status=&region=&limit= */
  async searchPublicIncidents({ vendor, status, region, limit = 20 } = {}) {
    const body = await this.request("/v1/public/incidents", {
      query: { vendor, status, region, limit },
    });
    const items = Array.isArray(body?.items) ? body.items : [];
    return { items, nextCursor: body?.next_cursor ?? null, hasMore: Boolean(body?.has_more) };
  }

  /** GET /v1/public/incidents/{uuid} -> PublicIncidentDetailResponse */
  async getPublicIncident(incidentId) {
    assertUuid(incidentId);
    return this.request(`/v1/public/incidents/${encodeURIComponent(incidentId)}`);
  }
}

function assertUuid(value) {
  if (!isUuid(value)) {
    throw usageError(
      `"${value}" is not a dependency UUID.`,
      "Pass the dependency id from https://reliastra.com, or omit `token` to read the public incident feed with a vendor slug instead.",
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export { EXIT };