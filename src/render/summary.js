/**
 * GitHub Actions job summary renderer.
 *
 * WHAT IS AND IS NOT AVAILABLE HERE
 * --------------------------------
 * Job summaries are GFM with a sanitised HTML subset. Headings, tables, code
 * fences, `<details>`, `<summary>` and `<img>` render. Inline SVG and <style>
 * do not. So "premium" in this surface means typographic structure, alignment,
 * a monochrome ASCII map in a code fence (which renders identically everywhere),
 * and colour-coded emoji glyphs. Anything that needs CSS or JS does not go in
 * here; the live animation belongs in the runner log instead.
 *
 * HONESTY RULES ENFORCED BY THIS FILE
 * -----------------------------------
 *  1. The mode is always stated. Public mode reads the public incident feed; it
 *     does not observe YOUR dependency's private health. That difference must
 *     never be implied away by a green checkmark.
 *  2. `degraded` is always labelled as derived, never as a Reliastra status.
 *  3. Attribution is reported with its own score and its own caveat. A vendor
 *     verdict is a weighted attribution, not proof.
 *  4. The map always says how many observation points exist. One.
 */

import { VERDICT, VERDICT_MEANING } from "../status.js";
import { renderWorldMap } from "./worldmap.js";
import { renderLatencySparkline, renderStatusRibbon, formatMs, formatUtc } from "./sparkline.js";
import { makeGlyphs, makeInk, verdictStyle } from "./theme.js";

const VERDICT_EMOJI = {
  [VERDICT.UP]: "✅",
  [VERDICT.DEGRADED]: "⚠️",
  [VERDICT.DOWN]: "❌",
  [VERDICT.BLOCKED]: "🔒",
  [VERDICT.UNVERIFIED]: "◻️",
  [VERDICT.PIPELINE_ERROR]: "🛑",
};

/**
 * @param {object} observation normalised observation record
 * @param {object} opts
 * @param {string} opts.failOn        raw fail-on input, echoed for audit
 * @param {number} opts.exitCode      the code this action is about to return
 * @param {string[]} opts.matched     fail-on conditions this observation tripped
 * @param {object|null} opts.dependency DependencyResponse or public summary
 * @param {string[]} opts.timeline    milestone lines from the live renderer
 */
export function renderJobSummary(observation, opts = {}) {
  const ink = makeInk(false); // job summary styling is HTML/emoji, not ANSI
  const glyphs = makeGlyphs(true);
  const {
    failOn = "down",
    exitCode = 0,
    matched = [],
    dependency = null,
    series = { points: [], latencies: [], ups: [], hasData: false, count: 0, failures: 0, min: null, max: null },
    timeline = [],
    mode = "authenticated",
    methodologyVersion = null,
  } = opts;

  const verdict = observation.verdict;
  const emoji = VERDICT_EMOJI[verdict] ?? "•";
  const style = verdictStyle(verdict);
  const out = [];

  /* ── Banner ───────────────────────────────────────────────────────────── */
  out.push("### RELIASTRA");
  out.push("");
  out.push(
    `<table><tr>` +
      `<td><strong style="font-size:44px;line-height:1">${emoji}</strong></td>` +
      `<td><strong style="font-size:22px">${style.label}</strong><br>` +
      `<sub>${escapeHtml(dependencyName(observation, dependency))}</sub></td>` +
      `</tr></table>`,
  );
  out.push("");

  /* ── Mode disclosure. Never implied away. ─────────────────────────────── */
  if (mode === "public") {
    out.push(
      "> **Public incident feed.** No token was supplied, so this is Reliastra's *public* " +
        "record for this vendor — not a private health check of your dependency. " +
        "Supply `token:` for per-dependency observations.",
    );
    out.push("");
  }

  if (observation.publicState === "no-records") {
    out.push(
      "> **No published incident record for this vendor.** The feed was queried and returned " +
        "nothing. That is an answer to \"is there a published incident?\", not a health check " +
        "of the vendor's API.",
    );
    out.push("");
  } else if (observation.publicState === "resolved-only") {
    out.push(
      "> **No incident is currently open.** Reliastra has published incidents for this vendor, " +
        "and they are resolved. This is a live public record, not a health check.",
    );
    out.push("");
  }

  /* ── Fields ───────────────────────────────────────────────────────────── */
  out.push("| | |");
  out.push("|---|---|");
  out.push(row("Verdict", `${emoji} **${style.label}**`));
  out.push(row("Meaning", VERDICT_MEANING[verdict] ?? "—"));

  if (observation.derivedLatency) {
    out.push(
      row(
        "Degraded because",
        `latency ${formatMs(observation.latencyMs)} ${observation.thresholdComparison} ` +
          `the threshold ${formatMs(observation.latencyThresholdMs)} ` +
          "— **derived by this Action, not a Reliastra status**",
      ),
    );
  }

  if (observation.httpStatus !== null && observation.httpStatus !== undefined) {
    out.push(row("HTTP status", String(observation.httpStatus)));
  }
  if (observation.latencyMs !== null && observation.latencyMs !== undefined) {
    out.push(row("Latency", formatMs(observation.latencyMs)));
  }
  if (observation.observedAt) {
    out.push(row("Observed", formatUtc(observation.observedAt)));
  }
  if (observation.endpointUrl) {
    out.push(row("Endpoint", `\`${escapeHtml(observation.endpointUrl)}\``));
  }
  if (observation.relayState) {
    out.push(row("Pipeline state", `\`${escapeHtml(observation.relayState)}\``));
  }
  if (observation.errorMessage) {
    out.push(row("Probe error", `\`${escapeHtml(truncate(observation.errorMessage, 180))}\``));
  }
  out.push(row("Observation point", observation.region ? `\`${escapeHtml(observation.region)}\`` : "none — no probe was dispatched"));
  out.push(
    observation.region
      ? row("Observation points", "**1** — this is a single observation, not a consensus")
      : row("Observation points", "0 — nothing was probed"),
  );
  out.push(row("Methodology", methodologyVersion ? `\`${escapeHtml(methodologyVersion)}\`` : "—"));

  if (observation.stale) {
    out.push(
      row("Freshness", "⚠️ **STALE** — the last observation is older than its expected cadence"),
    );
  }
  out.push("");

  /* ── Observation point map ────────────────────────────────────────────── */
  if (observation.region) {
    out.push("<details><summary>Observation point</summary>");
    out.push("");
    out.push("```text");
    for (const line of renderWorldMap({ region: observation.region, color: false, animate: false })) {
      out.push(line);
    }
    out.push("```");
    out.push("");
    out.push("</details>");
    out.push("");
  }

  /* ── Time series ──────────────────────────────────────────────────────── */
  if (series.count > 0) {
    out.push("<details><summary>Recent observations (last " + String(series.count) + ")</summary>");
    out.push("");
    const spark = renderLatencySparkline(series, { unicode: true });
    out.push("```text");
    out.push(`latency  ${spark.text}`);
    out.push(`         ${spark.legend}`);
    out.push(`outcomes ${renderStatusRibbon(series, { ink, glyphs })}`);
    out.push("```");
    out.push("");
    out.push(
      `<sub>${series.count} observations, ${series.failures} failed. ` +
        "Left is oldest, right is newest.</sub>",
    );
    out.push("");
    out.push("</details>");
    out.push("");
  }

  /* ── Incident + attribution ───────────────────────────────────────────── */
  if (observation.incident) {
    const inc = observation.incident;
    out.push("**Incident**");
    out.push("");
    out.push(row("ID", `\`${escapeHtml(String(inc.incidentId ?? "—"))}\``));
    out.push(row("Status", `**${escapeHtml(String(inc.status ?? "—")).toUpperCase()}**`));
    if (inc.severity) out.push(row("Severity", escapeHtml(String(inc.severity))));
    if (inc.failureKind) out.push(row("Failure kind", `\`${escapeHtml(String(inc.failureKind))}\``));
    if (inc.attributionStatus) {
      out.push(
        row(
          "Attribution",
          `${escapeHtml(String(inc.attributionStatus))}` +
            (inc.attributionScore !== null && inc.attributionScore !== undefined
              ? ` (score ${Number(inc.attributionScore).toFixed(2)})`
              : ""),
        ),
      );
    }
    if (inc.observationCount !== undefined) {
      out.push(row("Observations", String(inc.observationCount)));
    }
    if (inc.evidenceHash) {
      out.push(row("Evidence SHA-256", `\`${escapeHtml(String(inc.evidenceHash).slice(0, 32))}…\``));
    }
    out.push("");
  }

  if (observation.evidenceUrl) {
    out.push(`**Evidence** — ${observation.evidenceUrl}`);
    out.push("");
  }

  /* ── Gate decision ────────────────────────────────────────────────────── */
  out.push("**Gate**");
  out.push("");
  out.push(row("`fail-on`", `\`${escapeHtml(failOn)}\``));
  out.push(
    row(
      "Matched",
      matched.length ? `**${matched.map((m) => `\`${escapeHtml(m)}\``).join(", ")}**` : "no gate matched",
    ),
  );
  out.push(row("Exit code", `\`${exitCode}\``));
  out.push("");

  /* ── Timeline ─────────────────────────────────────────────────────────── */
  if (timeline.length) {
    out.push("<details><summary>Run timeline</summary>");
    out.push("");
    out.push("```text");
    for (const step of timeline) out.push(`[${String(step.elapsed).padStart(6)}] ${step.text}`);
    out.push("```");
    out.push("");
    out.push("</details>");
    out.push("");
  }

  /* ── The mandatory caveat ─────────────────────────────────────────────── */
  out.push("---");
  out.push("");
  if (verdict === VERDICT.DOWN || verdict === VERDICT.DEGRADED) {
    out.push(
      "Reliastra does not claim that provider causality is proven. A confirmed incident " +
        "means failures were deterministically confirmed from one independent observation point " +
        "and an evidence record was generated. Attribution is a weighted score, not proof of cause.",
    );
  } else if (verdict === VERDICT.PIPELINE_ERROR) {
    out.push(
      "**This is Reliastra's own failure, not your vendor's.** The probe could not be dispatched. " +
        "Do not treat this as an outage.",
    );
  } else if (verdict === VERDICT.BLOCKED) {
    out.push(
      "Reliastra refused to send the probe under its SSRF policy. This is an endpoint " +
        "configuration problem and is deliberately **never** reported as a vendor outage.",
    );
  } else if (verdict === VERDICT.UNVERIFIED) {
    out.push(
      "No observation exists yet, so nothing can be concluded about this target. " +
        "This is an absence of evidence, not evidence of health.",
    );
  } else {
    out.push(
      "One observation point. A successful probe from a single point is not proof of " +
        "availability across regions, and not proof of availability over time.",
    );
  }
  out.push("");
  out.push(
    `<sub>Generated by <a href="https://github.com/ReliaAstra/reliastra-action">reliastra-action</a> · ` +
      `[reliastra.com](https://reliastra.com) · [methodology](https://reliastra.com/docs/methodology)</sub>`,
  );

  return out.join("\n");
}

/** A two-column table row. */
function row(label, value) {
  return `| ${escapeHtml(label)} | ${value} |`;
}

function dependencyName(observation, dependency) {
  return (
    dependency?.name ??
    dependency?.vendor_display_name ??
    observation.dependencyName ??
    observation.dependencyId ??
    "unknown dependency"
  );
}

function truncate(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}