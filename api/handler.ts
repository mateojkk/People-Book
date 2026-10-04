/**
 * The serverless entry point.
 *
 * ── Why the imports below end in .js and not .ts ─────────────────────────────
 *
 * An earlier deployment returned
 *
 *   Error Code: FUNCTION_INVOCATION_FAILED
 *
 * for every request, with no stack trace. A probe that imported nothing from the
 * codebase found the cause:
 *
 *   serverJsExists:  true
 *   serverTsExists:  false
 *   importWithTsExt: ERR_MODULE_NOT_FOUND '/var/task/server/app.ts'
 *   importWithoutExt: ERR_MODULE_NOT_FOUND '/var/task/server/app'
 *
 * Vercel transpiles each TypeScript file to `.js` and traces it into /var/task --
 * but it does **not** rewrite the specifiers inside the emitted JavaScript. So
 * `import "../server/app.ts"` survives compilation verbatim and then fails at
 * runtime, because no `.ts` file exists in the bundle. Both `.ts` and
 * extensionless fail; only `.js` resolves.
 *
 * Hence the NodeNext convention throughout this repo: relative imports name the
 * `.js` that the compiler will emit, and TypeScript maps it back to the `.ts`
 * source. `allowImportingTsExtensions` is off in tsconfig.json on purpose --
 * leaving it on is what allowed the `.ts` form back in, and that form is exactly
 * what the deployed function could not resolve.
 *
 * This was invisible locally for a long time. tsx, tsc and Vite all resolve both
 * forms happily, and the local dev server has no bundling step at all, so every
 * local check passed against an import style the deployment cannot honour.
 *
 * ── Why the implementation lives in server/ ───────────────────────────────────
 *
 * api/ must contain only this file. Vercel turns every file under /api into a
 * function, and it drops files whose names begin with `_` from the upload
 * entirely -- so the library files cannot live here, underscore-prefixed or not.
 * server/ is outside the directory Vercel scans, which leaves exactly one
 * function and keeps the implementation in the bundle.
 */

import { app } from "../server/app.js";

/**
 * Turns a throw that Hono did not handle into a body that names it.
 *
 * This did not find the bug above -- a failure at module load happens before any
 * of this file runs, which is why the platform reported nothing. It is kept
 * because the next class of failure, an escaped throw at request time, should be
 * readable rather than a bare platform code.
 */
function report(error: unknown): Response {
  const err = error instanceof Error ? error : new Error(String(error));
  return new Response(
    JSON.stringify({
      error: "request_failed",
      message: err.message || "(no message)",
      name: err.name,
      stack: (err.stack ?? "").split("\n").slice(0, 12).join("\n"),
      node: process.version,
    }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await app.fetch(request);
    } catch (error) {
      return report(error);
    }
  },
};