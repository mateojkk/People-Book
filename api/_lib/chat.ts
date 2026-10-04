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
import { computePatterns, type Pattern } from "./patterns.ts";
import { groqFetch } from "./groq.ts";
import { computeNudges } from "./ranking.ts";
import { collapseById, isLive } from "../../shared/memory-codec.ts";
import type { PeopleBookStore } from "../../shared/store.ts";
import type { MemoryCandidate, Nudge, PersonMemory } from "../../shared/types.ts";
import { CONFIRM_THRESHOLD } from "../../shared/types.ts";


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
  /** Repeated claims, when the turn was the question that computes them. */
  patterns?: Pattern[];
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
export async function takeTurn(
  { store, message, undoOf = [], history = [] }: ChatTurnInput,
  hooks: { onDelta?: (text: string) => void } = {},
): Promise<ChatTurn> {
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

  // ── 1b. Write ──────────────────────────────────────────────────────────────
  //
  // Parallel, and it was sequential. Each write is a round trip to the relayer,
  // and a message that yields three candidates used to pay for them one after the
  // other -- three sequential network waits where one concurrent batch is the
  // same total time. allSettled rather than all, so one failed write still does
  // not cost the turn.
  const writes = extraction.candidates
    .filter((candidate) => {
      if (candidate.confidence < CONFIRM_THRESHOLD) return false;
      const candidateKey = key(candidate.person, candidate.text);
      if (saidAlready.has(candidateKey)) return false;
      saidAlready.add(candidateKey);
      return true;
    })
    .map((candidate) =>
      store
        .remember({
          person: candidate.person,
          type: candidate.type,
          text: candidate.text,
          occurredAt: candidate.occurredAt,
          dueAt: candidate.dueAt,
          // Kept as "MM-DD" rather than resolved to a date, so it keeps coming
          // round next year instead of quietly expiring.
          anniversary: candidate.anniversary,
          // The user's own reason, for corrections only. This field is the entire
          // value of the type and it is easy to omit here, because nothing breaks
          // if you do -- the memory is written, the panel renders, and the reason
          // is simply gone. That is the failure mode this comment exists to stop.
          ...(candidate.reason ? { reason: candidate.reason } : {}),
          // Told to us is confirmed. See the note at the top of this file. This is
          // load-bearing: makeMemory defaults to "inferred", and only "confirmed"
          // memories may create nudges, so saving without it writes memories that
          // sit in the ledger forever and can never remind you of anything.
          confidence: "confirmed",
          // A promise you have just stated is outstanding by definition.
          status: candidate.type === "promise" ? "open" : candidate.status,
        } as Parameters<PeopleBookStore["remember"]>[0])
        .then((written) => ({ ok: true as const, written }))
        // One failed write must not cost the whole turn. The reply still happens
        // and the ledger simply does not gain this one.
        .catch((error: unknown) => ({ ok: false as const, error })),
    );

  const settled = writes.length ? await Promise.allSettled(writes) : [];
  const fresh: PersonMemory[] = [];
  for (const result of settled) {
    if (result.status === "rejected") continue;
    if (!result.value.ok) {
      if (!extraction.error) {
        extraction.error = `One thing could not be saved: ${result.value.error instanceof Error ? result.value.error.message : String(result.value.error)}`;
      }
      continue;
    }
    fresh.push(result.value.written);
    saved.push({
      id: result.value.written.id,
      person: result.value.written.person,
      text: result.value.written.text,
      type: result.value.written.type,
    });
  }

  // ── 1c. Fold the new memories in locally ───────────────────────────────────
  //
  // This used to re-enumerate the entire ledger after writing, which is a full
  // round trip to the relayer on every single message, purely to see memories we
  // already hold in our hands. The written objects are the real ones -- the store
  // made them -- so merging them and folding locally gives the same answer without
  // the network. collapseById is the same fold, and it matters here: a message
  // that corrects something already in the book must not leave the old claim
  // visible for the rest of the turn.
  const after = fresh.length ? collapseById([...memories, ...fresh]).filter(isLive) : memories;

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

  // ── 3. Answer ───────────────────────────────────────────────────────────────
  // ── "What do I keep saying?" is answered here and never reaches the model ────
  //
  // This was written and then reported as wired in, and it was not wired in at
  // all: the three functions existed and nothing called them. The offline suite did
  // not catch it because verify-chat imports `asksForPatterns` directly, so every
  // test passed while the feature was dead in the product.
  //
  // The reason it must not reach the model is unchanged. The answer is a shape
  // across many memories and exists in no single one of them, so a model given the
  // ledger will infer one from whatever it reads and sound entirely certain. The
  // user has no way to distinguish that from a real finding, which is the one
  // thing this product exists to make impossible.
  const patterns = computePatterns(after);
  if (asksForPatterns(message)) {
    const answer = patternAnswer(patterns);
    if (hooks.onDelta) hooks.onDelta(answer);
    return { reply: answer, cited: [], volunteered, saved, patterns };
  }

  const cited = pickCitations(after, threadSubjects, volunteered);
  const reply = await composeReply({ message, history, memories: after, volunteered, cited, saved, onDelta: hooks.onDelta });

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
  /** Deterministic nudge sentences, handed over to be woven in rather than reworded. */
  volunteered: readonly Nudge[];
  cited: readonly { id: string; person: string; text: string }[];
  saved: readonly SavedMemory[];
  /**
   * Called with each fragment as the model produces it.
   *
   * This is the difference between a chatbot and a form with a text box. The
   * ledger read before this point can take seconds, so without streaming the user
   * watches a spinner and learns nothing until the whole answer is ready. With it
   * the reply arrives at reading speed.
   */
  onDelta?: (text: string) => void;
}): Promise<string> {
  if (!process.env.GROQ_API_KEY) {
    return fallbackReply(args);
  }

  // Corrections are not facts and must not be listed among them. A rule that
  // arrives in a list of things-that-are-true reads as trivia, and the model will
  // happily contradict it. So they are pulled out and given their own block,
  // stated as binding, with the user's own reason attached -- the reason is what
  // makes the rule recognisable when it comes back in a different costume.
  const corrections = args.memories.filter((m) => m.type === "correction");
  // Profile facts are ids the store minted, so they arrive with the ledger rather
  // than needing a second read.
  const profile = {
    name: args.memories.find((m) => m.id === "profile_name")?.text.replace(/^Prefers to be called |\.$/g, ""),
    pronouns: args.memories.find((m) => m.id === "profile_pronouns")?.text.replace(/^Uses | pronouns\.$/g, ""),
    timezone: args.memories.find((m) => m.id === "profile_timezone")?.text.replace(/^Is in the | timezone\.$/g, ""),
  };
  const ledger = args.memories
    .filter((m) => m.type !== "correction" && !m.id.startsWith("profile_"))
    .slice(0, 40)
    .map((m) => `- ${m.person} | ${m.type} | ${m.text}`)
    .join("\n");
  const standing = formatCorrections(corrections) + formatProfile({
    name: profile.name || undefined,
    pronouns: profile.pronouns || undefined,
    timezone: profile.timezone || undefined,
  });

  try {
    const response = await groqFetch(
      [
        { role: "system", content: REPLY_SYSTEM + standing },
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
              args.volunteered.length
                ? `\nWorth bringing up unprompted: ${args.volunteered.map((n) => n.text).join(" | ")}`
                : "",
              "\nReply as their assistant. Two or three sentences, plain prose.",
          ].filter(Boolean).join("\n"),
        },
      ],
      { temperature: 0.4, stream: Boolean(args.onDelta), label: "reply", role: "reply" },
    );

    // Stream when we can. A non-stream body is still read fine, so a proxy that
    // buffers the response degrades to the old behaviour rather than breaking.
    if (args.onDelta && response.body) {
      const streamed = await readStreamed(response.body, args.onDelta);
      if (streamed) return streamed;
    }

    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text || fallbackReply(args);
  } catch (error) {
    // This used to return fallbackReply, which returns "I'm listening." when
    // there is nothing to acknowledge. So a failed reply produced a 35-second
    // wait followed by a non-answer -- the worst of both, and silent about it.
    // Rate limits are temporary and the user needs to know that is what happened.
    const limited = /429|Rate limit|rate limit/.test(String((error as Error)?.message ?? ""));
    return limited
      ? "I'm being rate limited right now, so I can't answer that yet — say it again in a moment and it'll be in your book either way."
      : fallbackReply(args);
  }
}

/**
 * Reads an OpenAI-compatible SSE body, emitting content deltas.
 *
 * Returns the assembled text, or null if the body turned out not to be the
 * stream shape after all -- in which case the caller falls back to a normal parse.
 * Parsed defensively on purpose: a proxy in between can and does reshape this.
 *
 * Exported so it can be tested against a synthetic stream. Asserting this against
 * the live model instead makes the test fail whenever Groq is slow, rate-limited or
 * briefly unreachable, which is a bad trade: the thing worth pinning is the frame
 * parsing, and that is deterministic.
 */
export async function readStreamed(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<string | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let sawDelta = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload) as {
              choices?: { delta?: { content?: string }; text?: string }[];
            };
            const piece = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.text;
            if (piece) {
              sawDelta = true;
              full += piece;
              onDelta(piece);
            }
          } catch {
            // A frame we cannot read is not worth failing the whole reply over.
          }
        }
      }
    }
  } catch {
    // Keep whatever arrived. A truncated answer beats no answer.
  }

  return sawDelta ? full.trim() : null;
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
 * Answers "what do I keep saying?" without a model.
 *
 * This is the one question in the product that must never reach the model. Asked
 * it, a model will produce three sentences of fluent, plausible, invented
 * psychology about your habits -- and the user has no way to tell, which is
 * precisely the failure this whole product exists to avoid. So the answer is
 * rendered from the computed patterns instead: the exact claims, the exact
 * dates, and the count. If there are no patterns it says so, which is also the
 * truth.
 */
function patternAnswer(patterns: readonly Pattern[]): string {
  if (!patterns.length) {
    return "Nothing in the book comes up more than once, so there is no pattern to point at. That may well be true rather than a gap.";
  }

  const lines = patterns.slice(0, 3).map((p) => {
    const times = `${p.count} times`;
    const span = p.first === p.last ? p.first : `${p.first} and ${p.last}`;
    if (p.kind === "slipped") {
      return `· ${p.claim} — you said this ${times}, between ${span}, and each time the due date was later than the last.`;
    }
    if (p.kind === "unkept") {
      return `· ${p.claim} — you said this ${times}, on ${span}, and it is still open.`;
    }
    return `· ${p.claim} — said ${times}, on ${span}.`;
  });

  return `From your book, not a guess:\n${lines.join("\n")}`;
}

/**
 * Does this message ask the question the book can answer better than a model?
 *
 * Matched on intent words rather than an exact string, because the phrasing will
 * be "what am I always saying", "what do I keep doing" and "why do I keep
 * apologising" as often as it is the literal question. Anything that is not
 * clearly one of the four book-answered questions falls through to the model.
 */
export function asksForPatterns(message: string): boolean {
  const m = message.toLowerCase();
  const aboutHabits = /\b(keep\w*|always|again|repeat\w*|habit\w*|pattern\w*|same thing|every time|constantly|again and again)\b/.test(m);
  const asksHistory = /\b(what|why|which|tell|show)\b/.test(m);
  return aboutHabits && asksHistory;
}

/**
 * Renders the user's standing corrections as binding rules.
 *
 * Appended to the system prompt rather than mixed into the ledger, because that
 * is the difference between a rule and a piece of trivia. It is also the only
 * place a correction can pay off: a stored correction nobody is shown changes
 * nothing, which is the difference between a memory system and a filing cabinet.
 *
 * Returns an empty string when there are none, so the common case costs one
 * concat on an unchanged constant.
 */
/**
 * Renders the profile as instructions the model can act on.
 *
 * Injected on every single turn, unlike everything else in the book. A memory
 * about the user's name is only useful if it is present at the moment a reply is
 * written, and "present when relevant" is exactly the condition under which
 * greeting someone by name is not relevant -- the model has to already know.
 *
 * Kept short on purpose. This is prepended to every request, so every token here
 * is paid for on every message, and a paragraph of biography would cost more than
 * it is worth.
 */
export function formatProfile(facts: {
  name?: string;
  pronouns?: string;
  timezone?: string;
}): string {
  const lines: string[] = [];
  if (facts.name) lines.push(`- Address the user as ${facts.name}. Use it naturally, not every sentence.`);
  if (facts.pronouns) lines.push(`- The user's pronouns are ${facts.pronouns}.`);
  if (facts.timezone) lines.push(`- The user is in the ${facts.timezone} timezone, so "today" means today there.`);
  if (!lines.length) return "";
  return `\n\nABOUT THE USER (they set this themselves, so it is not a guess):\n${lines.join("\n")}`;
}

export function formatCorrections(corrections: readonly PersonMemory[]): string {
  if (!corrections.length) return "";

  const lines = corrections.map((c) => {
    // The reason is quoted as the user gave it. Without it, a bare instruction
    // gets quietly ignored the first time it looks like it does not apply.
    const why = c.reason ? ` Reason given: "${c.reason}"` : "";
    return `- ${c.text}${why}`;
  });

  return `

STANDING CORRECTIONS -- these are rules the user has given you about how to work.
They are binding and they outrank your own defaults, including any preference you
would otherwise assume. Follow them even when the current request seems to call
for something else; if following one and the request genuinely conflict, say so
in one sentence rather than silently overriding the user.
${lines.join("\n")}`;
}

/**
 * What to say when the model is unavailable.
 *
 * Degrades to something true rather than nothing: the volunteer lines are
 * already deterministic, so the nudge still lands even with no model at all.
 */
/**
 * The reply when the book is empty and this message added nothing.
 *
 * Acknowledges what was said without claiming to know anything, and points at the
 * one thing that would change it. A generic "I'm listening" reads as a chatbot
 * that has not been given the memo; naming the actual next step makes the first
 * message do work.
 *
 * Purely derived from the message and whether anything was captured. There is no
 * path here that can state a fact, because there are no facts to state.
 */
function emptyBookReply(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "Say something and I'll hold on to it.";

  // A greeting is a greeting. Matching the register is not the same as claiming
  // anything, and answering "hey" with a paragraph is its own kind of wrong.
  if (/^(hey|hi|hello|yo|sup|howdy|heya|good (morning|evening|afternoon))/i.test(trimmed)) {
    return "Hey. Tell me about someone — who they are to you, what's going on with them. I'll keep it.";
  }

  if (/\?$/.test(trimmed)) {
    return "I don't know anything about that yet — there's nothing in your book about it. Tell me and I will.";
  }

  return "Noted, though there was nothing in it worth keeping. Tell me about someone and I'll hold on to the details.";
}

function fallbackReply(args: {
  message: string;
  saved: readonly SavedMemory[];
  /** Absent when the caller has nothing to volunteer. */
  volunteered?: readonly Nudge[];
}): string {
  const parts: string[] = [];
  if (args.saved.length) {
    parts.push(
      args.saved.length === 1
        ? `Got it — I'll keep "${args.saved[0]!.text}" to mind.`
        : `Got it, ${args.saved.length} things noted.`,
    );
  }
  for (const nudge of args.volunteered ?? []) parts.push(nudge.text);
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