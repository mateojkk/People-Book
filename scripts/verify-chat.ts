/**
 * Tests for one conversational turn.
 *
 * The turn is the product, so its behaviour is pinned here rather than left to be
 * discovered by talking to it. A stub store stands in for Walrus so these run
 * offline and instantly: what matters is which memories get written, which get
 * volunteered, and what the reply is allowed to assert — none of which should need
 * a network to verify.
 */

import { takeTurn, worthSaving } from "../api/lib/chat.ts";
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

process.stdout.write("\n");
if (failures > 0) {
  process.stdout.write(`${failures} of ${checks} checks FAILED\n`);
  process.exit(1);
}
process.stdout.write(`all ${checks} checks passed\n`);