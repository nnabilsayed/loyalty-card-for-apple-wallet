import sharp from "sharp";

/** Wallet's strip image size at 1x. */
export const STRIP_SIZES = { width: 375, height: 123 } as const;

/** Up to this many cups are drawn one by one; bigger goals get a progress bar. */
export const MAX_CUPS_DRAWN = 20;

export type StripLayout =
  | { kind: "cups"; filled: number; total: number }
  | { kind: "bar"; fraction: number };

export function stripLayout(cups: number, goal: number): StripLayout {
  const shown = Math.min(Math.max(cups, 0), goal);
  if (goal <= MAX_CUPS_DRAWN) return { kind: "cups", filled: shown, total: goal };
  return { kind: "bar", fraction: shown / goal };
}

const COLORS = {
  background: "#F5EEE4",
  filled: "#6F4E37",
  empty: "#D9C9B6",
  emptyStroke: "#B49A80",
  track: "#D9C9B6",
};

function cupSvg(x: number, y: number, size: number, filled: boolean): string {
  const s = size / 24;
  const fill = filled ? COLORS.filled : COLORS.empty;
  const stroke = filled ? COLORS.filled : COLORS.emptyStroke;
  return (
    `<g transform="translate(${x} ${y}) scale(${s})">` +
    `<path d="M3 6h14v7a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6z" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<path d="M17 8h1.5a3 3 0 0 1 0 6H17" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round"/>` +
    `<rect x="2" y="20.5" width="16" height="1.8" rx="0.9" fill="${stroke}"/>` +
    `</g>`
  );
}

function stripBody(layout: StripLayout): string {
  const { width, height } = STRIP_SIZES;
  if (layout.kind === "bar") {
    const barW = width - 60;
    const barH = 26;
    const x = 30;
    const y = (height - barH) / 2;
    const filledW = Math.round(barW * layout.fraction);
    return (
      `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="${barH / 2}" fill="${COLORS.track}"/>` +
      (filledW > 0
        ? `<rect x="${x}" y="${y}" width="${Math.max(filledW, barH)}" height="${barH}" rx="${barH / 2}" fill="${COLORS.filled}"/>`
        : "")
    );
  }

  const perRow = layout.total > 10 ? 10 : layout.total;
  const rows = Math.ceil(layout.total / perRow);
  const sidePad = 24;
  const cell = Math.min(52, (width - 2 * sidePad) / perRow);
  const size = cell * 0.8;
  const rowHeight = size + 10;
  const top = (height - rows * rowHeight + 10) / 2;

  let out = "";
  for (let i = 0; i < layout.total; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const inRow = row === rows - 1 ? layout.total - row * perRow : perRow;
    const rowWidth = inRow * cell;
    const left = (width - rowWidth) / 2 + (cell - size) / 2;
    out += cupSvg(left + col * cell, top + row * rowHeight, size, i < layout.filled);
  }
  return out;
}

/** Draws the strip picture for a card: cups for small goals, a progress bar for big ones. */
export async function drawStrip(cups: number, goal: number, scale: 1 | 2 | 3): Promise<Buffer> {
  const { width, height } = STRIP_SIZES;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${COLORS.background}"/>` +
    stripBody(stripLayout(cups, goal)) +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
