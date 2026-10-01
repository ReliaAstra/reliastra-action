/**
 * Time-series rendering.
 *
 * A reliability record is a series, not a number. Printing `latency 412ms` with
 * no history hides the two things a reader actually needs: whether this is new,
 * and whether it is getting worse. So the action renders the shape of the last
 * N observations, in time order, oldest to the left.
 *
 * Rules:
 *  - Never render more samples than exist. Missing data is shown as a gap, not
 *    as a zero. A zero would read as "instantly responded".
 *  - Failures are drawn on their own ribbon so a wall of latency numbers cannot
 *    hide a single failed probe.
 */

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const ASCII_BLOCKS = ["_", ".", ".", ":", ":", "|", "|", "#"];

/**
 * Normalise an array of CheckResultResponse into chronological order and
 * project it down to `width` columns.
 *
 * @param {Array<object>} results raw results, newest first (as the API returns)
 * @param {object} opts
 */
export function buildSeries(results, { width = 40 } = {}) {
  const chronological = [...(results ?? [])]
    .filter((r) => r && typeof r === "object")
    .sort((a, b) => new Date(a.executed_at).getTime() - new Date(b.executed_at).getTime());

  const trimmed = chronological.slice(-width);
  const latencies = trimmed.map((r) =>
    typeof r.latency_ms === "number" && Number.isFinite(r.latency_ms) ? r.latency_ms : null,
  );
  const present = latencies.filter((v) => v !== null);

  return {
    points: trimmed,
    latencies,
    ups: trimmed.map((r) => r?.is_up === true),
    hasData: present.length > 0,
    min: present.length ? Math.min(...present) : null,
    max: present.length ? Math.max(...present) : null,
    count: trimmed.length,
    failures: trimmed.filter((r) => r?.is_up === false).length,
  };
}

/**
 * Latency sparkline. Gaps render as a space so a missing sample is visibly
 * absent rather than drawn as a bottom-of-range value.
 */
export function renderLatencySparkline(series, { width = 40, unicode = true } = {}) {
  const glyphs = unicode ? BLOCKS : ASCII_BLOCKS;
  if (!series.hasData || series.count === 0) {
    return { text: "no latency samples".padEnd(Math.min(width, 40)).slice(0, width), legend: "" };
  }

  const { min, max } = series;
  const span = max - min;
  const cells = series.latencies.map((value) => {
    if (value === null) return " ";
    const ratio = span === 0 ? 1 : (value - min) / span;
    const index = Math.min(glyphs.length - 1, Math.max(0, Math.round(ratio * (glyphs.length - 1))));
    return glyphs[index];
  });

  const legend = span === 0
    ? `${formatMs(min)} (flat)`
    : `${formatMs(min)} – ${formatMs(max)}`;

  return { text: cells.join(""), legend };
}

/**
 * Success/failure ribbon: one glyph per observation, oldest to newest.
 * This is the shape a reader scans to answer "is this new, or ongoing?".
 */
export function renderStatusRibbon(series, { ink, glyphs, unicode = true }) {
  if (series.count === 0) return ink.gray("(no observations yet)");
  const upMark = unicode ? "▔" : "^";
  const downMark = unicode ? "▁" : "!";
  const cells = series.points.map((r, i) =>
    series.ups[i] ? ink.green(upMark) : ink.red(downMark),
  );
  return cells.join("");
}

export function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** UTC, second precision, unambiguous in a CI log. */
export function formatUtc(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}