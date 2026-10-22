import { mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

// Placeholder pass images (a coffee cup on the brand color). The shop's real logo replaces these.
const outDir = join(process.cwd(), "assets", "pass");
mkdirSync(outDir, { recursive: true });

const BROWN = "#6F4E37";
const CREAM = "#F5EEE4";

const cup = (size: number, color: string) =>
  `<g transform="scale(${size / 24})">` +
  `<path d="M3 6h14v7a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6z" fill="${color}"/>` +
  `<path d="M17 8h1.5a3 3 0 0 1 0 6H17" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/>` +
  `<rect x="2" y="20.5" width="16" height="1.8" rx="0.9" fill="${color}"/>` +
  `</g>`;

async function icon(px: number, name: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}"><rect width="${px}" height="${px}" rx="${px * 0.2}" fill="${BROWN}"/><g transform="translate(${px * 0.12} ${px * 0.12})">${cup(px * 0.76, CREAM)}</g></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(join(outDir, name));
}

async function logo(w: number, h: number, name: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g transform="translate(${w * 0.02} ${h * 0.08})">${cup(h * 0.84, CREAM)}</g></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(join(outDir, name));
}

await icon(29, "icon.png");
await icon(58, "icon@2x.png");
await icon(87, "icon@3x.png");
await logo(160, 50, "logo.png");
await logo(320, 100, "logo@2x.png");
await logo(480, 150, "logo@3x.png");
console.log(`Wrote placeholder images to ${outDir}`);
