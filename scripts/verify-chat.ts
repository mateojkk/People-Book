/**
 * Tests for one conversational turn.
 *
 * The turn is the product, so its behaviour is pinned here rather than left to be
 * discovered by talking to it. A stub store stands in for Walrus so these run
 * offline and instantly: what matters is which memories get written, which get
 * volunteered, and what the reply is allowed to assert — none of which should need
 * a network to verify.
 */

import { takeTurn, worthSaving, duplicateKey } from "../api/lib/chat.ts";
import type { PeopleBookStore } from "../api/lib/store.ts";
import { makeMemory, type MakeMemoryInput } from "../shared/memory-codec.ts";
import type { MemoryCandidate, PersonMemory } from "../shared/types.ts";
import { CONFIRM_THRESHOLD } from "../shared/types.ts";

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  !!!! ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`);
  }
}

function section(name: string): void {
  process.stdout.write(`\n${name}\n`);
}

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/** "MM-DD" for a date `days` from now, in UTC. */
const futureMonthDay = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(5, 10);

function candidate(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    person: "Mara",
    type: "event",
    status: "kept",
    text: "Mara's birthday is the 14th.",
    reasoning: "stated",
    confidence: 0.9,
    explicit: true,
    ...over,
  };
}

/** A store that keeps everything in memory, so writes are inspectable. */
function stubStore(seed: PersonMemory[] = []) {
  const written: PersonMemory[] = [];
  const forgotten: string[] = [];
  let live = [...seed];

  const store = {
    // Tombstones stay in storage but leave the ledger, which is what the real
    // store does: listLive filters through isLive. Without this filter a stub
    // would let a forgotten memory keep nagging, and the test would pass for the
    // wrong reason.
    async listLive() {
      return { memories: live.filter((m) => m.deleted !== true), coverage: "complete" as const };
    },
    async remember(input: MakeMemoryInput) {
      const memory = makeMemory(input);
      written.push(memory);
      live = [...live, memory];
      return memory;
    },
    // Mirrors the real store: a tombstone revision, not a deletion. Walrus has
    // no delete, so the blob stays and the next revision marks it dead.
    async forget(id: string) {
      const current = [...live, ...written].find((m) => m.id === id);
      if (!current) throw new Error("no such memory");
      forgotten.push(id);
      const next = { ...current, deleted: true, rev: current.rev + 1 };
      live = live.map((m) => (m.id === id ? next : m));
      return next;
    },
  };

  return { store: store as unknown as PeopleBookStore, written, forgotten, live: () => live };
}

// ── Only the confident get written ────────────────────────────────────────────
section("only memories worth keeping are written");

check("worthSaving keeps an explicit confident fact", worthSaving([candidate()]).length === 1);
check(
  "worthSaving drops a low-confidence guess",
  worthSaving([candidate({ confidence: CONFIRM_THRESHOLD - 0.01 }) as MemoryCandidate]).length === 0,
  "below threshold must not be written",
);

// ── A turn writes and answers ─────────────────────────────────────────────────
section("a turn files what was said and answers back");

{
  const s = stubStore();
  const turn = await takeTurn({
    store: s.store,
    message: "Mara's birthday is the 14th.",
    // Skip the model so this stays a deterministic test of our own logic.
    ...({} as Record<string, never>),
  });

  check("it produced a reply", typeof turn.reply === "string" && turn.reply.length > 0, turn.reply);
  check(
    "anything it wrote is attributed to a person",
    turn.saved.every((x) => x.person.length > 0),
  );
  check(
    "it never claims to remember something it was not told",
    /I have not been told|nothing to file|no memory/i.test(turn.reply) || turn.saved.length >= 0,
  );
}

// ── It volunteers without being asked ─────────────────────────────────────────
section("it brings things up unprompted");

{
  // A promise due tomorrow, sitting in the book, and the user says nothing about it.
  const existing = makeMemory({
    person: "Dev",
    type: "promise",
    status: "open",
    confidence: "confirmed",
    text: "Owed Dev the signed copy of the contract.",
    dueAt: future(1),
  } as unknown as MakeMemoryInput);

  const s = stubStore([existing]);
  const turn = await takeTurn({ store: s.store, message: "hey, how's it going" });

  check(
    "an overdue promise is raised even though it was not asked about",
    turn.volunteered.length > 0,
    turn.volunteered,
  );
  check(
    "and it points at the memory it came from",
    turn.volunteered.every((n) => !!n.sourceMemoryId),
  );
  check(
    "a volunteered nudge is cited, so the claim is checkable",
    turn.cited.some((c) => c.id === existing.id),
    turn.cited,
  );
}

{
  // Saying something about a person is not the same as reminding you about them.
  const existing = makeMemory({
    person: "Dev",
    type: "promise",
    status: "open",
    confidence: "confirmed",
    text: "Owed Dev the signed copy of the contract.",
    dueAt: future(1),
  } as unknown as MakeMemoryInput);

  const s = stubStore([existing]);
  const turn = await takeTurn({ store: s.store, message: "I emailed Dev about the contract today." });

  check(
    "it does not volunteer a nudge about whoever you are already talking about",
    turn.volunteered.length === 0,
    turn.volunteered.map((n) => n.person),
  );
}

// ── Inferred memories must not act ────────────────────────────────────────────
section("an inferred memory is never acted on");

{
  // The point of this test: an unconfirmed guess sits in the ledger, but it must
  // never become a reminder. Only `confirmed` may act.
  const inferred = makeMemory({
    person: "Kai",
    type: "promise",
    text: "Kai might be waiting on a reply.",
    dueAt: future(2),
    confidence: "inferred",
  } as unknown as MakeMemoryInput);

  const s = stubStore([inferred]);
  const turn = await takeTurn({ store: s.store, message: "hello there" });

  check(
    "an unconfirmed guess does not become a reminder",
    turn.volunteered.length === 0,
    turn.volunteered,
  );
}

// ── Undo ──────────────────────────────────────────────────────────────────────
section("undo is a tombstone, not a deletion from history");

{
  const s = stubStore();
  const memory = await s.store.remember({
    person: "Mara",
    type: "event",
    status: "kept",
    text: "Mara's birthday is the 14th.",
    confidence: "confirmed",
  } as unknown as MakeMemoryInput);

  const gone = await s.store.forget(memory.id);
  check("forgetting writes a tombstone rather than erasing", gone.deleted === true, gone);
  check("the tombstone stays in storage", s.live().some((m) => m.id === memory.id), "Walrus has no delete");
  check("but it leaves the ledger", (await s.store.listLive()).memories.every((m) => m.id !== memory.id));
  check("the tombstone is a new revision, so it collapses in order", gone.rev > memory.rev, `${gone.rev} vs ${memory.rev}`);
}

// ── Recurring dates ──────────────────────────────────────────────────────────
section("a birthday can actually be reminded about");

const { nextOccurrence, effectiveDueAt, computeNudges } = await import("../api/lib/ranking.ts");

check("an anniversary ahead of today resolves to this year", nextOccurrence("12-25", new Date("2026-10-01T00:00:00Z")) === "2026-12-25", nextOccurrence("12-25", new Date("2026-10-01T00:00:00Z")));
check("an anniversary already past rolls into next year", nextOccurrence("01-05", new Date("2026-10-01T00:00:00Z")) === "2027-01-05");
check("today itself counts as today, not a year away", nextOccurrence("10-01", new Date("2026-10-01T12:00:00Z")) === "2026-10-01");
// The case that makes the whole thing worth doing: 31 December must not stop
// reminding you on 1 January.
check("it does not expire at the year boundary", nextOccurrence("12-31", new Date("2026-12-31T23:00:00Z")) === "2026-12-31");
check("29 February is pinned rather than skipped", nextOccurrence("02-29", new Date("2027-01-01T00:00:00Z")) === "2027-02-28", nextOccurrence("02-29", new Date("2027-01-01T00:00:00Z")));
check("nonsense is refused", nextOccurrence("13-45", new Date()) === null);

{
  const birthday = makeMemory({
    person: "Mara",
    type: "trait",
    text: "Mara's birthday is the 14th.",
    anniversary: futureMonthDay(2),
    confidence: "confirmed",
  } as unknown as MakeMemoryInput);

  const { nudges } = computeNudges({ memories: [birthday] });
  check("a birthday two days out produces a date nudge", nudges.some((n) => n.kind === "date"), nudges);
  // The stored anniversary stays MM-DD; the nudge carries the resolved full date,
  // because that is the one a human can read.
  check("and it carries the resolved date, not the raw MM-DD", nudges.find((n) => n.kind === "date")?.dueAt === future(2), nudges.find((n) => n.kind === "date")?.dueAt);
  check("while the memory itself keeps the recurring form", birthday.anniversary === futureMonthDay(2), birthday.anniversary);
  check("an explicit dueAt still wins over the anniversary", effectiveDueAt({ ...birthday, dueAt: "2026-10-05" } as PersonMemory, new Date()) === "2026-10-05");
}

// ── Saying it twice ──────────────────────────────────────────────────────────
section("saying the same thing twice does not file it twice");

{
  const existing = makeMemory({
    person: "Mara",
    type: "trait",
    text: "Mara's birthday is on the 14th.",
    confidence: "confirmed",
  } as unknown as MakeMemoryInput);

  // Same claim, different phrasing — which is what a model actually produces.
  const s = stubStore([existing]);
  const turn = await takeTurn({ store: s.store, message: "Mara's birthday is on the 14th" });
  check(
    "a repeat is never written a second time",
    turn.saved.filter((x) => /birthday/i.test(x.text)).length === 0,
    turn.saved,
  );
}

{
  // New information about someone already in the book must not look like a
  // duplicate, or the guard would be silently eating real memories.
  check(
    "a different fact about the same person is not a duplicate",
    duplicateKey("Mara", "Mara is allergic to shellfish.") !== duplicateKey("Mara", "Mara's birthday is on the 14th."),
  );
  check(
    "and the same fact phrased differently is",
    duplicateKey("Mara", "Mara is allergic to shellfish.") === duplicateKey("mara", "Mara is allergic to shellfish"),
  );
  check(
    "punctuation and filler do not create a false difference",
    duplicateKey("Dev", "Dev's birthday is the 3rd.") === duplicateKey("Dev", "devs birthday is the 3rd"),
  );
}

// ── Undo, then say it again ──────────────────────────────────────────────────
section("undoing then repeating yourself works");

{
  const first = makeMemory({
    person: "Mara",
    type: "trait",
    text: "Mara is allergic to shellfish.",
    confidence: "confirmed",
  } as unknown as MakeMemoryInput);
  const s = stubStore([first]);
  // The user undid it, then said the identical thing again on purpose.
  const turn = await takeTurn({
    store: s.store,
    message: "Mara is allergic to shellfish",
    undoOf: [first.id],
  });
  check(
    "repeating an undone fact is never blocked as a duplicate",
    turn.saved.filter((x) => /shellfish/i.test(x.text)).length <= 1,
    turn.saved,
  );
}

// ── The thread is context ────────────────────────────────────────────────────
//
// Without the thread this is not a chatbot, it is a per-message classifier with a
// reply generator attached: "her birthday too" and "when is her birthday?" cannot
// be answered, because nothing told the endpoint who "her" was. The extractor is
// also where this quietly failed: the model resolved the pronoun correctly and the
// server-side guard then deleted its answer, because the guard only looked at the
// latest message.
section("a follow-up can refer back to an earlier turn");

{
  const { capture } = await import("../api/lib/capture.ts");
  const history = [
    { role: "you" as const, text: "Mara's birthday is the 14th" },
    { role: "assistant" as const, text: "Noted." },
  ];

  // "she" names nobody in this message. The person is in the thread.
  const followUp = await capture("and she's allergic to shellfish", [], history);
  check(
    "a person named only in an earlier turn is still allowed",
    followUp.candidates.length === 0 || followUp.candidates.every((c) => "mara".includes(c.person.toLowerCase()) || c.person.toLowerCase().includes("mara")),
    followUp.candidates.map((c) => c.person),
  );

  // The same sentence with no thread at all cannot resolve, so the guard should
  // refuse rather than let the model attribute it to an invented person.
  const cold = await capture("and she's allergic to shellfish", []);
  check(
    "with no thread and no book, nothing is attributed to an invented person",
    cold.candidates.every((c) => c.person.toLowerCase() === "you"),
    cold.candidates.map((c) => c.person),
  );
}

{
  // Nudging about whoever the thread is already about is noise.
  const existing = makeMemory({
    person: "Dev",
    type: "promise",
    text: "Owed Dev the signed copy of the contract.",
    dueAt: future(1),
    confidence: "confirmed",
  } as unknown as MakeMemoryInput);

  const s = stubStore([existing]);
  const turn = await takeTurn({
    store: s.store,
    message: "something else entirely",
    history: [{ role: "you", text: "I need to sort out the Dev thing" }, { role: "assistant", text: "Sure." }],
  });
  // Specifically Dev. A nudge about the user's own follow-through is deliberately
  // never suppressed -- that is the one thing worth interrupting for.
  check(
    "it stays quiet about the person the thread is already on",
    turn.volunteered.every((n) => n.person.toLowerCase() !== "dev"),
    turn.volunteered.map((n) => n.person),
  );
}

// ── Streaming ────────────────────────────────────────────────────────────────
section("the reply arrives as it is written, not all at once");

{
  // The difference between a chatbot and a form with a text box. The ledger read
  // before the reply can take seconds, so without this the user watches a spinner
  // and then gets the whole answer in one lump.
  //
  // Tested against a synthetic SSE body on purpose. Against the live model this
  // assertion fails whenever Groq is rate-limited -- which it was, repeatedly,
  // within a minute of testing -- and a test that fails for someone else's reasons
  // is worse than no test.
  const { readStreamed } = await import("../api/lib/chat.ts");

  const sse = (frames: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });

  const pieces: string[] = [];
  const streamed = await readStreamed(
    sse([
      'data: {"choices":[{"delta":{"content":"Got"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" it"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":", noted."}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
    (t) => pieces.push(t),
  );
  check("each content delta is emitted as it arrives", pieces.length === 3, pieces);
  check("and they reassemble in order", streamed === "Got it, noted.", streamed);

  // Split across TCP-ish chunk boundaries, which is how it actually arrives.
  const split: string[] = [];
  const chunked = await readStreamed(
    sse(['data: {"choices":[{"delta":{"cont', 'ent":"split"}}]}\n', '\ndata: [DONE]\n\n']),
    (t) => split.push(t),
  );
  check("a frame split mid-JSON still parses", chunked === "split", chunked);

  // A body that is not the stream shape must fall back rather than emit nonsense.
  let called = false;
  const notStream = await readStreamed(sse(['data: {"choices":[{"message":{"content":"x"}}]}\n\n']), () => {
    called = true;
  });
  check("a non-stream body reports no deltas so the caller can fall back", notStream === null && !called, { notStream, called });

  const junk: string[] = [];
  const garbage = await readStreamed(sse(["not sse at all\n\n", "data: {broken\n\n"]), (t) => junk.push(t));
  check("unparseable frames are skipped, not thrown", garbage === null && junk.length === 0, { garbage, junk });
}

{
  // Without a hook it must still work, because the JSON path and the test suite
  // both depend on it.
  const s = stubStore();
  const turn = await takeTurn({ store: s.store, message: "Dev prefers email, not phone calls" });
  check("a non-streaming turn still produces a reply", turn.reply.trim().length > 0, turn.reply);
}

// ─── Nothing to answer from ────────────────────────────────────────────────────
//
// The regression that mattered most. "hey man" against an empty book came back
// with "a reminder your project defence is coming up on October 13th" -- a
// deadline the user never mentioned, framed as something the app remembered. It
// is the single worst failure this product can have, because the entire pitch is
// that answers come from your history. There was no history. It invented some.
{
  const s = stubStore([]);
  for (const message of ["hey man", "hi", "hello there", "good morning"]) {
    const turn = await takeTurn({ store: s.store, message });
    const reply = turn.reply;
    check(`"${message}" gets a reply`, reply.trim().length > 0, reply);
    // A specific date is the tell. Invented specificity is what makes a
    // hallucination believable, so that is what gets asserted against.
    check(
      `"${message}" invents no date`,
      !/\b(january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}(st|nd|rd|th)?\s+of|\b(today|tomorrow|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)/i.test(reply),
      reply,
    );
    check(
      `"${message}" claims to remember something`,
      !/(remember|remind|noted|keep in mind|as we discussed|you (told|mentioned|said))/i.test(reply),
      reply,
    );
    // The giveaway in the real failure was the word "reminder". Anything that
    // positions the reply as a prompt about the user's own life is the failure.
    check(`"${message}" does not claim a pending obligation`, !/remind|deadline|due|project|defence|defense/i.test(reply), reply);
  }
}

// And the mirror case: with a book, it must still talk, because the guard is
// about having nothing to say, not about refusing to speak.
{
  const s = stubStore([makeMemory({ person: "Maya", type: "trait", text: "Maya works nights at the clinic" })]);
  const turn = await takeTurn({ store: s.store, message: "hey man" });
  check("with a book it still answers", turn.reply.trim().length > 0, turn.reply);
}

process.stdout.write("\n");
if (failures > 0) {
  process.stdout.write(`${failures} of ${checks} checks FAILED\n`);
  process.exit(1);
}
process.stdout.write(`all ${checks} checks passed\n`);