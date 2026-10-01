/**
 * Verifies the thing that actually deploys.
 *
 * `npm run build` runs vite, which builds the client and nothing else. Vercel
 * then deploys a second artifact this never touched: api/[[...route]].ts, bundled
 * as a Node serverless function. So a green build said nothing about half of what
 * ships, and the function's import graph had never been resolved outside dev --
 * where tsx resolves it lazily and forgivingly.
 *
 * So: bundle it exactly as Vercel would, load the bundle, and call it. If a
 * dependency only resolves in development, this is where it shows up.
 */

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
let checks = 0;

function check(label, ok, detail) {
  checks += 1;
  if (ok) process.stdout.write(`  ok   ${label}\n`);
  else {
    failures += 1;
    process.stdout.write(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}\n`);
  }
}

function section(name) {
  process.stdout.write(`\n${name}\n`);
}

// ── The client ───────────────────────────────────────────────────────────────
section("the client build exists");

const dist = resolve(root, "dist");
check("dist/ was produced", existsSync(dist), "run npm run build first");
check("with an index.html", existsSync(resolve(dist, "index.html")));

if (existsSync(resolve(dist, "assets"))) {
  const assets = readdirSync(resolve(dist, "assets"));
  check("and hashed assets", assets.some((f) => f.endsWith(".js")), assets.length);
  // The font is self-hosted, so the build has to carry it. A Google Fonts link
  // would break the "clone it and run it" criterion and leak a request.
  check("the font is bundled, not fetched from a CDN", assets.some((f) => f.includes("jetbrains-mono") && f.endsWith(".woff2")));
}

// ── The serverless function ──────────────────────────────────────────────────
section("the serverless function bundles and runs");

const outfile = resolve(root, "node_modules/.cache/fn-check.mjs");
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(root, "api/[[...route]].ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  external: ["node:*", "fsevents"],
  logLevel: "error",
});
check("the whole import graph resolves", true);

const mod = await import(`${outfile}?t=${Date.now()}`);
check("it exports the app", Boolean(mod.app));
check("with a fetch handler", typeof mod.app?.fetch === "function");
check("and a default export for the runtime", mod.default !== undefined);

if (typeof mod.app?.fetch === "function") {
  // Calling it proves the bundle actually runs, not merely parses. A missing
  // native module or a top-level throw in an import would only show up here.
  const health = await mod.app.request("/api/health");
  check("and it answers a request", health.status === 200, `status ${health.status}`);

  const body = await health.json().catch(() => null);
  check("with the namespace it is locked to", body?.namespace === "book", JSON.stringify(body?.namespace));
  check("and its config flags reported", typeof body?.config?.groq === "boolean");

  // A route that should not exist must not, or the catch-all has swallowed it.
  const missing = await mod.app.request("/api/definitely-not-a-route");
  check("an unknown route 404s rather than matching", missing.status === 404, `status ${missing.status}`);
}

process.stdout.write("\n");
if (failures > 0) {
  process.stdout.write(`${failures} of ${checks} checks FAILED\n`);
  process.exit(1);
}
process.stdout.write(`all ${checks} checks passed\n`);