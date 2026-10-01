# RELIASTRA

**Your CI failed. Was the dependency actually down?**

Reliastra independently observes the external APIs your application depends on. When your
own monitoring reports a failure, Reliastra is the second, separate observation that tells
you whether the vendor was genuinely down — and produces an evidence record you can hand
to someone who asks *how do you know?*

This action is a thin integration layer. It reads one observation from the Reliastra API,
renders it into your job summary, and exits with a documented code.

```
RELIASTRA · action v1.0.0  mode: public  target: xai

  RELIASTRA  ·  external dependency verification
  ──────────────────────────────────────────────────────────────────────────────
  ▲ PUBLIC INCIDENT FEED — no token supplied, this is Reliastra's public record, not a private check of your dependency

  Observation       ✖ DOWN
                    The last probe reached the target and it failed.

Dependency          xAI
Endpoint            https://status.x.ai
Observed            2026-09-26 17:10:58 UTC
Observation point   ● us-east  1 point, not a consensus
Methodology         v1.0

              ················   ·····    ····················
    ·················· ······      ···························
    ··················· ··       ····························
          ··············      ································
           ········●·         ···························
            ········          ······················· ··
              ··· ···         ·················· ····
                ··· ···      ···········   ········
                  ·······        ·······         ·····
                   ········      ·······        ········
                   ········       ······          ········
                    ······        ·······          ········
                    ·····         ·····            ········
                    ···                                     ··
                    ··
                    ··
     1 observation point: us-east

  ───────────────────────────────────────
Incident            OPEN ebc94793-5950-488f-a0d4-73c05d290b1f
Severity            major
Failure kind        http_4xx
Attribution         observed
Evidence            https://reliastra.com/observatory/xai

  ───────────────────────────────────────
fail-on             down
Matched             down
Exit code           5

  • Reliastra does not claim that provider causality is proven. Confirmation
  • is deterministic from one observation point; attribution is a weighted
  • score, not proof of cause.
```

<sub>Real captured output from `v1.0.0` against the live public feed. In the runner log the
observation point animates live while the check runs.</sub>

---

## Use it

```yaml
name: verify-dependency

on:
  schedule:
    - cron: "*/15 * * * *"
  workflow_dispatch:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Reliastra dependency check
        uses: ReliaAstra/reliastra-action@v1
        with:
          dependency: 4c1f9e2a-3b7d-4c8e-9f1a-2b3c4d5e6f70
          token: ${{ secrets.RELIASTRA_TOKEN }}
          fail-on: degraded
```

No token? Drop it and read the public incident feed for a vendor. This works immediately,
with no account:

```yaml
      - uses: ReliaAstra/reliastra-action@v1
        with:
          dependency: stripe
          fail-on: down
```

**[Try Reliastra](https://reliastra.com)** · **[Documentation](https://reliastra.com/docs)** ·
**[Methodology](https://reliastra.com/docs/methodology)** · **[Observatory](https://reliastra.com/observatory)**

---

## What the exit code means

These match the [Reliastra CLI](https://github.com/ReliaAstra/Reliastra) byte for byte, so
a pipeline that passes locally does not break in CI.

| Code | Meaning |
|---:|---|
| `0` | Observation recorded; job passes |
| `1` | Invalid or missing input; nothing was called |
| `2` | Reliastra returned an error or an unreadable body |
| `3` | Token missing, malformed, or rejected (`401`/`403`) |
| `4` | No observation exists yet; nothing can be concluded |
| `5` | An observation was made and it matched your `fail-on` gate |
| `6` | Could not reach `reliastra.com` (DNS, TLS, timeout, reset) |
| `130` | The job was cancelled while waiting |

There is no generic "something went wrong". Every failure names its category, its cause, and
what was **not** concluded.

### Verdicts

Every verdict is derived from a real backend `CheckState`. Nothing here is invented.

| Verdict | Derived from | Failure of |
|---|---|---|
| `up` | `successful` | — |
| `down` | `target_failed` | the target |
| `blocked` | `blocked_by_security_policy` | **your configuration**, never the vendor |
| `pipeline-error` | `dispatch_failed`, `scheduler_unavailable` | **Reliastra**, never the vendor |
| `unverified` | `never_checked`, `awaiting_scheduled_execution`, `queued`, `executing` | — |
| `degraded` | **derived by this action**: `successful` and latency ≥ threshold | — |

> **`degraded` is not a Reliastra vendor status.** The backend has no such state. This action
> derives it from two real fields — `successful` plus a latency threshold — and labels it as
> derived everywhere it is displayed. The threshold is your dependency's own
> `alert_threshold_ms` unless you set `latency-threshold-ms`. With neither set, `degraded` is
> never produced.

`blocked` and `pipeline-error` are deliberately separated from `down`. Confusing them would
mean telling you a vendor was at fault when the truth is that nobody made the request, or
that Reliastra refused to make it.

---

## `fail-on`

Comma-separated, or `any`, or `never`.

```yaml
fail-on: down              # default: fail only on a confirmed target failure
fail-on: degraded,down     # also fail on slow-but-successful
fail-on: stale             # fail when the last observation is older than its cadence
fail-on: any               # everything except up
fail-on: never             # status alone never fails; usage/auth/network still do
```

An unknown value is a usage error (`exit 1`), not a silently ignored typo.

In **authenticated** mode, `unverified` is **not** configurable: you configured a specific
dependency, and an action that exits `0` when it observed nothing turns an absent measurement
into a green tick. It always exits `4`.

In **public** mode it *is* configurable, because public mode is a query, not a probe — see below.

---

## Inputs

| Input | Default | Description |
|---|---|---|
| `dependency` | *(required)* | Dependency UUID with `token`, or a vendor slug without |
| `token` | — | API key, sent as `X-API-Key`. Keys start with `rel_` |
| `fail-on` | `down` | Conditions that fail the job |
| `base-url` | `https://reliastra.com/api` | API root |
| `wait-seconds` | `0` | Wait for a settled observation before reporting |
| `timeout-seconds` | `30` | Per-request timeout |
| `retries` | `2` | Extra attempts for transient failures |
| `history-limit` | `40` | Past observations to fetch for the series |
| `latency-threshold-ms` | — | Overrides the dependency's alert threshold |
| `incident-status` | `all` | Public mode: `all`, `open`, `resolved` |
| `result-format` | `text` | `json` also prints a machine-readable record |
| `annotate` | `true` | Add a workflow annotation |

## Outputs

`verdict` · `status` · `exit-code` · `degraded` · `stale` · `latency-ms` · `http-status` ·
`observed-at` · `observation-point` · `observation-points` · `pipeline-state` ·
`methodology-version` · `evidence-url` · `incident-id` · `attribution-status` ·
`evidence-hash` · `matched` · `mode` · `series-count` · `series-failures` ·
`series-latencies` · `series-outcomes` · `summary` · `error`

`series-latencies` and `series-outcomes` are oldest-first CSV, so you can chart them yourself:

```yaml
      - uses: ReliaAstra/reliastra-action@v1
        id: reliastra
        continue-on-error: true
        with:
          dependency: stripe
      - run: echo "latencies: ${{ steps.reliastra.outputs.series-latencies }}"
```

---

## Two modes, two vocabularies

| | Authenticated | Public |
|---|---|---|
| Requires | `token` | nothing |
| Reads | your dependencies | the public incident feed |
| Answers | "is this dependency healthy?" | "is there a published open incident?" |
| Can report `up` | yes | **never** |
| Reports latency | yes | no |
| Quiet feed exits | `4` (unverified) | `0` |

Public mode reports **incident intelligence**, not a health probe. An empty feed means no
incident has been *published*, which is not the same as a healthy service — so public mode
says so explicitly, and never prints a green tick it cannot justify.

The two modes also differ on what a quiet result means, deliberately:

- **Authenticated:** you asked us to observe a specific dependency and we have nothing to
  show. That is a gap in your setup, and it exits `4`.
- **Public:** you asked whether an incident is published. "No" is a complete, successful
  answer, and it exits `0`. Failing every pipeline on the most common vendors in the catalog
  would train developers that this action is noise.

Want the strict reading in public mode? Opt in:

```yaml
fail-on: down,unverified
```

Supply a token and public mode becomes a real observation with real latency.

---

## What this action will not do

- **It will not claim causality.** A confirmed incident means failures were deterministically
  confirmed and an evidence record was generated. Attribution is a weighted score, not proof.
- **It will not present one observation point as consensus.** Reliastra runs a single
  observation point. Every surface says so, including the map footer. This is a bug class the
  backend already fixed once — see
  [`dependencies/constants.py`](https://github.com/ReliaAstra/Reliastra) — and the action
  refuses to reintroduce it.
- **It will not turn an absent measurement into a pass.** `unverified` exits `4`.
- **It will not report an SSRF refusal as an outage.**
- **It will not guess at an unknown state.** If the API adds a `CheckState`, this action fails
  loudly on contract drift instead of quietly reporting something nobody verified.
- **It will not send telemetry.** The only outbound request is to the API root you configure.

---

## Development

```bash
npm ci
npm test          # 53 unit tests
npm run build     # bundles src/ into dist/index.js
npm run all       # both
```

`dist/` is committed on purpose: consumers of a JavaScript Action should never have to build
it. CI fails if `dist/` does not match `src/`.

Zero runtime dependencies. The shipped `dist/index.js` is this repository's code plus Node
built-ins.

## Feedback

**Did Reliastra's result match what actually happened?**

That is the only question we need answered, and the [issue templates](.github/ISSUE_TEMPLATE)
exist to capture it. If Reliastra reported a failure your service did not have, or reported
health during a real outage, that is the most valuable report you can file.

## Licence

MIT — see [LICENSE](LICENSE).

Reliastra is an independent project by [Emmanuel Adeshina](https://github.com/EmmanuelAdesina).