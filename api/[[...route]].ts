/**
 * The serverless entry point.
 *
 * ── Why this file is three lines of logic and a lot of comment ───────────────
 *
 * The previous deployment answered every /api request with
 *
 *   Error Code: FUNCTION_INVOCATION_FAILED
 *   Execution Duration: 190ms
 *
 * and no stack trace. A temporary wrapper that loaded the implementation lazily
 * turned that into the actual cause:
 *
 *   Cannot find module '/var/task/api/_lib/app.ts'
 *
 * Vercel omits `_`-prefixed files from the function upload. They are not turned
 * into routes -- which is what the underscore was for, keeping twelve library
 * files from becoming twelve serverless functions -- but they are not uploaded
 * either. So the function had no implementation at all.
 *
 * Hence `server/`. The implementation sits outside the directory Vercel scans for
 * routes, so nothing needs the underscore trick, nothing is dropped from the
 * bundle, and `api/` contains exactly one file: this entry point.
 *
 * That leaves exactly one function, which is the point of the whole arrangement.
 *
 * The request-level try/catch stays. It is not what found this bug, but it turns
 * the next class of failure -- something thrown that Hono does not handle -- into
 * a body that names the error instead of a platform code that names nothing.
 */

import { app } from "../server/app.ts";

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
