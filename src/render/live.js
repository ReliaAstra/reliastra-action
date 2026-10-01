/**
 * Live 4D observation renderer.
 *
 * "4D" here means the fourth dimension this tool actually has: TIME. A CI log
 * is normally a flat transcript of a function that already finished. This
 * renderer makes the wait visible — the probe being polled, the observation
 * window sliding, the point on the map pulsing.
 *
 * Two rendering modes, chosen automatically:
 *
 *   FULL (TTY)  redraws the world map and the status line in place using
 *               cursor-up, so the ping ring animates. This is what a
 *               developer sees locally.
 *
 *   LINE (CI)   GitHub Actions streams stdout line by line; cursor-up and
 *               other positioning escapes are unreliable there. So the renderer
 *               updates a single line with carriage returns (which do work) and
 *               emits timestamped milestones so the log still carries a real
 *               time axis.
 *
 * The distinction matters: pretending a cursor-up animation works in CI logs
 * produces a wall of repeated frames and a garbled summary. Degrade visibly
 * instead.
 */

import { renderWorldMap } from "./worldmap.js";
import { makeGlyphs, paintVerdict } from "./theme.js";

const SPINNER = {
  unicode: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  ascii: ["|", "/", "-", "\\"],
};

const PING_FRAMES = 6;

export class LiveRenderer {
  constructor({ ink, glyphs, stream = process.stdout, isTTY = Boolean(process.stdout.isTTY), unicode = true, intervalMs = 90 } = {}) {
    this.ink = ink;
    this.glyphs = glyphs;
    this.stream = stream;
    this.isTTY = isTTY;
    this.unicode = unicode;
    this.intervalMs = intervalMs;
    this.mode = isTTY ? "full" : "line";

    this.timer = null;
    this.frame = 0;
    this.startedAt = Date.now();
    // null, not a default region: until the API names an observation point we
    // must not draw a map, because a map implies we looked from somewhere.
    this.region = null;
    this.title = "connecting";
    this.detail = "";
    this.renderedLines = 0; // cursor-up bookkeeping for FULL mode
    this.started = false;
    this.milestones = [];
  }

  /** Switch the map to a different observation point. */
  setRegion(region) {
    if (region && region !== this.region) {
      this.region = region;
      this.#paint();
    }
  }

  setTitle(title, detail = "") {
    this.title = title;
    this.detail = detail;
    this.#paint();
  }

  /**
   * A timestamped line in the log. In CI these are the only time axis a reader
   * gets, so they are written as real log lines rather than overwrites.
   *
   * The current status line must be erased first, otherwise the milestone is
   * appended to the middle of a half-drawn spinner line and the log becomes
   * unreadable. After writing, the status line repaints on the next tick.
   */
  milestone(text, ink = "gray") {
    this.#erase();
    const elapsed = this.#elapsed();
    const stamp = this.ink.gray(`[${elapsed.padStart(6)}]`);
    this.stream.write(`${stamp} ${this.ink[ink](text)}\n`);
    this.milestones.push({ elapsed, text });
    // FULL mode must repaint immediately: the cursor-up redraw assumes the map
    // occupies the last N rows, and the milestone just became row 0 of that
    // block. LINE mode just waits for the next tick.
    if (this.mode === "full") this.#paint();
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.startedAt = Date.now();
    if (this.mode === "full") {
      this.stream.write("\n");
      this.stream.write(`${this.ink.dim("  observing from one point · press Ctrl-C to stop")}\n`);
    }
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % (SPINNER[this.unicode ? "unicode" : "ascii"].length * PING_FRAMES);
      this.#paint();
    }, this.intervalMs);
    // Never hold the process open just for the animation.
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.#clear();
    return this;
  }

  #elapsed() {
    const seconds = (Date.now() - this.startedAt) / 1000;
    return `${seconds.toFixed(1)}s`;
  }

  #spinner() {
    const frames = SPINNER[this.unicode ? "unicode" : "ascii"];
    return frames[this.frame % frames.length];
  }

  #statusLine() {
    const spinnerFrames = SPINNER[this.unicode ? "unicode" : "ascii"];
    const pingFrame = Math.floor(this.frame / spinnerFrames.length) % PING_FRAMES;
    const dot = this.ink.cyan(this.glyphs.dot);
    const name = this.ink.white(this.title.padEnd(28).slice(0, 28));
    const regionText = this.region ?? "resolving";
    const region = this.region
      ? this.ink.ink(this.region.padEnd(9).slice(0, 9))
      : this.ink.gray("resolving".padEnd(9));
    const elapsed = this.ink.gray(this.#elapsed().padStart(7));
    const spin = this.ink.cyan(this.#spinner());
    const detail = this.detail ? `  ${this.ink.gray(this.detail)}` : "";
    const pulse = this.ink.cyan(pingFrame % 2 === 0 ? this.glyphs.dot : " ");
    void regionText;
    return `${spin} ${dot} RELIASTRA ${pulse} ${name}${region}${elapsed}${detail}`;
  }

  #clear() {
    this.#erase();
  }

  /**
   * Erase whatever is currently drawn without touching the animation timer.
   * LINE mode must emit a trailing newline here, otherwise the next write
   * lands on the same row as the status line.
   */
  #erase() {
    if (this.mode === "full") {
      if (this.renderedLines > 0) {
        this.stream.write(`\x1b[${this.renderedLines}A`);
        this.stream.write("\x1b[J");
        this.renderedLines = 0;
      }
      return;
    }
    this.stream.write("\r\x1b[2K");
  }

  #paint() {
    if (!this.started) return;

    if (this.mode === "full") {
      this.#clear();
      const spinnerFrames = SPINNER[this.unicode ? "unicode" : "ascii"];
      const pingFrame = Math.floor(this.frame / spinnerFrames.length) % PING_FRAMES;
      const body = this.region
        ? [
            ...renderWorldMap({
              region: this.region,
              color: this.ink.enabled,
              animate: true,
              frame: pingFrame,
            }).map((l) => `  ${l}`),
            `  ${this.#statusLine()}`,
          ]
        : [`  ${this.#statusLine()}`];
      this.stream.write(`${body.join("\n")}\n`);
      this.renderedLines = body.length;
      return;
    }

    // LINE mode: one carriage-return-updated line.
    this.stream.write(`\r\x1b[2K${this.#statusLine()}`);
  }

  /**
   * Print a frame that will not be overwritten. Called once, after the work is
   * done, so the last thing in the log is a complete record rather than a
   * half-drawn cursor position.
   */
  seal() {
    this.stop();
  }
}

/**
 * The non-animated header used when the renderer is not running (fast paths,
 * or when output is captured to a file).
 */
export function renderBanner(ink, glyphs, { region, unicode = true } = {}) {
  const lines = renderWorldMap({ region, color: ink.enabled, animate: false, unicode });
  const title = `  ${ink.bold(ink.white("RELIASTRA"))} ${ink.gray("·")} ${ink.gray("external dependency verification")}`;
  return [title, ...lines.map((l) => `  ${l}`)];
}

export { paintVerdict };