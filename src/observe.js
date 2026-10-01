/**
 * Observation collection.
 *
 * Two modes, kept strictly separate because they answer different questions:
 *
 *   AUTHENTICATED  one dependency, probed by Reliastra, with a real CheckState
 *                  and a real latency measurement.
 *
 *   PUBLIC         the public incident feed for a vendor slug. This is
 *                  incident intelligence, NOT a health probe. It can report an
 *                  open incident. It can never report "UP", because an absent
 *                  incident is not a healthy dependency. Conflating those two
 *                  would be the single most misleading thing this Action could
 *                  do, so the two modes do not share a verdict vocabulary.
 */

import { VERDICT } from "./status.js";

const POLL_INTERVAL_MS = 5000;
const ATTRIBUTION_URL = "https://reliastra.com/observatory";

/** Collect everything the authenticated endpoints know about one dependency. */
export async function observeAuthenticated(client, config, live) {
  const id = config.dependency;

  const dependency = await client.getDependency(id);
  live?.setTitle(`observing · ${dependency.name}`, dependency.endpoint_url ?? "");
  live?.setRegion(dependency.regions?.[0] ?? null);
  live?.milestone(`dependency resolved: ${dependency.name}`, "gray");

  const jobStart = new Date();
  const state = await awaitSettledObservation(client, config, id, live, jobStart);

  const results = await client.getResults(id, { page: 1, size: config.historyLimit });
  live?.setRegion(state.last_result?.region ?? dependency.regions?.[0] ?? null);
  live?.milestone(`history: ${results.length} observation(s) retrieved`, "gray");

  // Threshold precedence: an explicit input beats the dependency's own
  // configured alert threshold. Neither present means DEGRADED is unavailable
  // and is never fabricated from a default.
  const thresholdMs = config.latencyThresholdMs ?? numberOrNull(dependency.alert_threshold_ms);
  const thresholdSource = config.latencyThresholdMs
    ? "action input"
    : numberOrNull(dependency.alert_threshold_ms) !== null
      ? "dependency alert_threshold_ms"
      : null;

  return {
    mode: "authenticated",
    dependencyId: id,
    dependencyName: dependency.name ?? null,
    endpointUrl: dependency.endpoint_url ?? null,
    state: state.state,
    // The record the state machine was derived from. Authoritative for the
    // current observation; `results` is history and may end elsewhere.
    lastResult: state.last_result ?? null,
    isTargetProblem: state.is_target_problem ?? null,
    isInfrastructureProblem: state.is_infrastructure_problem ?? null,
    detail: state.detail ?? null,
    region: state.last_result?.region ?? dependency.regions?.[0] ?? "us-east",
    regions: dependency.regions ?? [],
    latencyMs: numberOrNull(state.last_result?.latency_ms),
    httpStatus: numberOrNull(state.last_result?.status_code),
    observedAt: state.last_result?.executed_at ?? null,
    errorMessage: state.last_result?.error_message ?? null,
    stale: Boolean(state.is_stale),
    latencyThresholdMs: thresholdMs,
    thresholdSource,
    results,
    checkIntervalSeconds: state.check_interval_seconds ?? dependency.check_interval_seconds ?? null,
    methodologyVersion: null,
    evidenceUrl: null,
    incident: null,
    publicState: null,
  };
}

/**
 * Poll until a probe has actually settled, or `wait-seconds` runs out.
 *
 * "Settled" is derived through the verdict, not by re-listing state enums, so
 * the wait and the verdict can never disagree about what counts as a result.
 * With wait-seconds: 0 this is a single read — the default, because waiting
 * silently turns a fast action into a slow one.
 */
async function awaitSettledObservation(client, config, id, live, jobStart) {
  const first = await client.getCheckState(id);

  if (config.waitSeconds === 0) return first;

  const deadline = Date.now() + config.waitSeconds * 1000;
  let state = first;
  let polls = 0;

  live?.milestone(`waiting up to ${config.waitSeconds}s for a settled observation`, "gray");

  while (Date.now() < deadline) {
    const settled = state.last_result !== null && state.last_result !== undefined;
    const fresh = !state.is_stale;
    const observed = state.last_result?.executed_at
      ? new Date(state.last_result.executed_at) >= jobStart
      : false;

    if (settled && (fresh || observed)) {
      live?.milestone(
        `observation settled (state=${state.state}, executed_at=${state.last_result?.executed_at ?? "—"})`,
        "green",
      );
      return state;
    }

    polls += 1;
    const remaining = Math.round((deadline - Date.now()) / 1000);
    live?.milestone(
      `not settled (state=${state.state}${state.is_stale ? ", stale" : ""}) — ${remaining}s left`,
      "gray",
    );

    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(250, deadline - Date.now())));
    state = await client.getCheckState(id);
  }

  live?.milestone(`wait window elapsed after ${polls} poll(s); reporting last known state`, "gray");
  return state;
}

/**
 * Public incident feed.
 *
 * `publicState` is one of:
 *   open-incident   a confirmed incident is open for this vendor
 *   resolved-only   incidents exist, none open
 *   no-records      the feed has nothing for this slug
 */
export async function observePublic(client, config, live) {
  const vendor = config.dependency;
  const statusFilter = config.incidentStatus === "all" ? undefined : config.incidentStatus;
  live?.setTitle(`public feed · ${vendor}`);

  const feed = await client.searchPublicIncidents({
    vendor,
    status: statusFilter,
    limit: 20,
  });
  live?.milestone(
    `public feed: ${feed.items.length} record(s) for "${vendor}"${statusFilter ? ` (${statusFilter})` : ""}`,
    "gray",
  );

  if (feed.items.length === 0) {
    return {
      mode: "public",
      dependencyId: null,
      dependencyName: vendor,
      endpointUrl: null,
      state: null,
      // null, not a label: nothing was probed, so there is no observation
      // point to point at. Rendering a map here would imply a measurement
      // that never happened.
      region: null,
      latencyMs: null,
      httpStatus: null,
      observedAt: null,
      errorMessage: null,
      stale: false,
      latencyThresholdMs: null,
      thresholdSource: null,
      results: [],
      methodologyVersion: null,
      evidenceUrl: `${ATTRIBUTION_URL}/${vendor}`,
      incident: null,
      publicState: "no-records",
      publicNote:
        `The public feed has no incident record for "${vendor}". That is an absence of ` +
        "published incidents, NOT a health check. Supply `token:` for a real observation.",
    };
  }

  const summary = feed.items[0];
  const isOpen = String(summary.status ?? "").toLowerCase() === "open";

  // Fetch the detail record for the evidence descriptor. Failure here degrades
  // the report, it does not invalidate the incident: the summary already
  // carries everything needed to gate CI.
  let detail = null;
  try {
    detail = await client.getPublicIncident(summary.incident_id);
    live?.milestone("incident detail + evidence descriptor retrieved", "gray");
  } catch (error) {
    live?.milestone(`evidence descriptor unavailable (${error.message}); gating on summary`, "gray");
  }

  const evidence = detail?.evidence ?? null;

  return {
    mode: "public",
    dependencyId: null,
    dependencyName: summary.vendor_display_name ?? vendor,
    endpointUrl: summary.endpoint_url ?? null,
    state: null,
    region: summary.region ?? "us-east",
    latencyMs: null,
    httpStatus: null,
    observedAt: summary.started_at ?? null,
    errorMessage: null,
    stale: false,
    latencyThresholdMs: null,
    thresholdSource: null,
    results: [],
    methodologyVersion: summary.methodology_version ?? detail?.methodology_version ?? null,
    evidenceUrl: `${ATTRIBUTION_URL}/${summary.vendor_name ?? vendor}`,
    publicState: isOpen ? "open-incident" : "resolved-only",
    publicNote: isOpen
      ? "An incident is open on Reliastra's public record for this vendor."
      : "No incident is currently open on Reliastra's public record for this vendor. " +
        "This is not a health check.",
    incident: {
      incidentId: summary.incident_id,
      status: summary.status,
      severity: summary.severity,
      failureKind: summary.failure_kind,
      attributionStatus: summary.attribution_status,
      attributionScore: numberOrNull(detail?.attribution_score ?? detail?.attribution?.score),
      observationCount: summary.observation_count,
      failureCount: summary.failure_count,
      startedAt: summary.started_at,
      resolvedAt: summary.resolved_at,
      durationSeconds: summary.duration_seconds,
      detectionRule: detail?.detection_rule,
      evidenceHash: evidence?.data_hash ?? null,
      evidenceByteSize: evidence?.byte_size ?? null,
      evidenceGeneratedAt: evidence?.generated_at ?? null,
    },
  };
}

/**
 * Map a raw collection into the verdict the rest of the action renders.
 * Public mode gets its own mapping; see the module header for why.
 */
export function toVerdict(collected) {
  if (collected.mode === "public") {
    if (collected.publicState === "open-incident") {
      return { verdict: VERDICT.DOWN, stale: false, degraded: false };
    }
    return { verdict: VERDICT.UNVERIFIED, stale: false, degraded: false };
  }
  return null; // authenticated mode derives through status.js
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}