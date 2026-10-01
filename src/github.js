/**
 * Minimal GitHub Actions plumbing, implemented directly.
 *
 * The Action ships ZERO runtime dependencies. @actions/core would be bundled
 * into dist/ by esbuild anyway, and hand-rolling these six primitives keeps the
 * committed artifact auditable: every byte a consumer executes is either our
 * code or a Node built-in.
 *
 * Implements the documented workflow commands:
 *   ::error:: / ::warning:: / ::notice::   annotations
 *   $GITHUB_OUTPUT                           step outputs
 *   $GITHUB_STEP_SUMMARY                    job summary
 */

import { appendFileSync } from "node:fs";

/**
 * Write `key=value` to $GITHUB_OUTPUT, heredoc-safe for multi-line values.
 * Without $GITHUB_OUTPUT (a plain local run) it falls back to writing
 * `key=value` to stdout so the values stay inspectable and greppable.
 */
export function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const text = value === undefined || value === null ? "" : String(value);
  if (!file) {
    process.stdout.write(`${name}=${text.split("\n")[0]}\n`);
    return;
  }
  if (!text.includes("\n")) {
    appendFileSync(file, `${name}=${text}\n`);
    return;
  }
  const delimiter = `ghadelimiter_${name}_${Math.random().toString(36).slice(2, 10)}`;
  appendFileSync(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}

/** Append to $GITHUB_STEP_SUMMARY. */
export function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    process.stdout.write(`${markdown}\n`);
    return;
  }
  appendFileSync(file, `${markdown}\n`);
}

/** Escape data for a workflow command: newlines, %, CR, and the ':' in titles. */
function escapeCommand(value) {
  return String(value ?? "")
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

/** A value field on an annotation: rendered as `key=value`. */
function escapeProperty(value) {
  return String(value ?? "")
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

export function annotate(level, title, message, { file, startLine, endLine } = {}) {
  const properties = [`title=${escapeProperty(title)}`];
  if (file) properties.push(`file=${escapeProperty(file)}`);
  if (startLine !== undefined) properties.push(`startLine=${startLine}`);
  if (endLine !== undefined) properties.push(`endLine=${endLine}`);
  process.stdout.write(
    `::${level} ${properties.join(",")}::${escapeCommand(message)}\n`,
  );
}

export const error = (title, message) => annotate("error", title, message);
export const warning = (title, message) => annotate("warning", title, message);
export const notice = (title, message) => annotate("notice", title, message);

export function info(message) {
  process.stdout.write(`${message}\n`);
}

/** True when running inside an Actions runner. */
export const isActions = process.env.GITHUB_ACTIONS === "true";