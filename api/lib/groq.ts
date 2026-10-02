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

const BASE = "https://api.groq.com/openai/v1/chat/completions";

/** How many times to try before giving up. */
const MAX_ATTEMPTS = 4;

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
    model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    temperature: options.temperature ?? 0,
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    messages,
    ...(options.stream ? { stream: true } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
    ...(options.jsonObject ? { response_format: { type: "json_object" } } : {}),
  });

  let lastDetail = "";

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

    if (!isTransient(response.status) || attempt === MAX_ATTEMPTS) {
      throw new Error(
        `Groq responded ${response.status}${options.label ? ` (${options.label})` : ""}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
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