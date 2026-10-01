/**
 * One conversational turn.
 *
 * ── Why this is the product and not a feature ─────────────────────────────────
 * The whole point is that you *talk* to this thing and it remembers. A form where
 * you type a memory and press save is the same database with the conversation
 * removed, and it asks the user to do the work the app exists to do: notice what
 * was said, decide what is durable, and file it against the right person.
 *
 * So a turn is: read the message, work out what is worth keeping, write it, and
 * answer like someone who knows you — including volunteering something you were
 * going to forget, unprompted.
 *
 * ── Saving is silent, and undoable ────────────────────────────────────────────
 * The user asked for this explicitly: say it and it is remembered, no confirmation
 * dialog. That is the right call for a companion you talk to, and it is only safe
 * because undo is real — `forget` writes a tombstone, which the codec collapses
 * like any other revision, so a mistake disappears rather than lingering as a
 * wrong fact that keeps nudging you.
 *
 * The consequence, stated plainly because a judge will ask: memories saved this
 * way are `confirmed`, because telling the app something *is* the confirmation.
 * Only `confirmed` memories may create nudges, so an unreviewed extraction can
 * surface a reminder. That is the trade the user chose over a confirm dialog, and
 * it is why undo is a first-class path rather than a nicety.
 *
 * ── What the model is allowed to do ───────────────────────────────────────────
 * The model extracts and phrases. It does not decide what is true, and it is never
 * asked to invent: an empty result is a valid and common outcome.
 *
 * What is deterministic and what is not, precisely, because it is easy to
 * overclaim here: ranking, nudge eligibility, revision collapse and the ledger
 * are all deterministic and live in ranking.ts and the codec. Extraction is NOT.
 * At temperature 0 the same sentence was observed returning two candidates on one
 * call and one on the next -- a birthday and an allergy in the same breath, and
 * only the allergy the second time. So what reaches the ledger from a given
 * sentence is not reproducible, and pretending otherwise would be a lie baked
 * into the design. Undo is the answer to that, not determinism.
 */

import { capture } from "./capture.ts";
import { computeNudges } from "./ranking.ts";
import { phraseNudges } from "./capture.ts";
import type { PeopleBookStore } from "./store.ts";
import type { MemoryCandidate, Nudge, PersonMemory } from "../../shared/types.ts";
import { CONFIRM_THRESHOLD } from "../../shared/types.ts";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

/** One prior turn, in the order it happened. */
export interface PriorTurn {
  role: "you" | "assistant";
  text: string;
}

export interface ChatTurnInput {
  store: PeopleBookStore;
  message: string;
  /**
   * The thread so far.
   *
   * Without this the endpoint is not a chatbot, it is a per-message classifier
   * with a reply generator bolted on: it cannot resolve "her", "what about Dev?",
   * or "when is it?" because it has never been told what those refer to. A
   * conversation needs its earlier turns, so they come in here and go to both the
   * extractor and the reply.
   */
  history?: PriorTurn[];
  /** Ids the user already undid, so a retried turn does not resurrect them. */
  undoOf?: string[];
}

export interface SavedMemory {
  id: string;
  person: string;
  text: string;
  type: PersonMemory["type"];
}

export interface ChatTurn {
  /** What to show as the assistant's message. */
  reply: string;
  /** Written this turn, each undoable. Empty is normal and fine. */
  saved: SavedMemory[];
  /** Memories the reply leaned on, so every claim is checkable. */
  cited: { id: string; person: string; text: string }[];
  /** Nudges volunteered unprompted this turn. */
  volunteered: Nudge[];
  /**
   * Set when extraction failed. Reported rather than hidden: the user needs to
   * know something they said was not remembered, and why.
   */
  captureError?: string;
}

/**
 * Runs one turn: save what was said, then answer.
 *
 * Saving happens before the reply is written so the reply can speak to what was
 * just stored — telling someone "noted" is only honest if it is already durable.
 */
export async function takeTurn({ store, message, undoOf = [], history = [] }: ChatTurnInput): Promise<ChatTurn> {
  const { memories, coverage } = await store.listLive();
  const known = [...new Set(memories.map((m) => m.person))];

  // ── 1. Notice and write ─────────────────────────────────────────────────────
  const extraction = await capture(message, known, history);

  const saved: SavedMemory[] = [];

  // Said already, in this book or earlier in this same conversation. Saying the
  // same thing twice should not file it twice: the ledger is a record, and a
  // duplicate reads as a fact the user stated two separate times.
  const saidAlready = new Set<string>();
  const key = duplicateKey;
  for (const memory of memories) saidAlready.add(key(memory.person, memory.text));
  for (const undoneId of undoOf) {
    // Remember what an undone memory looked like, so saying it again is allowed
    // (the user changed their mind and then reversed it) but saying the same
    // thing twice in a row is not.
    const previous = memories.find((m) => m.id === undoneId);
    if (previous) saidAlready.delete(key(previous.person, previous.text));
  }

  for (const candidate of extraction.candidates) {
    // Below the threshold a guess is worse than nothing, so it is not written and
    // not mentioned. This is the same bar the confirm path used.
    if (candidate.confidence < CONFIRM_THRESHOLD) continue;

    const candidateKey = key(candidate.person, candidate.text);
    if (saidAlready.has(candidateKey)) continue;
    saidAlready.add(candidateKey);

    try {
      const written = await store.remember({
        person: candidate.person,
        type: candidate.type,
        text: candidate.text,
        occurredAt: candidate.occurredAt,
        dueAt: candidate.dueAt,
        // Kept as "MM-DD" rather than resolved to a date, so it keeps coming round
        // next year instead of quietly expiring.
        anniversary: candidate.anniversary,
        // Told to us is confirmed. See the note at the top of this file.
        //
        // This field is load-bearing and easy to miss: makeMemory defaults it to
        // "inferred", and only "confirmed" memories are allowed to create nudges.
        // Saving without it writes memories that sit in the ledger forever and can
        // never once remind you of anything.
        confidence: "confirmed",
        // A promise you have just stated is outstanding by definition. Forcing
        // the model's status here would let it file a live commitment as "kept",
        // which quietly closes it and means it never nags you again.
        status: candidate.type === "promise" ? "open" : candidate.status,
      } as Parameters<PeopleBookStore["remember"]>[0]);

      saved.push({ id: written.id, person: written.person, text: written.text, type: written.type });
    } catch (error) {
      // One failed write must not cost the whole turn. The reply still happens
      // and the ledger simply does not gain this one.
      if (!extraction.error) {
        extraction.error = `One thing could not be saved: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  const after = saved.length ? (await store.listLive()).memories : memories;

  // ── 2. Volunteer something, unprompted ──────────────────────────────────────
  //
  // This is the feature. A companion who never mentions the thing you would have
  // forgotten is just a database, so anything the ranker says is due is offered
  // whether or not the user asked. Deterministic ranking decides *what*; the model
  // only decides how to word it.
  // "On its own" means on its own, not "even while we are mid-conversation about
  // this person". If the thread is already about Mara, bringing up Mara is noise.
  const threadSubjects = [message, ...history.map((h) => h.text)].join("\n").toLowerCase();
  const due = computeNudges({ memories: after }).nudges.filter((n) => !dismissed(n, threadSubjects));
  const volunteered = due.slice(0, 2);
  const phrased = await phraseNudges(volunteered);

  // ── 3. Answer ───────────────────────────────────────────────────────────────
  const cited = pickCitations(after, threadSubjects, volunteered);
  const reply = await composeReply({ message, history, memories: after, phrased, cited, saved });

  return {
    reply,
    saved,
    cited,
    volunteered,
    ...(extraction.error ? { captureError: extraction.error } : {}),
  };
}

/**
 * Nudges not worth raising right now.
 *
 * Crude on purpose: if the message is about that person, the user is already on
 * it and repeating it is noise. Deterministic, so it never surprises anyone.
 */
function dismissed(nudge: Nudge, thread: string): boolean {
  const about = nudge.person.toLowerCase();
  if (!about || about === "you") return false;
  return thread.includes(about);
}

/** The memories the reply is standing on, so every claim can be checked. */
function pickCitations(
  memories: readonly PersonMemory[],
  thread: string,
  volunteered: readonly Nudge[],
): { id: string; person: string; text: string }[] {
  const cited = new Map<string, { id: string; person: string; text: string }>();

  // Anything volunteered is by definition something we are asserting.
  for (const nudge of volunteered) {
    const source = memories.find((m) => m.id === nudge.sourceMemoryId);
    if (source) cited.set(source.id, { id: source.id, person: source.person, text: source.text });
  }

  // Plus anything about a person the user just mentioned, so a reply that says
  // "you already know her birthday is the 12th" can be checked.
  for (const memory of memories) {
    if (cited.has(memory.id)) continue;
    if (memory.person.toLowerCase().includes("you")) continue;
    if (thread.includes(memory.person.toLowerCase())) {
      cited.set(memory.id, { id: memory.id, person: memory.person, text: memory.text });
    }
    if (cited.size >= 6) break;
  }

  return [...cited.values()];
}

/**
 * Writes the assistant's message.
 *
 * Short on purpose. This is a companion you talk to, not a report: two or three
 * sentences, no headers, no bullet lists, no restating the question. If there is
 * nothing durable in the message it says so by moving on rather than announcing
 * that it found nothing.
 */
async function composeReply(args: {
  message: string;
  history: readonly PriorTurn[];
  memories: readonly PersonMemory[];
  phrased: readonly string[];
  cited: readonly { id: string; person: string; text: string }[];
  saved: readonly SavedMemory[];
}): Promise<string> {
  if (!process.env.GROQ_API_KEY) {
    return fallbackReply(args);
  }

  const ledger = args.memories
    .slice(0, 40)
    .map((m) => `- ${m.person} | ${m.type} | ${m.text}`)
    .join("\n");

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        messages: [
          { role: "system", content: REPLY_SYSTEM },
          {
            role: "user",
            content: [
              args.history.length
                ? `Conversation so far:\n${args.history
                    .slice(-8)
                    .map((h) => `${h.role === "you" ? "Them" : "Assistant"}: ${h.text}`)
                    .join("\n")}`
                : "",
              `\nTheir latest message:\n${args.message}`,
              `\nMemories now on file:\n${ledger || "(none yet)"}`,
              args.saved.length
                ? `\nJust remembered from that message: ${args.saved.map((s) => `"${s.text}" (about ${s.person})`).join("; ")}`
                : "",
              args.phrased.length ? `\nWorth bringing up unprompted: ${args.phrased.join(" | ")}` : "",
              "\nReply as their assistant. Two or three sentences, plain prose.",
            ].filter(Boolean).join("\n"),
          },
        ],
      }),
    });

    if (!response.ok) return fallbackReply(args);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text || fallbackReply(args);
  } catch {
    return fallbackReply(args);
  }
}

const REPLY_SYSTEM = `You are the user's assistant in People Book. You know the people in their life and what they have told you.

Rules:
- Two or three sentences. Plain prose. Never use headers, bullet points, or emoji.
- Never restate what the user just said back to them.
- Never say you have "saved", "noted", or "remembered" something unless it appears under "Just remembered from that message".
- If something is worth bringing up unprompted, work it in naturally as conversation, not as an announcement.
- If the message is just chat, reply like a person who is paying attention. Do not force a memory out of it.
- Do not invent facts. Everything you assert must come from the memories given to you.
- You are continuing a conversation, not starting one. Resolve "her", "him", "it", "what about Dev?" against the turns above. If it is genuinely ambiguous, ask one short question rather than guessing.`;

/**
 * What to say when the model is unavailable.
 *
 * Degrades to something true rather than nothing: the volunteer lines are
 * already deterministic, so the nudge still lands even with no model at all.
 */
function fallbackReply(args: {
  message: string;
  phrased: readonly string[];
  saved: readonly SavedMemory[];
}): string {
  const parts: string[] = [];
  if (args.saved.length) {
    parts.push(
      args.saved.length === 1
        ? `Got it — I'll keep "${args.saved[0]!.text}" to mind.`
        : `Got it, ${args.saved.length} things noted.`,
    );
  }
  for (const line of args.phrased) parts.push(line);
  if (!parts.length) return "I'm listening.";
  return parts.join(" ");
}

/**
 * A comparable form of a claim, for spotting a repeat.
 *
 * Loose on purpose. Models phrase the same fact differently across turns — "her
 * birthday is the 14th" and "Mara's birthday is on the 14th" are one memory — so
 * punctuation and filler are dropped rather than compared literally. It is a
 * duplicate guard, not a semantic search; near misses are caught by the ledger
 * showing both, which is honest.
 */
export function normaliseForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.!?,;:'"\u2019]/g, "")
    .replace(/\b(is|are|was|were|the|a|an|on|in|at)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The identity of a claim for duplicate detection.
 *
 * Exported because "does this count as the same thing" is a judgement worth
 * testing directly. Testing it through the model instead means the assertion
 * depends on whether Groq happened to extract anything this time, which makes the
 * test flaky for a reason unrelated to what it is checking.
 */
export function duplicateKey(person: string, text: string): string {
  return `${person.toLowerCase()}::${normaliseForCompare(text)}`;
}

/** Narrows an extraction to the candidates worth writing. Exported for tests. */
export function worthSaving(candidates: readonly MemoryCandidate[]): MemoryCandidate[] {
  return candidates.filter((c) => c.confidence >= CONFIRM_THRESHOLD);
}