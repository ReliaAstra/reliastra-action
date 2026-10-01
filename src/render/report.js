/**
 * The premium terminal report: the last thing printed in the runner log.
 *
 * Complements the live renderer rather than repeating it. The live frames are
 * transient — they get overwritten or scrolled past. This block is the durable
 * record: it stays in the log, it survives a copy-paste, and it is the thing a
 * reviewer screenshots.
 */

import { VERDICT, VERDICT_MEANING } from "../status.js";
import { renderWorldMap } from "./worldmap.js";
import { renderLatencySparkline, renderStatusRibbon, formatMs, formatUtc } from "./sparkline.js";
import { field, makeGlyphs, paintVerdict, verdictStyle } from "./theme.js";

const WIDTH = 78;

/**
 * @param {object} observation normalised observation record
 * @param {object} opts see renderJobSummary in ./summary.js
 */
export function renderReport(observation, opts = {}) {
  const { ink, glyphs, unicode = true } = opts;
  const {
    dependency = null,
    series = null,
    mode = "authenticated",
    failOn = "down",
    exitCode = 0,
    matched = [],
    methodologyVersion = null,
  } = opts;

  const lines = [];
  const rule = () => ink.dim(glyphs.rule.repeat(WIDTH));

  /* ── Header ───────────────────────────────────────────────────────────── */
  lines.push("");
  lines.push(`  ${ink.bold(ink.white("RELIASTRA"))}  ${ink.gray("·")}  ${ink.gray("external dependency verification")}`);
  lines.push(`  ${rule()}`);

  if (mode === "public") {
    lines.push(
      `  ${ink.magenta(glyphs.warn)} ${ink.bold(ink.magenta("PUBLIC INCIDENT FEED"))} ${ink.gray("— no token supplied, this is Reliastra's public record, not a private check of your dependency")}`,
    );
    if (observation.publicState === "no-records") {
      lines.push(
        `  ${ink.magenta(glyphs.warn)} ${ink.bold(ink.magenta("NO PUBLISHED RECORDS"))} ${ink.gray("— the feed answered and returned nothing; that is not a health check")}`,
      );
    } else if (observation.publicState === "resolved-only") {
      lines.push(
        `  ${ink.magenta(glyphs.warn)} ${ink.bold(ink.magenta("NO OPEN INCIDENT"))} ${ink.gray("— published incidents exist and are resolved")}`,
      );
    }
    lines.push("");
  }

  /* ── Verdict ──────────────────────────────────────────────────────────── */
  const style = verdictStyle(observation.verdict);
  lines.push(`  ${ink.gray("Observation".padEnd(16))}  ${paintVerdict(observation.verdict, ink, glyphs)}`);
  lines.push(`  ${" ".repeat(16)}  ${ink.gray(VERDICT_MEANING[observation.verdict] ?? "")}`);
  lines.push("");

  /* ── Identity ─────────────────────────────────────────────────────────── */
  const name = dependency?.name ?? dependency?.vendor_display_name ?? observation.dependencyName ?? observation.dependencyId;
  if (name) lines.push(field("Dependency", ink.white(name), ink));
  if (observation.endpointUrl) lines.push(field("Endpoint", ink.gray(truncate(observation.endpointUrl, 52)), ink));
  if (observation.httpStatus !== null && observation.httpStatus !== undefined) {
    const code = observation.httpStatus;
    const tinted = code >= 500 ? ink.red(String(code)) : code >= 400 ? ink.amber(String(code)) : ink.green(String(code));
    lines.push(field("HTTP status", tinted, ink));
  }
  if (observation.latencyMs !== null && observation.latencyMs !== undefined) {
    lines.push(field("Latency", ink.white(formatMs(observation.latencyMs)), ink));
  }
  if (observation.derivedLatency) {
    lines.push(
      field("Degraded because", `${ink.amber(`latency ${formatMs(observation.latencyMs)} ${observation.thresholdComparison} ${formatMs(observation.latencyThresholdMs)}`)}`, ink),
    );
    lines.push(field("", ink.gray("derived by this Action — not a Reliastra status"), ink));
  }
  if (observation.observedAt) lines.push(field("Observed", ink.white(formatUtc(observation.observedAt)), ink));
  if (observation.relayState) lines.push(field("Pipeline state", ink.gray(observation.relayState), ink));
  if (observation.errorMessage) {
    lines.push(field("Probe error", ink.gray(truncate(observation.errorMessage, 52)), ink));
  }
  lines.push(field("Observation point", observation.region
    ? `${ink.cyan(glyphs.dot)} ${ink.cyan(observation.region)}  ${ink.gray("1 point, not a consensus")}`
    : ink.gray("none — no probe was dispatched, so nothing was observed from anywhere"), ink));
  if (methodologyVersion) lines.push(field("Methodology", ink.gray(methodologyVersion), ink));
  if (observation.stale) {
    lines.push(field("Freshness", `${ink.amber(glyphs.warn)} STALE ${ink.gray("— older than its expected cadence")}`, ink));
  }
  lines.push("");

  /* ── Map ──────────────────────────────────────────────────────────────── */
  // Only drawn when an observation point is real. A map implies a measurement.
  if (observation.region) {
    const map = renderWorldMap({ region: observation.region, color: ink.enabled, animate: false, unicode });
    for (const line of map) lines.push(`  ${line}`);
    lines.push("");
  }

  /* ── Series ───────────────────────────────────────────────────────────── */
  if (series && series.count > 0) {
    const spark = renderLatencySparkline(series, { unicode });
    lines.push(field("latency", `${ink.cyan(spark.text)}  ${ink.gray(spark.legend)}`, ink));
    lines.push(field("outcomes", renderStatusRibbon(series, { ink, glyphs, unicode }), ink));
    lines.push(
      field("", ink.gray(`${series.count} observations, ${series.failures} failed · oldest left, newest right`), ink),
    );
    lines.push("");
  }

  /* ── Incident ─────────────────────────────────────────────────────────── */
  if (observation.incident) {
    const inc = observation.incident;
    lines.push(`  ${ink.gray(glyphs.rule.repeat(WIDTH / 2))}`);
    lines.push(field("Incident", `${ink.bold(ink.white(String(inc.status ?? "—").toUpperCase()))}${inc.incidentId ? ` ${ink.gray(inc.incidentId)}` : ""}`, ink));
    if (inc.severity) lines.push(field("Severity", ink.gray(inc.severity), ink));
    if (inc.failureKind) lines.push(field("Failure kind", ink.gray(inc.failureKind), ink));
    if (inc.attributionStatus) {
      const score = inc.attributionScore !== null && inc.attributionScore !== undefined
        ? ` ${ink.gray(`(${Number(inc.attributionScore).toFixed(2)})`)}`
        : "";
      lines.push(field("Attribution", `${ink.gray(inc.attributionStatus)}${score}`, ink));
    }
    if (observation.evidenceUrl) lines.push(field("Evidence", ink.cyan(truncate(observation.evidenceUrl, 50)), ink));
    lines.push("");
  }

  /* ── Gate ─────────────────────────────────────────────────────────────── */
  lines.push(`  ${ink.gray(glyphs.rule.repeat(WIDTH / 2))}`);
  lines.push(field("fail-on", ink.gray(failOn), ink));
  lines.push(
    field(
      "Matched",
      matched.length ? ink.bold(ink.red(matched.join(", "))) : ink.green("no gate matched"),
      ink,
    ),
  );
  lines.push(field("Exit code", ink.bold(exitCode === 0 ? ink.green(String(exitCode)) : ink.red(String(exitCode))), ink));
  lines.push("");

  /* ── Caveat ───────────────────────────────────────────────────────────── */
  const caveat = caveatFor(observation.verdict);
  for (const line of wrap(caveat, WIDTH - 6)) {
    lines.push(`  ${ink.gray(`${glyphs.info} ${line}`)}`);
  }
  lines.push("");
  lines.push(`  ${ink.gray("reliastra.com")}  ${ink.gray("·")}  ${ink.gray("github.com/ReliaAstra/reliastra-action")}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * The failure block.
 *
 * A failure must be as legible as a success, and it must be specific. "An error
 * occurred" is banned by design: every branch names the exit code, the category,
 * the cause, and what was NOT concluded. The last line of every failure is the
 * same sentence, because it is the one that matters operationally: no
 * observation was made, so nothing can be said about the dependency.
 */
export function renderFailure({ name, message, hint, exitCode }, { ink, glyphs }) {
  const lines = [];
  const rule = () => ink.dim(glyphs.rule.repeat(WIDTH));

  lines.push("");
  lines.push(`  ${ink.bold(ink.white("RELIASTRA"))}  ${ink.gray("·")}  ${ink.bold(ink.red("check could not complete"))}`);
  lines.push(`  ${rule()}`);
  lines.push("");
  lines.push(field("Exit code", `${ink.bold(ink.red(String(exitCode)))}  ${ink.gray(EXIT_CATEGORY[exitCode] ?? "unknown")}`, ink));
  lines.push(field("Error", ink.white(name), ink));
  lines.push("");
  for (const line of wrap(message, WIDTH - 6)) lines.push(`  ${ink.white(line)}`);

  if (hint) {
    lines.push("");
    for (const line of wrap(hint, WIDTH - 6)) lines.push(`  ${ink.cyan(`${glyphs.info} ${line}`)}`);
  }

  lines.push("");
  lines.push(`  ${ink.gray(`${glyphs.warn} No observation was made. This says nothing about your dependency.`)}`);
  lines.push("");
  lines.push(`  ${ink.gray("exit codes: 0 ok · 1 usage · 2 api · 3 auth · 4 unverified · 5 denied · 6 network · 130 cancelled")}`);
  lines.push("");
  lines.push(`  ${ink.gray("reliastra.com")}  ${ink.gray("·")}  ${ink.gray("github.com/ReliaAstra/reliastra-action")}`);
  lines.push("");

  return lines.join("\n");
}

const EXIT_CATEGORY = {
  0: "ok",
  1: "usage",
  2: "api",
  3: "auth",
  4: "unverified",
  5: "denied",
  6: "network",
  130: "cancelled",
};

function caveatFor(verdict) {
  switch (verdict) {
    case VERDICT.DOWN:
    case VERDICT.DEGRADED:
      return "Reliastra does not claim that provider causality is proven. Confirmation is deterministic from one observation point; attribution is a weighted score, not proof of cause.";
    case VERDICT.PIPELINE_ERROR:
      return "This is Reliastra's own failure, not your vendor's. The probe was never dispatched, so do not read this as an outage.";
    case VERDICT.BLOCKED:
      return "Reliastra refused to send the probe under its SSRF policy. This is an endpoint configuration problem and is deliberately never reported as a vendor outage.";
    case VERDICT.UNVERIFIED:
      return "No observation exists yet. Nothing can be concluded about this target; this is an absence of evidence, not evidence of health.";
    default:
      return "One observation point. A single successful probe is not proof of availability across regions, and not proof of availability over time.";
  }
}

function truncate(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Naive greedy wrap. Good enough for one-sentence caveats. */
function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}