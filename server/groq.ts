/**
 * Every call to Groq goes through here.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * The limits on this key are 1000 requests/minute and **8000 tokens/minute**, and
 * the second one is the one that matters. Measured, not assumed: one capture call
 * costs 1637 prompt tokens, which is 20.5% of the entire budget. One user message
 * makes two or three calls -- extraction, then the reply, then nudge phrasing --
 * so a handful of messages a minute is enough to be rate-limited by yourself.
 *
 * That is not a theoretical concern. It is what happened the first time this was
 * tested properly: six extractions in quick succession is 9,822 tokens against an
 * 8,000 budget, and five of them failed.
 *
 * ── What a 429 used to do ────────────────────────────────────────────────────
 * Nothing. `extractRaw` threw, `capture` caught it and returned "Extraction
 * failed", and the message was simply not remembered. A rate limit is a few
 * hundred milliseconds of queueing, and treating it as a permanent failure means
 * losing a memory over a condition that resolves itself before the user has
 * finished reading the reply.
 *
 * So it is retried, and the request is identical, because Groq bills per token
 * served and a retried request is a fresh one.
 */

const BASE = process.env.GROQ_URL || "https://api.groq.com/openai/v1/chat/completions";

/**
 * What the user reads when the model call fails for good. These messages reach
 * the chat verbatim, so they say what happened and what to do in plain language
 * -- never a status code, a model id, or a JSON fragment. The technical detail
 * stays in the server log, where it belongs.
 */
export function friendlyMessage(status: number, label: string | undefined, detail: string): string {
  const where = label ? ` while ${label === "extract" ? "figuring out what to remember" : label === "reply" ? "writing a reply" : label}` : "";
  if (status === 404 || /model_not_found|model_decommissioned|does not exist/i.test(detail)) {
    return `I could not reach the language model${where} -- it looks retired or renamed on the provider's side. Nothing was lost; try again in a bit, and tell whoever runs this app the model may need updating.`;
  }
  if (status === 429) {
    const wait = /try again in ([\dms.]+)/i.exec(detail)?.[1];
    return `Too many requests right now${where}${wait ? ` -- try again in about ${wait}` : ""}. Nothing was lost; your message is still here.`;
  }
  if (status === 401 || status === 403) {
    return `The app could not authenticate with its language model${where}. Tell whoever runs this app their key needs attention -- nothing you did caused this.`;
  }
  // Anything here may already be queued for retry alongside the next message
  // (client-owned pending list), so the message names that instead of asking
  // the user to repeat themselves for an outage.
  return `The language model did not answer${where}. Nothing was lost -- it will be retried automatically with your next message.`;
}

/**
 * How many times to try before giving up.
 *
 * Three, not four, and bounded by the deadline below. Four attempts with the
 * backoff below added up to 35 seconds inside a single chat turn -- a user
 * watching a typing indicator for half a minute and then getting "I'm listening."
 * Retrying less and admitting failure sooner is worth far more than the last
 * attempt.
 */
const MAX_ATTEMPTS = 3;

/**
 * Hard ceiling on the time one call may spend retrying, in ms.
 *
 * The backoff schedule alone permits ~20s of sleeping. Whatever the retry logic
 * intends, a chat turn must not exceed this -- past about six seconds the user
 * has concluded the page is broken, and one more attempt will not change their
 * mind.
 */
const RETRY_BUDGET_MS = 6_000;

/** First backoff. Doubles. */
const BASE_BACKOFF_MS = 400;

/** Ceiling on a single sleep, so a long streak does not become a hang. */
const MAX_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether it is worth trying again.
 *
 * 429 and 5xx are transient and are the ones that matter here. 400 is NOT
 * retried: a malformed request will be malformed every time, and retrying it
 * three times just burns the budget that the next user's message needs. The
 * 400s from the schema bug cost real minutes because they were retried at the
 * wrong layer.
 */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface GroqOptions {
  temperature?: number;
  /**
   * Which model to use, by role.
   *
   * Extraction and reply are not the same job. Extraction is narrow, structured
   * and consequential -- a missed memory or a wrong attribution is a real loss --
   * so it stays on the strongest model. The reply is two or three sentences of
   * conversation grounded in facts the extraction already committed to, and it
   * was the bulk of the wait: measured at 612ms for qwen3.8-27b against ~1s for
   * gpt-oss-20b, on the same account and the same rate limit.
   *
   * Per-role rather than one global GROQ_MODEL so the choice is explicit and can
   * be overridden in either direction from the environment.
   */
  role?: "extract" | "reply";
  maxTokens?: number;
  stream?: boolean;
  /** Function schema. Extraction uses it; the reply model does not. */
  tools?: unknown[];
  /** Forces one specific tool, which is how extraction gets structured output. */
  toolChoice?: unknown;
  /** Asks for a JSON object back. Used by nudge phrasing. */
  jsonObject?: boolean;
  /** Reported so two calls in one turn can be told apart in a log. */
  label?: string;
}

/**
 * Calls Groq, retrying only what is worth retrying.
 *
 * Resolves to the raw Response so callers keep their existing parsing. Throws with
 * the response body attached on a non-transient failure, because "Groq responded
 * 400" on its own says nothing about which part of the request was wrong.
 */
export async function groqFetch(
  messages: { role: string; content: string }[],
  options: GroqOptions = {},
): Promise<Response> {
  const body = JSON.stringify({
    model:
      options.role === "reply"
        ? process.env.GROQ_MODEL_REPLY || process.env.GROQ_MODEL || "openai/gpt-oss-120b"
        : process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    temperature: options.temperature ?? 0,
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    messages,
    ...(options.stream ? { stream: true } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
    ...(options.jsonObject ? { response_format: { type: "json_object" } } : {}),
  });

  let lastDetail = "";
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body,
    });

    if (response.ok) return response;

    const detail = await response.text().catch(() => "");
    lastDetail = detail;

    const outOfTime = Date.now() - startedAt >= RETRY_BUDGET_MS;
    if (!isTransient(response.status) || attempt === MAX_ATTEMPTS || outOfTime) {
      throw new Error(friendlyMessage(response.status, options.label, detail));
    }

    // Retry-After is the server telling us how long it wants. Preferred over our
    // own guess, because it is the only number here that comes from Groq.
    const wait = Number(response.headers.get("retry-after"));
    const backoff = Number.isFinite(wait) && wait > 0
      ? Math.min(wait * 1000, MAX_BACKOFF_MS)
      : Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);

    await sleep(backoff);
  }

  throw new Error(`Groq did not respond${options.label ? ` (${options.label})` : ""}${lastDetail ? `: ${lastDetail.slice(0, 300)}` : ""}`);
}