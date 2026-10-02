/**
 * Generates the PNG icons from the one SVG.
 *
 * The SVG stays the source of truth and the PNGs are build output from it, so the
 * tab icon, the iOS home-screen icon and the in-app mark cannot drift apart the
 * way three hand-drawn icons would.
 */
import sharp from "sharp";
import { readFileSync } from "node:fs";

const src = readFileSync("src/assets/favicon.svg");
const out = [
  ["favicon-16.png", 16],
  ["favicon-32.png", 32],
  ["apple-touch-icon.png", 180],
];
for (const [name, size] of out) {
  await sharp(src, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toFile(`src/assets/${name}`);
  console.log("wrote", name, size);
}
