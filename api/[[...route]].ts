/**
 * Serverless entry point — DIAGNOSTIC BUILD.
 *
 * This is a probe, not the app. It imports nothing from the codebase, so whatever
 * is breaking the real entry cannot break this one, and it reports what Vercel
 * actually uploaded.
 *
 * ── Why a probe and not more guessing ────────────────────────────────────────
 *
 * The deployment has failed three ways now, and each failure hid the next:
 *
 *   1. FUNCTION_INVOCATION_FAILED, no body. Cause: `api/_lib/` was `_`-prefixed,
 *      which stops Vercel routing those files as functions *and* stops it
 *      uploading them. Found by a wrapper that loaded the app lazily, which
 *      reported: Cannot find module '/var/task/api/_lib/app.ts'.
 *
 *   2. Moved the implementation to `server/`, outside anything Vercel scans.
 *      Switched to a static import. Still FUNCTION_INVOCATION_FAILED, no body —
 *      and a static import failure happens before any of my code runs, so the
 *      wrapper could not catch it. The diagnosis mechanism and the thing being
 *      diagnosed fought each other.
 *
 * So this asks the two questions that distinguish what is left:
 *
 *   - Are the `server/` files in the upload at all?
 *   - If they are, are they emitted as `.js` while the import says `.ts`?
 *
 * Both are answerable by listing the directory rather than by reasoning about
 * Vercel's compiler, which is what has been failing.
 *
 * DELETE THIS once the real entry works.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...walk(full, depth + 1));
    else out.push(full.replace("/var/task", ""));
  }
  return out;
}

export default {
  async fetch(): Promise<Response> {
    const files = walk("/var/task");
    const interesting = files.filter(
      (f) =>
        f.includes("server/") ||
        f.includes("api/") ||
        f.endsWith("package.json") ||
        f.includes("routes") ||
        f.includes("vc-config"),
    );

    let probe = "read ok";
    try {
      const spec = "../server/app.ts";
      await import(spec);
    } catch (error) {
      probe = `${(error as { code?: string }).code ?? "?"}: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`;
    }

    let probeNoExt = "read ok";
    try {
      await import("../server/app");
    } catch (error) {
      probeNoExt = `${(error as { code?: string }).code ?? "?"}: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`;
    }

    return new Response(
      JSON.stringify(
        {
          node: process.version,
          totalFiles: files.length,
          serverJsExists: files.some((f) => f.endsWith("server/app.js")),
          serverTsExists: files.some((f) => f.endsWith("server/app.ts")),
          importWithTsExt: probe,
          importWithoutExt: probeNoExt,
          files: interesting.slice(0, 40),
        },
        null,
        2,
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  },
};