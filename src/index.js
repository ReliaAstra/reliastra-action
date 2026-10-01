/**
 * reliastra-action entry point.
 *
 * Flow: inputs -> Reliastra API -> result -> job summary -> outputs / exit.
 *
 * EXIT CODE PRECEDENCE (documented, deterministic, no ambiguity)
 * -------------------------------------------------------------
 *   1. Usage / API / auth / network failure  -> that error's own code
 *   2. A fail-on condition matched            -> 5  (DENIED)
 *   3. verdict is `unverified`               -> 4  (UNVERIFIED)
 *   4. otherwise                             -> 0  (OK)
 *
 * Rule 3 is deliberately NOT configurable. A monitoring action that exits 0
 * when it observed nothing is worse than one that fails: it turns an absent
 * measurement into a green tick. `unverified` is always non-zero. If a user
 * wants a different trade-off they can gate it themselves in a later step,
 * which is visible in their workflow instead of hidden inside this one.
 */

import { ReliastraClient } from "./client.js";
import { EXIT, ReliastraError } from "./exits.js";
import { readRawInputs, parseInputs } from "./inputs.js";
import { observeAuthenticated, observePublic, toVerdict } from "./observe.js";
import {
  CONDITIONS,
  VERDICT,
  VERDICT_MEANING,
  deriveVerdict,
  matchedConditions,
  parseFailOn,
} from "./status.js";
import { LiveRenderer } from "./render/live.js";
import { renderReport, renderFailure } from "./render/report.js";
import { renderJobSummary } from "./render/summary.js";
import { buildSeries } from "./render/sparkline.js";
import { detectColor, detectUnicode, makeGlyphs, makeInk } from "./render/theme.js";
import * as gh from "./github.js";
import { writeFileSync } from "node:fs";

/** GitHub exposes each input as INPUT_<NAME>, preserving hyphens. */
function getInput(name, defaultValue = "") {
  const raw = process.env[`INPUT_${name.toUpperCase()}`];
  return raw === undefined || raw === "" ? defaultValue : raw;
}

async function main() {
  const color = detectColor();
  const ink = makeInk(color);
  const unicode = detectUnicode();
  const glyphs = makeGlyphs(unicode);

  // Declared up front so the failure path can seal the renderer even when
  // input validation threw before the renderer existed.
  let live = null;
  let raw = {};
  let config = { mode: "unknown" };

  try {
    raw = readRawInputs(getInput);
    config = parseInputs(raw);
    const failOnSet = parseFailOn(raw["fail-on"]);

    gh.info(
      `${ink.bold("RELIASTRA")} ${ink.gray("·")} ${ink.gray("action v1.0.0")}  ` +
        `${ink.gray("mode:")} ${ink.white(config.mode)}  ${ink.gray("target:")} ${ink.white(config.dependency)}`,
    );

    const client = new ReliastraClient({
      baseUrl: config.baseUrl,
      token: config.token,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
    });

    live = new LiveRenderer({ ink, glyphs, unicode });
    client.onRetry = ({ attempt, delay }) => {
      live.milestone(`retry ${attempt} after ${delay}ms (transient failure)`, "amber");
    };
    live.start();

    const collected =
      config.mode === "public"
        ? await observePublic(client, config, live)
        : await observeAuthenticated(client, config, live);

    const verdictInfo =
      collected.mode === "public"
        ? toVerdict(collected)
        : deriveVerdict({
            state: collected.state,
            lastResult: collected.lastResult,
            latencyThresholdMs: collected.latencyThresholdMs,
            isStale: collected.stale,
          });

    const observation = buildObservation(collected, verdictInfo, collected.lastResult);
    const matched = matchedConditions(
      { verdict: observation.verdict, stale: observation.stale },
      failOnSet,
    );

    // Public mode is a QUERY, not a probe. "Is there a published open incident
    // for this vendor?" has three answers — yes, no, or no records — and all
    // three are successful answers. Only `open-incident` is a finding.
    //
    // Exiting non-zero whenever the public feed is quiet would fail pipelines
    // on the most common vendors in the catalog, teaching developers that this
    // action is noise. A user who wants the strict reading opts in with
    // `fail-on: unverified`.
    //
    // Authenticated mode is the opposite: we were told to observe a specific
    // dependency and have nothing to show, so `unverified` correctly exits
    // non-zero.
    const feedAnswered = config.mode === "public";

    const exitCode = matched.length > 0
      ? EXIT.DENIED
      : observation.verdict === VERDICT.UNVERIFIED && !feedAnswered
        ? EXIT.UNVERIFIED
        : EXIT.OK;

    const series = buildSeries(collected.results ?? [], { width: config.historyLimit });
    const reportOpts = {
      dependency: collected,
      series,
      ink,
      glyphs,
      unicode,
      mode: config.mode,
      failOn: raw["fail-on"],
      exitCode,
      matched,
      methodologyVersion: collected.methodologyVersion,
    };

    live.seal();
    gh.info("");
    gh.info(renderReport(observation, reportOpts));

    const summaryMarkdown = renderJobSummary(observation, {
      ...reportOpts,
      ink,
      timeline: live.milestones,
    });

    // JSON mode: the machine-readable record is the payload, not decoration.
    if (config.resultFormat === "json" || config.outputFile) {
      const payload = buildJsonPayload(observation, config, exitCode, matched, raw["fail-on"]);
      const serialised = JSON.stringify(payload, null, 2);
      gh.info("");
      gh.info(ink.gray(serialised));
      if (config.outputFile) writeJsonFile(config.outputFile, serialised, gh, ink);
    }

    gh.appendSummary(summaryMarkdown);
    writeOutputs(observation, config, exitCode, matched, series, summaryMarkdown, collected);

    if (config.annotate) emitAnnotation(observation, exitCode);

    return exitCode;
  } catch (error) {
    live?.seal();
    return handleFailure(error, { ink, glyphs, unicode, config, raw });
  } finally {
    live?.stop();
  }
}

/** Normalise collected data + verdict into the record every renderer takes. */
function buildObservation(collected, verdictInfo, lastResult) {
  const degraded = Boolean(verdictInfo.degraded);
  return {
    verdict: verdictInfo.verdict,
    stale: Boolean(verdictInfo.stale ?? collected.stale),
    derivedLatency: degraded && collected.mode === "authenticated",
    latencyMs: verdictInfo.latencyMs ?? collected.latencyMs ?? null,
    httpStatus: verdictInfo.statusCode ?? collected.httpStatus ?? null,
    latencyThresholdMs: collected.latencyThresholdMs ?? null,
    thresholdComparison:
      degraded && (verdictInfo.latencyMs ?? collected.latencyMs) >= collected.latencyThresholdMs
        ? "met or exceeded"
        : "is below",
    region: collected.region ?? null,
    observedAt: collected.observedAt ?? null,
    endpointUrl: collected.endpointUrl ?? null,
    relayState: collected.state ?? null,
    errorMessage: collected.errorMessage ?? null,
    dependencyId: collected.dependencyId ?? null,
    dependencyName: collected.dependencyName ?? null,
    methodologyVersion: collected.methodologyVersion ?? null,
    evidenceUrl: collected.evidenceUrl ?? null,
    incident: collected.incident ?? null,
    publicState: collected.publicState ?? null,
    publicNote: collected.publicNote ?? null,
    isUp: lastResult?.is_up ?? null,
    quorumConfirmed: lastResult?.quorum_confirmed ?? null,
  };
}

function buildJsonPayload(observation, config, exitCode, matched, failOn) {
  return {
    schema: "reliastra-action/1",
    mode: config.mode,
    target: config.dependency,
    verdict: observation.verdict,
    verdictMeaning: VERDICT_MEANING[observation.verdict],
    degraded: observation.derivedLatency,
    latencyMs: observation.latencyMs,
    latencyThresholdMs: observation.latencyThresholdMs,
    httpStatus: observation.httpStatus,
    observedAt: observation.observedAt,
    observationPoint: observation.region,
    observationPoints: 1,
    stale: observation.stale,
    pipelineState: observation.relayState,
    publicState: observation.publicState,
    incident: observation.incident,
    evidenceUrl: observation.evidenceUrl,
    methodologyVersion: observation.methodologyVersion,
    failOn,
    matched,
    exitCode,
    attributionCaveat:
      "Attribution is a weighted score over observed signals. It is not proof of provider causality.",
  };
}

/**
 * Write the JSON record to disk so a later step can upload, diff, or chart it.
 * Failure is a warning, not a failure: the observation already succeeded and the
 * exit code must not be changed by a filesystem problem in a reporting step.
 */
function writeJsonFile(path, serialised, gh, ink) {
  try {
    writeFileSync(path, `${serialised}\n`, "utf8");
    gh.info(ink.gray(`  wrote ${path}`));
  } catch (error) {
    gh.warning(
      "Reliastra: could not write the JSON record",
      `Attempted to write "${path}" and failed: ${error.message}. The observation and exit code are unaffected.`,
    );
  }
}

function writeOutputs(observation, config, exitCode, matched, series, summaryMarkdown, collected) {
  const outputs = {
    verdict: observation.verdict,
    status: observation.verdict,
    "exit-code": exitCode,
    degraded: String(observation.derivedLatency),
    stale: String(observation.stale),
    "latency-ms": observation.latencyMs ?? "",
    "http-status": observation.httpStatus ?? "",
    "observed-at": observation.observedAt ?? "",
    "observation-point": observation.region,
    "observation-points": "1",
    "pipeline-state": observation.relayState ?? "",
    "methodology-version": observation.methodologyVersion ?? "",
    "evidence-url": observation.evidenceUrl ?? "",
    "incident-id": observation.incident?.incidentId ?? "",
    "attribution-status": observation.incident?.attributionStatus ?? "",
    "evidence-hash": observation.incident?.evidenceHash ?? "",
    matched: matched.join(","),
    mode: config.mode,
    "series-count": series.count,
    "series-failures": series.failures,
    "series-latencies": series.latencies.filter((v) => v !== null).join(","),
    "series-outcomes": series.points.map((r) => (r?.is_up ? "up" : "down")).join(","),
    summary: summaryMarkdown,
  };
  for (const [key, value] of Object.entries(outputs)) gh.setOutput(key, value);
}

function emitAnnotation(observation, exitCode) {
  const title = `Reliastra: ${String(observation.verdict).toUpperCase()}`;
  const bits = [
    observation.endpointUrl ? `target: ${observation.endpointUrl}` : null,
    `observation point: ${observation.region} (1 point)`,
    observation.httpStatus !== null ? `HTTP ${observation.httpStatus}` : null,
    observation.evidenceUrl,
  ].filter(Boolean);
  const message = bits.join(" · ");

  if (exitCode === EXIT.OK) gh.notice(title, message);
  else gh.error(title, message);
}

function handleFailure(error, { ink, glyphs, unicode, config, raw }) {
  const exitCode = error instanceof ReliastraError ? error.exitCode : EXIT.API;
  const name = error?.name ?? "Error";
  const message = error?.message ?? String(error);

  gh.info("");
  gh.info(renderFailure({ name, message, hint: error?.hint, exitCode }, { ink, glyphs, unicode }));

  // A failure still writes outputs and a summary: a workflow that dies with no
  // summary is the "something went wrong" this action exists to replace.
  gh.appendSummary(
    [
      "### RELIASTRA",
      "",
      `> **The action could not complete a check.** Exit code \`${exitCode}\` (\`${name}\`).`,
      "",
      "```text",
      message,
      error?.hint ? `\nhint: ${error.hint}` : "",
      "```",
      "",
      exitCode === EXIT.AUTH
        ? "No observation was made. An authentication failure says nothing about your dependency."
        : exitCode === EXIT.NETWORK
          ? "No observation was made. A network failure says nothing about your dependency."
          : "No observation was made.",
      "",
      `<sub>[reliastra.com](https://reliastra.com) · exit code reference: ` +
        `\`0\` ok · \`1\` usage · \`2\` api · \`3\` auth · \`4\` unverified · \`5\` denied · \`6\` network</sub>`,
    ].join("\n"),
  );

  gh.setOutput("verdict", "error");
  gh.setOutput("status", "error");
  gh.setOutput("exit-code", exitCode);
  gh.setOutput("error", message);
  gh.setOutput("matched", "");
  gh.setOutput("mode", config?.mode ?? "unknown");
  gh.error(`Reliastra: ${name} (exit ${exitCode})`, message);

  return exitCode;
}

/* ── Cancellation. Ctrl-C during a wait must not look like success. ──────── */
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interrupted) process.exit(EXIT.INTERRUPT);
    interrupted = true;
    gh.error("Reliastra: cancelled", `Job received ${signal} before the observation completed.`);
    process.exit(EXIT.INTERRUPT);
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    // Last-resort guard: anything uncaught here still exits with a defined code.
    process.stderr.write(`reliastra-action: unhandled failure: ${error?.stack ?? error}\n`);
    process.exitCode = EXIT.API;
  });

export { main, CONDITIONS, VERDICT };