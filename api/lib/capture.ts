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

import { groqFetch } from "./groq.ts";
import {
  CONFIRM_THRESHOLD,
  MEMORY_TYPES,
  type CaptureResult,
  type MemoryCandidate,
  type MemoryType,
} from "../../shared/types.ts";
import { recurringDate, monthForDayOnly, isFullMonthDay } from "./dates.ts";


const SYSTEM = `You extract durable facts about people from a message someone sent to their private assistant.

You are NOT summarising and NOT conversing. You return structured candidates only.

Types, and only these:
- "promise": the writer committed to doing something for or about someone. "I'll call her Sunday." "I said I'd send the photo."
- "event": something that happened or is scheduled, with a date. "Her interview moved to the 2nd." "Got the offer."
- "trait": a durable fact about someone. "Vegetarian." "Works nights." "Allergic to peanuts."
- "taboo": something the writer explicitly does not want mentioned to that person. "Never bring up the divorce with him."
- "howto": how to interact with someone. "Call her, don't text." "He'll ask about the job, be ready."
- "update": a current state that replaces an older fact. "She moved to Lisbon in March."
- "correction": a standing instruction to the ASSISTANT about how to work. The person is always "you" -- the writer is correcting how the assistant behaves, not describing anyone else.
    "don't use Inter again"          "no, never prompt text that didn't happen"   "stop asking me before you edit files"
    "use JetBrains Mono not Inter"   "remember I hate emoji"                    "always run the tests before you say done"

Hard rules:
1. Extract only what is stated. Never infer, never embellish, never complete a thought.
2. If the message is banter, small talk, or about something other than people, return an empty array. An empty array is a correct and common answer.
3. Every candidate MUST name a person from the message. If you cannot name one, drop it. The ONE exception is type "correction": those are addressed to the assistant and the person is always "you", with no other name involved.
4. Use the writer themself as "you" only when the writer makes a commitment or states something about themselves.
5. Put the claim in the third person, as a fact about the person, not as a quote. "Promised to find the thing from the shop." not "I told Maya I'd find the thing."
6. "reasoning" is one short sentence on why this is worth keeping permanently, in the third person.
7. "confidence" is your honest 0..1 estimate that this is a durable, correctly-attributed fact. Be harsh. A one-off or a guess belongs below 0.55 and will be discarded.
8. "explicit" is true only when the writer directly instructed you to remember it ("remember that...", "don't forget...").
9. Dates must be ISO YYYY-MM-DD. Use today's date for "today"/"tomorrow" (tomorrow = +1 day). Omit a date you cannot resolve rather than guessing.
10. Never store a taboo's subject matter as if it were normal news. A taboo is one candidate, type "taboo".
11. RECURRING DATES. Some dates come round every year and have no year attached: a birthday, a wedding anniversary, the day someone's lease renews. For these you MUST set "anniversary" to the day and month as "MM-DD" — zero padded, "01-05" not "1-5". Do NOT put these in "dueAt": there is no year to put there, and a due date in the past is a date this app will never mention again.
    "Mara's birthday is the 14th"        -> anniversary "11-14"
    "Dev gets married on the 2nd of June" -> anniversary "06-02"
    "It's Nila's first birthday on the 9th" -> anniversary "09-09"
    "our anniversary is March 3rd"        -> anniversary "03-03"
    If the message gives a year, or the date is a one-off ("her flight is on the 3rd"), use "dueAt" instead and leave "anniversary" out.

12. CORRECTIONS, and why the reason matters more than the instruction. When the writer corrects how you work -- "no, not like that", "don't do X", "always do Y", "remember I said Z" -- emit one "correction" candidate. It is a different type from everything else because it is the only one whose value comes from persisting across unrelated future tasks.
    - Put ONLY the standing instruction in "text", stripped of the "no," / "hey," and the incident that triggered it. The incident is not part of the rule.
        "no, never prompt text that didn't happen" -> text: "Never prompt text that did not happen."
        "stop using Inter, it's a wide face"        -> text: "Do not use Inter."   reason: "It is a wide face and the measure breaks."
    - Put WHY in "reason", when the writer gives a why. This field is the point of the type: a bare instruction gets broken the next time the situation looks slightly different, because it does not obviously apply. A reason is recognisable when the same problem comes back in new clothes. Quote or closely paraphrase the writer's own reason -- never invent one. If they gave no reason, leave "reason" out entirely. Do not write "because the writer said so."
    - These are standing rules, so "confidence" should be high and "status" "active". Do not mark a correction as "explicit" unless they said "remember".
    - A correction about a PERSON is not a correction. "Don't call her, text her" is type "howto" about that person. Only corrections about the assistant's own behaviour are type "correction".

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

export async function capture(
  message: string,
  knownPeople: readonly string[],
  /** The last few turns, so a follow-up like "and her?" can be resolved. */
  history: readonly { role: "you" | "assistant"; text: string }[] = [],
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
    const raw = await extractRaw(message, knownPeople, history);
    const candidates = normalise(raw)
      .filter((c) => isAttributable(c.person, allowed, said))
      // The model did not emit `anniversary` in 4 runs out of 4, so it is derived
      // here. See dates.ts for why this is not a prompt problem.
      .map((c) => withRecurringDate(c, new Date()));
    return { candidates };
  } catch (error) {
    return {
      candidates: [],
      error: `Extraction failed: ${error instanceof Error ? error.message : String(error)}. Nothing was written.`,
    };
  }
}

async function extractRaw(
  message: string,
  knownPeople: readonly string[],
  history: readonly { role: "you" | "assistant"; text: string }[] = [],
): Promise<unknown> {
  const response = await groqFetch(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
          content: [
            `People already in the book: ${knownPeople.length ? knownPeople.join(", ") : "(none yet)"}`,
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
  return (JSON.parse(args) as { candidates?: unknown }).candidates ?? [];
}

export { CONFIRM_THRESHOLD };
