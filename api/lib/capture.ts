/**
 * Capture: turning something the user said into candidate memories.
 *
 * ── The rule this file exists to enforce ────────────────────────────────────
 * The model EXTRACTS. It never decides that something is true, and nothing it
 * produces becomes a memory without a person acting on it.
 *
 *   model output  →  candidate  →  user confirms  →  `confirmed`  →  can nudge
 *                                 └─ left alone ──→  `inferred`   →  never nudes
 *
 * So the worst case of a bad extraction is an extra card in the ledger that the
 * user can delete, not a false claim about their sister. That is the whole
 * difference between a memory system people trust and one they quietly stop
 * using.
 *
 * If Groq is unavailable the function returns an error rather than falling back
 * to a regex guess. A degraded capture path that silently writes worse memories
 * is worse than no capture, because the user cannot tell which happened.
 */

import { CONFIRM_THRESHOLD, type CaptureResult, type MemoryCandidate, type MemoryType } from "../../shared/types.ts";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const SYSTEM = `You extract durable facts about people from a message someone sent to their private assistant.

You are NOT summarising and NOT conversing. You return structured candidates only.

Types, and only these:
- "promise": the writer committed to doing something for or about someone. "I'll call her Sunday." "I said I'd send the photo."
- "event": something that happened or is scheduled, with a date. "Her interview moved to the 2nd." "Got the offer."
- "trait": a durable fact about someone. "Vegetarian." "Works nights." "Allergic to peanuts."
- "taboo": something the writer explicitly does not want mentioned to that person. "Never bring up the divorce with him."
- "howto": how to interact with someone. "Call her, don't text." "He'll ask about the job, be ready."
- "update": a current state that replaces an older fact. "She moved to Lisbon in March."

Hard rules:
1. Extract only what is stated. Never infer, never embellish, never complete a thought.
2. If the message is banter, small talk, or about something other than people, return an empty array. An empty array is a correct and common answer.
3. Every candidate MUST name a person from the message. If you cannot name one, drop it.
4. Use the writer themself as "you" only when the writer makes a commitment or states something about themselves.
5. Put the claim in the third person, as a fact about the person, not as a quote. "Promised to find the thing from the shop." not "I told Maya I'd find the thing."
6. "reasoning" is one short sentence on why this is worth keeping permanently, in the third person.
7. "confidence" is your honest 0..1 estimate that this is a durable, correctly-attributed fact. Be harsh. A one-off or a guess belongs below 0.55 and will be discarded.
8. "explicit" is true only when the writer directly instructed you to remember it ("remember that...", "don't forget...").
9. Dates must be ISO YYYY-MM-DD. Use today's date for "today"/"tomorrow" (tomorrow = +1 day). Omit a date you cannot resolve rather than guessing.
10. Never store a taboo's subject matter as if it were normal news. A taboo is one candidate, type "taboo".

Today is ${new Date().toISOString().slice(0, 10)}.`;

interface RawCandidate {
  person?: unknown;
  type?: unknown;
  status?: unknown;
  text?: unknown;
  occurredAt?: unknown;
  dueAt?: unknown;
  reasoning?: unknown;
  confidence?: unknown;
  explicit?: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const VALID_TYPES: readonly MemoryType[] = ["trait", "event", "promise", "taboo", "howto", "update"];

/**
 * Turns whatever the model returned into candidates we are willing to show.
 *
 * Every field is validated and the whole candidate dropped on any violation,
 * rather than repaired. A half-understood candidate that reaches a confirm
 * screen is a candidate someone will confirm without reading carefully, which is
 * the exact failure this design is trying to prevent.
 */
function normalise(raw: unknown): MemoryCandidate[] {
  if (!Array.isArray(raw)) return [];

  const out: MemoryCandidate[] = [];
  for (const item of raw as RawCandidate[]) {
    const person = asString(item?.person);
    const text = asString(item?.text);
    const type = VALID_TYPES.includes(item?.type as MemoryType) ? (item!.type as MemoryType) : undefined;
    const reasoning = asString(item?.reasoning);
    if (!person || !text || !type) continue;

    const confidence = typeof item?.confidence === "number" && Number.isFinite(item.confidence)
      ? Math.min(1, Math.max(0, item.confidence))
      : 0;

    out.push({
      person,
      type,
      // A promise is open unless the model says otherwise; other types are
      // standing facts. The model is not trusted to set lifecycle state.
      status: type === "promise" ? (item?.status === "kept" ? "kept" : "open") : "active",
      text,
      ...(asString(item.occurredAt) ? { occurredAt: asString(item.occurredAt) } : {}),
      ...(asString(item.dueAt) ? { dueAt: asString(item.dueAt) } : {}),
      reasoning: reasoning ?? "",
      confidence,
      explicit: item?.explicit === true,
    });
  }
  return out;
}

/**
 * Extracts candidates from a message.
 *
 * `knownPeople` is passed in so the model can only attribute to people already in
 * the book, plus "you". This is the quarantine rule: a hallucinated name cannot
 * reach the confirm screen, so a model that invents "Daniel" produces nothing
 * rather than a person who does not exist.
 */
export async function capture(
  message: string,
  knownPeople: readonly string[],
): Promise<CaptureResult> {
  if (!process.env.GROQ_API_KEY) {
    return { candidates: [], error: "GROQ_API_KEY is not set, so nothing was extracted. Nothing was written." };
  }

  const allowed = new Set<string>([...knownPeople.map((p) => p.toLowerCase()), "you"]);

  try {
    const raw = await extractRaw(message, knownPeople);
    const candidates = normalise(raw).filter((c) => allowed.has(c.person.toLowerCase()));
    return { candidates };
  } catch (error) {
    return {
      candidates: [],
      error: `Extraction failed: ${error instanceof Error ? error.message : String(error)}. Nothing was written.`,
    };
  }
}

async function extractRaw(message: string, knownPeople: readonly string[]): Promise<unknown> {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `People already in the book: ${knownPeople.length ? knownPeople.join(", ") : "(none yet)"}\n\nMessage:\n${message}`,
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "record_candidates",
            description: "Return the durable facts worth remembering from this message. An empty array is a valid and common result.",
            parameters: {
              type: "object",
              properties: {
                candidates: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      person: { type: "string", description: "Who the fact is about. Must be one of the people named in the message, or 'you'." },
                      type: { type: "string", enum: [...VALID_TYPES] },
                      status: { type: "string", enum: ["open", "kept", "active"] },
                      text: { type: "string", description: "The fact, third person, self-contained." },
                      occurredAt: { type: "string", description: "ISO date it happened, if known." },
                      dueAt: { type: "string", description: "ISO date it becomes due, if known." },
                      reasoning: { type: "string", description: "One sentence: why this is worth keeping." },
                      confidence: { type: "number", minimum: 0, maximum: 1 },
                      explicit: { type: "boolean" },
                    },
                    required: ["person", "type", "text", "reasoning", "confidence"],
                  },
                },
              },
              required: ["candidates"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "record_candidates" } },
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq responded ${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
  };
  const args = payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) return [];
  return (JSON.parse(args) as { candidates?: unknown }).candidates ?? [];
}

/**
 * Phrases a set of memories as a short, natural opening.
 *
 * Optional by design. Ranking in ranking.ts already produces a usable sentence
 * for every nudge without a model, so if Groq is down the product still works.
 * Losing the prose is a downgrade; losing the memory would be a failure.
 */
export async function phraseNudges(
  items: { person: string; text: string; kind: string }[],
): Promise<string[]> {
  if (!process.env.GROQ_API_KEY || items.length === 0) return items.map((i) => i.text);

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "Rewrite each reminder as one warm, plain sentence, max 18 words. Never invent, add, or infer any fact that is not in the reminder. Never add a date or name that is not present. No preamble, no quotes. Return a JSON array of strings, same length and order as the input.",
          },
          { role: "user", content: JSON.stringify(items) },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) return items.map((i) => i.text);

    const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return items.map((i) => i.text);

    const parsed = JSON.parse(content) as { sentences?: string[] };
    const sentences = parsed.sentences;
    if (!Array.isArray(sentences) || sentences.length !== items.length) {
      // Length mismatch means the model returned something we cannot align with
      // the source facts, so we keep the deterministic phrasing instead.
      return items.map((i) => i.text);
    }
    return sentences.map((s, idx) => (typeof s === "string" && s.trim() ? s.trim() : items[idx]!.text));
  } catch {
    return items.map((i) => i.text);
  }
}

export { CONFIRM_THRESHOLD };
