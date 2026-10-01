/**
 * Terminal theme and box primitives.
 *
 * Colour policy: the premium look must never become unreadable or corrupt a
 * non-UTF8 log. Colour is enabled when the stream is a TTY, or when the
 * environment explicitly asks for it (GitHub Actions renders ANSI), and is
 * disabled for NO_COLOR or a dumb terminal. Box drawing degrades to ASCII when
 * the terminal cannot be trusted with UTF-8.
 */

import { VERDICT } from "../status.js";

export function detectColor(stream = process.stdout) {
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.GITHUB_ACTIONS === "true") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(stream && stream.isTTY);
}

export function detectUnicode() {
  const locale = `${process.env.LC_ALL || ""}${process.env.LC_CTYPE || ""}${process.env.LANG || ""}`;
  if (locale && !/UTF-?8/i.test(locale)) return false;
  return process.platform !== "win32" || Boolean(process.env.WT_SESSION) || true;
}

/** ANSI helper bound to a boolean, so call sites read cleanly. */
export function makeInk(enabled) {
  const wrap = (open, text) => (enabled ? `\x1b[${open}m${text}\x1b[0m` : text);
  return {
    enabled,
    reset: (t) => wrap(0, t),
    bold: (t) => wrap("1", t),
    dim: (t) => wrap("2", t),
    italic: (t) => wrap("3", t),
    cyan: (t) => wrap("38;5;51", t),
    green: (t) => wrap("38;5;42", t),
    amber: (t) => wrap("38;5;214", t),
    red: (t) => wrap("38;5;203", t),
    magenta: (t) => wrap("38;5;177", t),
    gray: (t) => wrap("38;5;245", t),
    white: (t) => wrap("38;5;255", t),
    ink: (t) => wrap("38;5;110", t),
  };
}

const GLYPHS = {
  unicode: {
    tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│",
    dot: "●", ok: "✔", bad: "✖", warn: "▲", info: "•", rule: "─",
  },
  ascii: {
    tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|",
    dot: "*", ok: "+", bad: "x", warn: "!", info: "*", rule: "-",
  },
};

export function makeGlyphs(unicode = true) {
  return unicode ? GLYPHS.unicode : GLYPHS.ascii;
}

/** Verdict -> { label, colour, glyph, symbol }. Used by every renderer. */
export function verdictStyle(verdict) {
  switch (verdict) {
    case VERDICT.UP:
      return { label: "UP", ink: "green", glyph: "ok", symbol: "✔" };
    case VERDICT.DEGRADED:
      return { label: "DEGRADED", ink: "amber", glyph: "warn", symbol: "▲" };
    case VERDICT.DOWN:
      return { label: "DOWN", ink: "red", glyph: "bad", symbol: "✖" };
    case VERDICT.BLOCKED:
      return { label: "BLOCKED", ink: "magenta", glyph: "warn", symbol: "▲" };
    case VERDICT.UNVERIFIED:
      return { label: "UNVERIFIED", ink: "gray", glyph: "info", symbol: "•" };
    case VERDICT.PIPELINE_ERROR:
      return { label: "PIPELINE ERROR", ink: "magenta", glyph: "bad", symbol: "✖" };
    default:
      return { label: String(verdict ?? "UNKNOWN").toUpperCase(), ink: "gray", glyph: "info", symbol: "•" };
  }
}

/** Render `label` in its verdict colour. */
export function paintVerdict(verdict, ink, glyphs, { compact = false } = {}) {
  const style = verdictStyle(verdict);
  const text = compact ? style.label : `${glyphs[style.glyph]} ${style.label}`;
  return ink[style.ink](text);
}

/** A top and bottom rule with a title, matching the reference layout. */
export function titledRule(title, ink, glyphs, width = 72) {
  const label = ` ${title} `;
  const lead = Math.max(0, Math.floor((width - label.length) / 2));
  const tail = Math.max(0, width - label.length - lead);
  return `${glyphs.rule.repeat(lead)}${ink.bold(ink.white(label))}${glyphs.rule.repeat(tail)}`;
}

/** Pad a visible-length string, ignoring ANSI escapes. */
export function padVisible(text, width) {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = width - visible.length;
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/**
 * `label   value` row with a fixed label column, for aligned field blocks.
 *
 * Label width is sized to the longest label this action emits
 * ("Degraded because" / "Observation point" = 17). When a label still exceeds
 * the column it gets its own line rather than pushing the value out of
 * alignment, because a broken table is worse than an uneven one.
 */
export function field(label, value, ink, { labelWidth = 18, gap = 2 } = {}) {
  const text = String(label ?? "");
  if (text.length >= labelWidth) {
    return `${ink.gray(text)}\n${" ".repeat(labelWidth + gap)}${value}`;
  }
  return `${ink.gray(text.padEnd(labelWidth))}${" ".repeat(gap)}${value}`;
}