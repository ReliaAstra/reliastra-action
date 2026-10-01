/**
 * World map renderer for the observation point.
 *
 * WHY THIS EXISTS
 * ---------------
 * The point of this action is that somebody's CI found a failure. Reliastra's
 * job is to say whether the *dependency* actually failed, and from where. A map
 * makes the observation point legible in one glance instead of asking a reader
 * to trust the word "us-east" in a table cell.
 *
 * HONESTY CONSTRAINT (read before editing)
 * ----------------------------------------
 * Reliastra runs ONE observation point. `us-east` is a LABEL, not a
 * measurement of breadth. See backend/app/modules/dependencies/constants.py:
 * a previous configuration dispatched two probes per interval from one worker
 * and stamped them with two region labels, which satisfied QUORUM_MIN_REGIONS
 * and published a single host's opinion as independent corroboration.
 *
 * So this map marks exactly ONE dot. Never draw two. Never label a region
 * "confirmed by N regions". The renderer prints `1 observation point` in the
 * frame footer precisely so that a screenshot of this block cannot be
 * mistaken for multi-region consensus.
 *
 * The land mask below is a stylised 60x16 equirectangular dot map. It is
 * decorative, not survey-grade. If it is wrong, the coordinates in REGIONS
 * (which are real) still place the marker on the right continent.
 */

const COLS = 60;
const ROWS = 16;
const LAT_TOP = 80;
const LAT_STEP = 9.3333;

/**
 * Real region vocabulary, taken from the backend:
 *   ALLOWED_REGIONS  = {"us-east", "eu-west", "ap-south", "sa-east"}
 *   DEPLOYED_REGION  = "us-east"
 * Lat/lon are the label's approximate centroid, used only for placement.
 */
export const REGIONS = {
  "us-east": { lat: 40.7, lon: -74.0 },
  "us-west": { lat: 37.4, lon: -122.1 },
  "eu-west": { lat: 53.3, lon: -6.2 },
  "eu-central": { lat: 50.1, lon: 8.7 },
  "ap-south": { lat: 19.1, lon: 72.9 },
  "ap-southeast": { lat: 1.35, lon: 103.8 },
  "ap-northeast": { lat: 35.7, lon: 139.7 },
  "sa-east": { lat: -23.5, lon: -46.6 },
};

/**
 * Land as inclusive [startCol, endCol] ranges per row.
 * Row 0 is LAT_TOP (80N); row 15 is about 60S. Col 0 is 180W, col 59 is 174E.
 */
const LAND = [
  [[12, 20], [21, 27], [31, 35], [40, 59]], // 80N  arctic + Siberia
  [[2, 6], [7, 19], [21, 26], [33, 59]], //  71N  Alaska, Canada, Greenland
  [[2, 6], [7, 20], [22, 23], [31, 59]], //  61N  Scandinavia joins
  [[8, 21], [28, 59]], //  52N  N America + Eurasia
  [[9, 18], [28, 45], [46, 54]], //  43N  US, Europe, Asia, Japan
  [[10, 17], [28, 40], [41, 50], [52, 53]], //  33N  Sahara, Middle East
  [[12, 14], [16, 18], [28, 35], [36, 45], [47, 50]], //  24N  Mexico, Arabia
  [[14, 16], [18, 20], [27, 37], [41, 45], [46, 48]], //  15N  C.America, India
  [[16, 17], [17, 22], [31, 37], [47, 50], [50, 51]], //   5N  Amazon, SE Asia
  [[17, 24], [31, 37], [46, 53]], //  -4N  Congo, Indonesia
  [[17, 24], [32, 37], [48, 55]], // -13N  Brazil, Indonesia
  [[18, 23], [32, 36], [37, 38], [49, 56]], // -23N  Madagascar, Australia
  [[18, 22], [32, 36], [49, 56]], // -32N  S Africa, Australia
  [[18, 20], [58, 59]], // -41N  Patagonia, NZ
  [[18, 19]], // -51N  Patagonia
  [[18, 19]], // -60N
];

const PING_GLYPHS = ["·", "•", "•", "•"];

/** Wrap a string in truecolor SGR. No-ops when colour is disabled. */
function paint(text, hex, enabled) {
  if (!enabled) return text;
  const n = parseInt(hex.replace("#", ""), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${text}\x1b[0m`;
}

function toCol(lon) {
  return Math.min(COLS - 1, Math.max(0, Math.round(((lon + 180) / 360) * (COLS - 1))));
}

function toRow(lat) {
  return Math.min(ROWS - 1, Math.max(0, Math.round((LAT_TOP - lat) / LAT_STEP)));
}

/**
 * Resolve a region label to a grid position.
 * Unknown labels fall back to us-east, the deployed observation point, and the
 * caller is told via `known: false` so it can say so rather than lie.
 */
export function resolveRegion(label) {
  const key = String(label ?? "").trim().toLowerCase();
  if (key && REGIONS[key]) {
    const { lat, lon } = REGIONS[key];
    return { region: key, row: toRow(lat), col: toCol(lon), known: true };
  }
  const { lat, lon } = REGIONS["us-east"];
  return { region: key || "us-east", row: toRow(lat), col: toCol(lon), known: false };
}

/**
 * Build the character grid, then overlay one marker plus an optional expanding
 * ping ring. Returns an array of ROWS strings.
 */
function buildGrid({ row, col, frame = 0, animate = false }) {
  const grid = LAND.map((ranges) => {
    const cells = new Array(COLS).fill(" ");
    for (const [from, to] of ranges) {
      for (let c = from; c <= to && c < COLS; c += 1) cells[c] = "·";
    }
    return cells;
  });

  if (animate) {
    // Ring radius grows then collapses, so the eye reads it as a pulse.
    const radius = frame % 4;
    const glyph = PING_GLYPHS[frame % PING_GLYPHS.length];
    if (radius > 0) {
      for (let r = 0; r < ROWS; r += 1) {
        for (let c = 0; c < COLS; c += 1) {
          const dr = Math.abs(r - row);
          const dc = Math.abs(c - col);
          if (dr === 0 && dc === radius) grid[r][c] = glyph;
          else if (dr === radius && dc === 0) grid[r][c] = glyph;
          else if (dr === radius && dc === radius && (r < row ? c < col : c > col)) {
            grid[r][c] = glyph;
          }
        }
      }
    }
  }

  if (grid[row]) grid[row][col] = "●";
  return grid.map((cells) => cells.join("").replace(/\s+$/, ""));
}

/**
 * Render the map as an array of lines.
 *
 * @param {object} opts
 * @param {string} opts.region        region label to mark
 * @param {number} [opts.frame]       animation frame index
 * @param {boolean} [opts.animate]    draw the expanding ping ring
 * @param {boolean} [opts.color]      emit ANSI colour
 */
export function renderWorldMap({ region, frame = 0, animate = false, color = true }) {
  const { region: label, row, col, known } = resolveRegion(region);
  const grid = buildGrid({ row, col, frame, animate });

  const land = paint("·", "#3d4451", color);
  const dot = paint("●", "#22d3ee", color);
  const ping = paint("•", "#0891b2", color);

  const lines = grid.map((line) =>
    line
      .split("")
      .map((ch) => {
        if (ch === "●") return dot;
        if (animate && ch === "•") return ping;
        if (ch === "·") return land;
        return ch;
      })
      .join(""),
  );

  const unknownNote = known ? "" : "  (unrecognised label - marker shown at deployed point)";
  lines.push(paint(`   1 observation point: ${label}${unknownNote}`, "#6b7280", color));

  return lines;
}

/** Single-line variant for tight log contexts. */
export function renderWorldMapInline({ region, color = true }) {
  const { region: label, known } = resolveRegion(region);
  return `${paint("◆", "#22d3ee", color)} ${label}${known ? "" : " (unrecognised)"}`;
}