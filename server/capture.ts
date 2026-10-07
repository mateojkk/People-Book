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

import { groqFetch } from "./groq.js";
import {
  CONFIRM_THRESHOLD,
  MEMORY_TYPES,
  type CaptureResult,
  type MemoryCandidate,
  type MemoryType,
} from "../shared/types.js";
import { recurringDate, monthForDayOnly, isFullMonthDay } from "./dates.js";


const SYSTEM = `Extract durable facts from a message sent to someone's private assistant. Structured candidates only -- not a summary, not a reply.

Types, and only these:
- "promise": they committed to doing something. "I'll call her Sunday."
- "event": something that happened or is scheduled. "Her interview moved to the 2nd."
- "trait": a durable fact about someone. "Vegetarian." "Works nights."
- "taboo": never mention this to that person. "Never bring up the divorce with him."
- "howto": how to interact with someone. "Call her, don't text."
- "update": a current state replacing an older fact. "She moved to Lisbon in March."
- "correction": a standing instruction to the ASSISTANT about how to work. Person is always "you".
    "don't use Inter again"  "never prompt text that didn't happen"  "always run the tests first"  "remember I hate emoji"

Rules:
1. Only what is stated. Never infer or embellish.
2. Banter, small talk, or nothing durable -> empty array. Empty is a correct and common answer.
3. Name a person from the message or drop it. Sole exception: "correction", which is addressed to the assistant and uses "you".
4. Third person, as a fact. "Promised to find the thing." not "I told Maya I'd find the thing."
5. "confidence" is your honest 0..1 chance this is durable and correctly attributed. Be harsh; below 0.55 is discarded.
6. "save it", "remember that/this", "don't forget", "keep/write that down" are
   orders to file: extract what "it" points at from history with "explicit" true.
   No referent in history -> empty, never the instruction itself.
7. Dates are ISO YYYY-MM-DD. "today" is ${new Date().toISOString().slice(0, 10)}, "tomorrow" is +1 day. Omit what you cannot resolve.
8. A taboo is one candidate. Never also store its subject as news.
9. Recurring dates (birthdays etc.) go in "anniversary" as "MM-DD", never "dueAt" (a past due date is never mentioned again). One-offs ("flight on the 3rd") go in "dueAt".
10. CORRECTIONS: one "correction" per standing instruction. "text" holds ONLY the rule ("Do not use Inter."), never the incident; the reason goes in "reason".
    - "remember <something>" about how to work is a correction, not a trait. Dropping this example from the list made "remember I hate emoji" come back as a trait, which is the one regression the trim caused.
    - "reason" holds WHY, in their own words, when given. This is the point of the type: a bare instruction gets broken the first time it looks inapplicable, a reason is recognisable when the same problem returns. Never invent one -- omit it if none was given.
    - High "confidence", status "active".
    - An instruction about a PERSON is not a correction: "don't call her, text her" is "howto" about her.

Today is ${new Date().toISOString().slice(0, 10)}.`;

interface RawCandidate {
  person?: unknown;
  type?: unknown;
  status?: unknown;
  text?: unknown;
  occurredAt?: unknown;
  dueAt?: unknown;
  /** The writer's own reason for a correction. Never invented. */
  reason?: unknown;
  reasoning?: unknown;
  confidence?: unknown;
  explicit?: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Whether a memory may be attributed to this person.
 *
 * Exported and tested on its own because it is the guard that stopped two real
 * bugs -- dropping every first mention of anyone, then letting the pronoun "she"
 * through because "she" really is in the sentence. Asserting it through the live
 * model made the suite fail whenever Groq returned nothing, which is a coin toss
 * we do not control; the rule itself is deterministic and is what matters.
 */
export function isAttributable(person: string, allowed: ReadonlySet<string>, said: string): boolean {
  const name = person.toLowerCase().trim();
  // The user is always a valid subject -- every message is addressed to them. Not
  // left to the caller to remember, because forgetting it silently drops every
  // memory the user states about themselves.
  if (name === "you") return true;
  // A pronoun is not a person. Observed from the live model on "and she's
  // allergic to shellfish", which it filed under a person called "she" -- and the
  // name-in-the-message rule would wave that through, because "she" is in the
  // message. That writes a memory attributed to a non-person.
  if (PRONOUNS.has(name)) return false;
  return allowed.has(name) || said.includes(name);
}

/**
 * Words that can stand in for a person but are not one.
 *
 * "you" is deliberately absent: the user is a real subject in this book, and every
 * message is addressed to them.
 */
const PRONOUNS: ReadonlySet<string> = new Set([
  "she", "he", "they", "it", "we", "i", "me", "my", "mine", "myself",
  "her", "hers", "herself", "him", "his", "himself", "theirs", "them",
  "their", "themselves", "itself", "our", "ours", "ourselves", "your", "yours",
  "yourself", "this", "that", "there", "someone", "somebody", "anyone",
]);

/**
 * The types the model is allowed to return.
 *
 * Was a second hand-written list of the same six values, which drifted: adding
 * "correction" to MEMORY_TYPES left this behind, the tool schema rejected every
 * correction the model correctly produced, and the whole feature failed as a 400
 * with no visible cause. There is a test now that fails if these two ever diverge
 * again, and there is no reason to write the list twice.
 */
const VALID_TYPES: readonly MemoryType[] = MEMORY_TYPES;

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

    // Strictly MM-DD, and a day that really exists in that month. Anything else is
    // dropped rather than handed to the ranker, which would be holding a date it
    // cannot compute an occurrence from.
    const raw = asString((item as { anniversary?: unknown }).anniversary);
    const anniversary = /^(\d{2})-(\d{2})$/.exec(raw ?? "") ? raw : undefined;

    out.push({
      person,
      type,
      // A promise is open unless the model says otherwise; other types are
      // standing facts. The model is not trusted to set lifecycle state.
      status: type === "promise" ? (item?.status === "kept" ? "kept" : "open") : "active",
      text,
      ...(asString(item.occurredAt) ? { occurredAt: asString(item.occurredAt) } : {}),
      ...(asString(item.dueAt) ? { dueAt: asString(item.dueAt) } : {}),
      // A recurring date has to survive as MM-DD. A birthday used to arrive as a
      // trait with no date at all, which is a thing you remember and can never be
      // reminded about.
      ...(anniversary ? { anniversary } : {}),
      // The writer's own reason, verbatim-ish, and only for corrections. Carried
      // as given: an absent reason stays absent rather than being filled in with
      // something plausible, because a plausible invented reason is worse than
      // none -- it would be a fabricated justification for a real instruction.
      ...(type === "correction" && asString(item.reason) ? { reason: asString(item.reason) } : {}),
      reasoning: reasoning ?? "",
      confidence,
      explicit: item?.explicit === true,
      // Passed through as a string, verified later. takeTurn only honours it when
      // it names a real open promise; anything else is ignored and the candidate
      // is filed as new. The model suggests, the ledger decides.
      ...(asString((item as { fulfillsPromiseId?: unknown }).fulfillsPromiseId)
        ? { fulfillsPromiseId: asString((item as { fulfillsPromiseId?: unknown }).fulfillsPromiseId) }
        : {}),
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
/**
 * Fills in the recurring date, if the model left it out.
 *
 * Kept to the candidate's own text, so it can only ever recover something the
 * message actually said. An existing value is never overwritten -- if the model
 * does get it right on a future run, its answer wins.
 */
function withRecurringDate(candidate: MemoryCandidate, now: Date): MemoryCandidate {
  if (candidate.anniversary) return candidate;

  const found = recurringDate(candidate.text);
  if (!found) return candidate;

  const resolved = isFullMonthDay(found) ? found : monthForDayOnly(found, now);
  if (!resolved) return candidate;

  return { ...candidate, anniversary: resolved };
}

export interface OpenPromise {
  id: string;
  person: string;
  text: string;
}

export async function capture(
  message: string,
  knownPeople: readonly string[],
  /** The last few turns, so a follow-up like "and her?" can be resolved. */
  history: readonly { role: "you" | "assistant"; text: string }[] = [],
  /** Promises still open, so reporting one done can close it instead of filing twice. */
  openPromises: readonly OpenPromise[] = [],
): Promise<CaptureResult> {
  if (!process.env.GROQ_API_KEY) {
    return { candidates: [], error: "GROQ_API_KEY is not set, so nothing was extracted. Nothing was written." };
  }

  // Who is allowed to end up with a memory.
  //
  // This used to be "someone already in the book, or you". That reads like a
  // safety check but it forbids the most important case in the product: the first
  // time a person is mentioned. With an empty ledger the allowed set was just
  // {"you"}, so every candidate about anyone new was discarded, and People Book
  // could only ever learn people it already knew. It failed silently, which is why
  // a manual add form was masking it.
  //
  // The rule the model is actually given is the right one, so it is enforced here
  // instead: the person must be someone already in the book, or someone the user
  // just named. That still blocks an invented person, and lets a new one in.
  const allowed = new Set<string>([...knownPeople.map((p) => p.toLowerCase()), "you"]);

  // Who the user has "named" is now the whole thread, not just the latest message.
  // This matters more than it looks: in a real conversation almost nobody repeats
  // a name. "her birthday too" and "what about Dev?" are the normal case, and a
  // filter scoped to the current message would throw away exactly the follow-ups a
  // chatbot exists to handle -- the model would resolve the pronoun correctly and
  // the guard would then delete its answer.
  const said = [message, ...history.map((h) => h.text)].join("\n").toLowerCase();

  try {
    const raw = await extractRaw(message, knownPeople, history, openPromises);
    const candidates = normalise(raw)
      .filter((c) => isAttributable(c.person, allowed, said))
      // The model did not emit `anniversary` in 4 runs out of 4, so it is derived
      // here. See dates.ts for why this is not a prompt problem.
      .map((c) => withRecurringDate(c, new Date()));
    return { candidates };
  } catch (error) {
    // Raw exception text here would be JSON positions and token errors. The
    // turn survives regardless (reply continues on existing memories); what the
    // user needs is whether to act, and the answer is no -- the message joins
    // the automatic retry backlog.
    return {
      candidates: [],
      error: `Missed that one -- it will be retried automatically with your next message.`,
    };
  }
}

/**
 * Repairs the two mechanical JSON failures locally, without a second model call.
 *
 * Returns undefined when there is nothing salvageable, in which case the caller
 * falls through to asking the model to fix it. Deliberately narrow: it handles
 * truncation (cut off mid-stream, close what is open) and trailing commas, and
 * nothing else. Anything cleverer risks "fixing" a response into a different
 * meaning, which for a memory pipeline is worse than failing loudly.
 */
export function salvageJson(broken: string): string | undefined {
  // Trailing commas before } or ]: legal in no JSON dialect, emitted often.
  const decomma = broken.replace(/,(\s*[}\]])/g, "$1");
  try {
    JSON.parse(decomma);
    return decomma;
  } catch {
    // Truncation: walk the string tracking open brackets/braces (respecting
    // string boundaries and escapes), then close whatever is still open.
    // First pass: is it merely unclosed (not cut inside a string)? Track
    // string state to the end; a cutoff inside a value is unrecoverable locally.
    let inString = false;
    let escaped = false;
    for (const ch of decomma) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
    }
    // Unclosed and not inside a string: close every open bracket in reverse
    // order. This recovers truncation mid-array or mid-object, which is the
    // common cutoff shape. It cannot recover a cut inside a string value itself
    // (half a fact is not a fact) -- that correctly stays undefined and falls
    // through to the model repair.
    if (!inString) {
      const stack: string[] = [];
      let s2InString = false;
      let s2Escaped = false;
      for (const ch of decomma) {
        if (s2Escaped) {
          s2Escaped = false;
          continue;
        }
        if (ch === "\\") {
          s2Escaped = true;
          continue;
        }
        if (ch === '"') {
          s2InString = !s2InString;
          continue;
        }
        if (s2InString) continue;
        if (ch === "{" || ch === "[") stack.push(ch);
        else if (ch === "}" || ch === "]") stack.pop();
      }
      const closers = stack
        .reverse()
        .map((o) => (o === "{" ? "}" : "]"))
        .join("");
      // Bound the guess: more than three unclosed levels means structure was
      // lost, not just closers, and closing it would invent candidates.
      if (closers.length > 0 && closers.length <= 3) {
        try {
          const attempt = decomma + closers;
          JSON.parse(attempt);
          return attempt;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }
}

async function extractRaw(
  message: string,
  knownPeople: readonly string[],
  history: readonly { role: "you" | "assistant"; text: string }[] = [],
  openPromises: readonly OpenPromise[] = [],
): Promise<unknown> {
  const response = await groqFetch(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
          content: [
            `People already in the book: ${knownPeople.length ? knownPeople.join(", ") : "(none yet)"}`,
            openPromises.length
              ? `Open promises (said they would do, not yet reported done):\n${openPromises
                  .map((p) => `- [${p.id}] ${p.person}: ${p.text}`)
                  .join("\n")}\nMessage reports completing one: fulfillsPromiseId=[id], status "kept". Other ids ignored. New thing: unset.`
              : "",
            // Enough of the thread for a pronoun to resolve, and no more: this is
            // extraction, and a long transcript mostly adds text to mis-attribute.
            history.length
              ? `\nConversation so far:\n${history
                  .slice(-6)
                  .map((h) => `${h.role === "you" ? "Them" : "Assistant"}: ${h.text}`)
                  .join("\n")}`
              : "",
            `\nTheir latest message:\n${message}`,
          ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    {
      temperature: 0,
      label: "capture",
      role: "extract",
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
                      fulfillsPromiseId: { type: "string", description: "Open-promise [id] this completes, else unset." },
                      text: { type: "string", description: "The fact, third person, self-contained." },
                      occurredAt: { type: "string", description: "ISO date it happened, if known." },
                      dueAt: { type: "string", description: "ISO date it becomes due, if known." },
                      anniversary: {
                        type: "string",
                        description:
                          "For a date that recurs every year, as MM-DD: a birthday, wedding anniversary, or the like. Use this INSTEAD of dueAt for those, because they have no year. Leave empty for anything that happens once.",
                      },
                      // Declared here because the system prompt asks for it. A
                      // tool-call schema the prompt contradicts is a 400 from
                      // Groq, so a missing field here does not degrade the
                      // feature -- it breaks it, silently, as a failed request.
                      // Not in `required`: no reason given is a valid outcome and
                      // must stay absent rather than be invented.
                      reason: {
                        // Accepts null as well as string, and that is not
                        // leniency. Asked to leave a field empty, this model
                        // returns null rather than omitting it or sending "",
                        // and a plain `type: "string"` turns that into a 400 and
                        // loses the whole extraction. asString() already maps
                        // null and "" to undefined, so no reason stays absent.
                        type: ["string", "null"],
                        description:
                          "Corrections only: the writer's OWN reason for the instruction, quoted or closely paraphrased. Use null if they gave no reason. Never invent one.",
                      },
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
      toolChoice: { type: "function", function: { name: "record_candidates" } },
    },
  );

  const payload = (await response.json()) as {
    choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
  };
  const args = payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) return [];
  try {
    return (JSON.parse(args) as { candidates?: unknown }).candidates ?? [];
  } catch {
    const salvaged = salvageJson(args);
    if (salvaged) {
      try {
        return (JSON.parse(salvaged) as { candidates?: unknown }).candidates ?? [];
      } catch {
        // Falls through to the model repair below.
      }
    }
    // The smaller model fumbles tool JSON that the larger one handled: truncated
    // output, unescaped quotes from the user's own words, trailing commas. One
    // repair attempt with the broken output shown back -- this recovers the
    // common cases (cutoff, escaping) and costs one call only when needed, never
    // on the happy path.
    const fix = await groqFetch(
      [
        {
          role: "user",
          content: `Your previous tool call arguments were not valid JSON. Return the SAME candidates as corrected JSON only, no other text:\n${args.slice(0, 4000)}`,
        },
      ],
      { temperature: 0, label: "capture-repair", role: "extract" },
    );
    const fixed = (await fix.json()) as { choices?: { message?: { content?: string } }[] };
    const text = fixed.choices?.[0]?.message?.content ?? "";
    return (JSON.parse(text) as { candidates?: unknown }).candidates ?? [];
  }
}

export { CONFIRM_THRESHOLD };
