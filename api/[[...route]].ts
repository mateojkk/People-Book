/**
 * The serverless entry point.
 *
 * Deliberately thin, and deliberately not where the app lives. The implementation
 * is in ./\_lib/app.ts; this file's whole job is to load it in a way that fails
 * *informatively*.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 *
 * On Vercel this deployment answered every /api request with
 *
 *   Error Code: FUNCTION_INVOCATION_FAILED
 *   Execution Duration: 190ms
 *
 * and no stack trace. That is the least diagnosable failure a serverless platform
 * offers: it means the function threw somewhere Vercel considers its own problem,
 * and the log said nothing about what. Every local reproduction passed —
 *
 *   tsx, invoking app.fetch directly        200
 *   esbuild --bundle --format=esm           200
 *   esbuild --bundle --format=cjs           builds
 *   with only SESSION_SECRET + GROQ_API_KEY  200
 *   every relative import resolving         yes
 *   every runtime dep in `dependencies`     yes
 *
 * so the fault was environment-specific and invisible from outside. Rather than
 * keep guessing, this makes the platform report the error instead.
 *
 * Two properties this has to keep:
 *
 * 1. **No top-level await.** It loads lazily inside fetch(), so this compiles under
 *    both module formats. A top-level await here would be exactly the kind of thing
 *    that turns one opaque failure into another.
 *
 * 2. **Never throw out of the handler.** A module-load failure becomes a 500 whose
 *    body is the message and stack. A crash during a request becomes the same. So
 *    the failure mode is always "the app tells you what is wrong" rather than
 *    "Vercel tells you nothing".
 *
 * If you ever see {"error":"module_load_failed"} from a deployment, the body names
 * the import or the module-scope throw that caused it — which is the one piece of
 * information FUNCTION_INVOCATION_FAILED withheld.
 */

// `_lib` is underscore-prefixed, so Vercel does not turn these into routes of their
// own. That is also why the implementation can live there.
import type { Hono } from "hono";

type Handler = { fetch: (request: Request) => Promise<Response> };

let cached: Handler | null = null;
let loading: Promise<Handler> | null = null;

async function load(): Promise<Handler> {
  if (cached) return cached;
  // Memoised across concurrent cold starts. Without this, two simultaneous requests
  // would each import the graph, and a slow module would make both wait twice.
  loading ??= import("./_lib/app.ts").then((mod) => {
    const app = (mod.default ?? mod.app) as unknown;
    if (!app || typeof (app as { fetch?: unknown }).fetch !== "function") {
      throw new Error(
        `The app module loaded but exported no fetch handler (got ${typeof app}, keys: ${
          app && typeof app === "object" ? Object.keys(app).join(",") : "n/a"
        }).`,
      );
    }
    cached = app as Handler;
    return cached;
  });
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

function report(stage: "module_load_failed" | "request_failed", error: unknown): Response {
  const err = error instanceof Error ? error : new Error(String(error));
  return new Response(
    JSON.stringify({
      error: stage,
      message: err.message || "(no message)",
      name: err.name,
      // Truncated: a stack can be enormous and this body is read in a browser.
      stack: (err.stack ?? "").split("\n").slice(0, 12).join("\n"),
      node: process.version,
      env: {
        hasSessionSecret: Boolean(process.env.SESSION_SECRET),
        hasGroqKey: Boolean(process.env.GROQ_API_KEY),
        hasDelegateKey: Boolean(process.env.MEMWAL_DELEGATE_KEY),
        hasRegistryId: Boolean(process.env.MEMWAL_REGISTRY_ID),
        hasSuiRpc: Boolean(process.env.SUI_RPC_URL),
      },
    }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    let handler: Handler;
    try {
      handler = await load();
    } catch (error) {
      return report("module_load_failed", error);
    }
    try {
      return await handler.fetch(request);
    } catch (error) {
      // Hono handles its own errors, so reaching here means something escaped it —
      // most likely a throw during module scope of something it lazily required.
      return report("request_failed", error);
    }
  },
} satisfies { fetch: Hono["fetch"] };