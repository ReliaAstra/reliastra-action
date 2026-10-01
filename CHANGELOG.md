# Changelog

All notable changes to this action are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions are the Git tags you reference: `uses: ReliaAstra/reliastra-action@v1`.

## [Unreleased]

## [1.0.0] - 2026-10-01

First release. Thin integration layer over the Reliastra API. It reads an
observation, renders it, and exits with a documented code. It does not
implement monitoring, detection, or attribution; those live in the Reliastra
service and its CLI.

### Added

- **Two observation modes.** Authenticated (`token:` + dependency UUID) reads
  `GET /v1/checks/state/{id}` and `GET /v1/dependencies/{id}/results`. Public
  (no token, vendor slug) reads `GET /v1/public/incidents`. Public mode never
  reports `up`: an absent incident is not a healthy dependency.
- **Verdict mapping from real states only.** Every `CheckState` the backend can
  return maps to a verdict. `degraded` is derived from latency versus a
  threshold, and is labelled as derived in every surface.
- **Exit codes matching the Reliastra CLI** (`cli/cmd/reliastra/main.go`):
  `0` ok, `1` usage, `2` api, `3` auth, `4` unverified, `5` denied,
  `6` network, `130` cancelled. `unverified` is always non-zero.
- **`fail-on` gate.** Comma-separated conditions, plus `any` and `never`.
  Unknown values are usage errors rather than silent no-ops.
- **Live runner log.** In-place status line with an animated observation-point
  map and timestamped milestones. Degrades to a single carriage-return line
  where cursor addressing is unreliable.
- **Job summary.** Verdict banner, field table, observation-point map,
  latency sparkline, outcome ribbon, incident attribution, gate decision, run
  timeline, and a caveat that states what was not concluded.
- **Outputs** for verdict, exit code, latency, HTTP status, observation point,
  staleness, evidence hash, matched gate conditions, the observation series,
  and the rendered summary.
- **JSON mode** (`result-format: json`) emitting a machine-readable record.
- **`wait-seconds`** to poll for a settled observation, bounded.
- **SSRF-refusal reporting.** `blocked_by_security_policy` renders as `blocked`
  and is explicitly documented as a configuration problem, never a vendor
  outage.

### Security

- Zero runtime dependencies. `dist/` is our code plus Node built-ins.
- Refuses non-`http(s)` `base-url` schemes.
- Does not echo the token in any output, summary, or error message.
- Sends no telemetry. The only outbound request is to the configured API root.

[Unreleased]: https://github.com/ReliaAstra/reliastra-action/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ReliaAstra/reliastra-action/releases/tag/v1.0.0