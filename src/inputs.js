/**
 * Input parsing and validation.
 *
 * Every failure here is a USAGE error (exit 1) with a message that names the
 * input, the offending value, and an example. A CI author should never have to
 * read the action's source to find out why their workflow stopped.
 */

import { usageError } from "./exits.js";
import { isUuid } from "./client.js";

const RAW = {
  dependency: (v) => v,
  token: (v) => v,
  "fail-on": (v) => v,
  "base-url": (v) => v,
  "timeout-seconds": (v) => v,
  retries: (v) => v,
  "history-limit": (v) => v,
  "latency-threshold-ms": (v) => v,
  "wait-seconds": (v) => v,
  "result-format": (v) => v,
  "output-file": (v) => v,
  "incident-status": (v) => v,
  annotate: (v) => v,
};

const DEFAULTS = {
  dependency: "",
  token: "",
  "fail-on": "down",
  "base-url": "https://reliastra.com/api",
  "timeout-seconds": "30",
  retries: "2",
  "history-limit": "40",
  "latency-threshold-ms": "",
  "wait-seconds": "0",
  "result-format": "text",
  "output-file": "",
  "incident-status": "all",
  annotate: "true",
};

export function readRawInputs(getInput) {
  const raw = {};
  for (const [key, read] of Object.entries(RAW)) {
    let value;
    try {
      value = read(getInput(key, ""));
    } catch {
      value = "";
    }
    const fallback = DEFAULTS[key];
    raw[key] = value === undefined || value === null || String(value).trim() === ""
      ? fallback
      : String(value).trim();
  }
  return raw;
}

/**
 * @param {object} raw output of readRawInputs
 * @returns {object} typed, validated config
 */
export function parseInputs(raw) {
  const dependency = String(raw["dependency"] ?? "").trim();
  const token = String(raw.token ?? "").trim();
  const baseUrl = normaliseUrl(raw["base-url"]);
  const timeoutMs = intInRange(raw["timeout-seconds"], "timeout-seconds", 1, 600) * 1000;
  const retries = intInRange(raw.retries, "retries", 0, 10);
  const historyLimit = intInRange(raw["history-limit"], "history-limit", 1, 200);
  const waitSeconds = intInRange(raw["wait-seconds"], "wait-seconds", 0, 900);
  const latencyThresholdMs = optionalMs(raw["latency-threshold-ms"]);
  const resultFormat = enumOf(raw["result-format"], "result-format", ["text", "json"], "text");
  const outputFile = String(raw["output-file"] ?? "").trim();
  const incidentStatus = enumOf(
    raw["incident-status"],
    "incident-status",
    ["all", "open", "resolved"],
    "all",
  );
  const annotate = boolOf(raw.annotate, "annotate", true);

  if (!dependency) {
    throw usageError(
      "Input `dependency` is required.",
      "Authenticated mode: the dependency UUID, e.g. dependency: 4c1f...-...\n" +
        "Public mode: a vendor slug, e.g. dependency: stripe (and omit `token`).",
    );
  }

  if (token && !token.startsWith("rel_")) {
    // Not fatal: the API accepts other key shapes. But a truncated secret is
    // the most common cause of a 401 and it costs nothing to catch here.
    process.emitWarning(
      `rel${`iastra-action`}: token does not start with "rel_". Reliastra API keys begin with rel_. ` +
        "A truncated or mis-copied secret is the most common cause of exit code 3.",
    );
  }

  const mode = token ? "authenticated" : "public";

  if (mode === "authenticated" && !isUuid(dependency)) {
    throw usageError(
      `Input \`dependency\` must be a dependency UUID when a token is supplied, got "${dependency}".`,
      "Authenticated mode observes one specific dependency. Omit `token:` to use public mode " +
        "with a vendor slug, or copy the dependency UUID from https://reliastra.com.",
    );
  }

  if (mode === "public" && isUuid(dependency)) {
    throw usageError(
      "Input `dependency` is a UUID but no token was supplied.",
      "Authenticated endpoints need a token: token: ${{ secrets.RELIASTRA_TOKEN }}. " +
        "For the public feed, pass a vendor slug instead, e.g. dependency: stripe.",
    );
  }

  return {
    dependency,
    token: token || null,
    baseUrl,
    timeoutMs,
    retries,
    historyLimit,
    waitSeconds,
    latencyThresholdMs,
    resultFormat,
    outputFile,
    incidentStatus,
    annotate,
    mode,
  };
}

function normaliseUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "https://reliastra.com/api";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw usageError(
      `Input \`base-url\` is not a valid URL: "${text}".`,
      "Example: base-url: https://reliastra.com/api",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw usageError(
      `Input \`base-url\` must be http(s), got "${parsed.protocol}".`,
      "Example: base-url: https://reliastra.com/api",
    );
  }
  return text.replace(/\/+$/, "");
}

function intInRange(value, name, min, max) {
  const text = String(value ?? "").trim();
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw usageError(
      `Input \`${name}\` must be an integer, got "${text}".`,
      `Valid range: ${min}-${max}.`,
    );
  }
  if (parsed < min || parsed > max) {
    throw usageError(
      `Input \`${name}\` must be between ${min} and ${max}, got ${parsed}.`,
      `Valid range: ${min}-${max}. Nearest legal value: ${Math.min(Math.max(parsed, min), max)}`,
    );
  }
  return parsed;
}

function optionalMs(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw usageError(
      `Input \`latency-threshold-ms\` must be a positive number, got "${text}".`,
      "Leave it empty to use the dependency's own alert threshold. Example: 2000",
    );
  }
  return parsed;
}

function enumOf(value, name, allowed, fallback) {
  const text = String(value ?? fallback).trim().toLowerCase();
  if (!allowed.includes(text)) {
    throw usageError(
      `Input \`${name}\` must be one of: ${allowed.join(", ")}. Got "${text}".`,
      `Example: ${name}: ${allowed[0]}`,
    );
  }
  return text;
}

function boolOf(value, name, fallback) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["true", "yes", "1", "on"].includes(text)) return true;
  if (["false", "no", "0", "off"].includes(text)) return false;
  throw usageError(
    `Input \`${name}\` must be true or false, got "${text}".`,
    "Example: annotate: false",
  );
}

export { DEFAULTS };