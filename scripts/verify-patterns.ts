/**
 * Patterns: "what do I keep saying?"
 *
 * Every case here is one where being wrong would be expensive. A false pattern
 * makes the user distrust the one product whose whole claim is that its answers
 * come from their actual history.
 */
import { computePatterns, MIN_OCCURRENCES } from "../api/_lib/patterns.ts";
import { makeMemory, reviseMemory } from "../shared/memory-codec.ts";
import type { PersonMemory } from "../shared/types.ts";

let failures = 0;
function section(name: string) { console.log(`\n${name}`); }
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const p = (text: string, opts: Partial<PersonMemory> = {}): PersonMemory =>
  makeMemory({ person: "Maya", type: "promise", text, status: "open", ...opts });
const on = (date: string, text: string, opts: Partial<PersonMemory> = {}) =>
  p(text, { occurredAt: date, createdAt: `${date}T10:00:00.000Z`, ...opts });

section("the same promise, told twice");
{
  const out = computePatterns([
    on("2026-01-04", "promised to ring Maya about the invoice"),
    on("2026-02-11", "promised to ring Maya about the invoice"),
  ]);
  check("it is found", out.length === 1, JSON.stringify(out));
  check("counted twice", out[0]?.count === 2);
  check("dated from first to last", out[0]?.first === "2026-01-04" && out[0]?.last === "2026-02-11");
  check("both memories are named, so it is checkable", out[0]?.memoryIds.length === 2);
  check("kept as a repeated promise", out[0]?.kind === "repeated-promise", out[0]?.kind);
}

section("a date moving does not split the promise");
// The number is stripped, because "on the 4th" vs "on the 18th" is the same
// promise and the date is precisely what the user is trying to forget.
{
  const out = computePatterns([
    on("2026-01-04", "promised to ring Maya about the invoice on the 4th"),
    on("2026-02-18", "promised to ring Maya about the invoice on the 18th"),
  ]);
  check("it matches across different dates", out.length === 1, JSON.stringify(out.map((o) => o.count)));
  check("without a due date it is just a repeated promise", out[0]?.kind === "repeated-promise", out[0]?.kind);
}

section("the deadline you keep pushing");
// Told on different days, that is merely repeating. Told with the due date moving
// each time, it is something else: the same promise, deferred again and again,
// which is the most useful thing this file can notice and the least visible to
// the person living it.
{
  const out = computePatterns([
    on("2026-01-04", "promised to send Maya the photos", { dueAt: "2026-01-10" }),
    on("2026-02-18", "promised to send Maya the photos", { dueAt: "2026-02-24" }),
  ]);
  check("it is recognised as slipped", out[0]?.kind === "slipped", out[0]?.kind);
  check("and the moved dates are all on record", out[0]?.memoryIds.length === 2);

  // Said in January for the 1st of March, then in February for the 20th. That is
  // the deadline being pulled forward, which is a fix rather than a slip.
  const pulled = computePatterns([
    on("2026-01-04", "promised to send Maya the photos", { dueAt: "2026-03-01" }),
    on("2026-02-18", "promised to send Maya the photos", { dueAt: "2026-02-20" }),
  ]);
  check("a deadline pulled forward is not a slip", pulled[0]?.kind === "repeated-promise", pulled[0]?.kind);
}

section("different people are different promises");
{
  const out = computePatterns([
    p("promised to ring Maya about it", { occurredAt: "2026-01-04", createdAt: "2026-01-04T10:00:00.000Z" }),
    p("promised to ring Dev about it", { person: "Dev", occurredAt: "2026-02-04", createdAt: "2026-02-04T10:00:00.000Z" }),
  ]);
  check("it does not merge them", out.length === 0, JSON.stringify(out));
}

section("once is not a pattern");
{
  const out = computePatterns([on("2026-01-04", "promised to ring Maya about the invoice")]);
  check("a single telling is not a habit", out.length === 0);
  check(`and the threshold is ${MIN_OCCURRENCES}`, MIN_OCCURRENCES === 2);
}

section("keeping it once ends the pattern");
// Reported after that, it would be reporting the past.
{
  const out = computePatterns([
    on("2026-01-04", "promised to ring Maya about the invoice"),
    on("2026-02-11", "promised to ring Maya about the invoice", { status: "kept" }),
  ]);
  check("it stops reporting a habit you broke", out.length === 0, JSON.stringify(out));
}

section("short claims are ignored");
// Two words matching is a coincidence, not a pattern.
{
  const out = computePatterns([
    on("2026-01-04", "promised to call"),
    on("2026-02-04", "promised to call"),
  ]);
  check("it does not build a habit out of three words", out.length === 0, JSON.stringify(out));
}

section("only promises count");
// A trait that is simply true is not worth interrupting anyone about.
{
  const out = computePatterns([
    makeMemory({ person: "Maya", type: "trait", text: "works nights on the clinic", occurredAt: "2026-01-04" }),
    makeMemory({ person: "Maya", type: "trait", text: "works nights on the clinic", occurredAt: "2026-02-04" }),
  ]);
  check("a repeated fact is not reported as a habit", out.length === 0, JSON.stringify(out));
}

section("forgotten things do not haunt you");
{
  const out = computePatterns([
    on("2026-01-04", "promised to ring Maya about the invoice"),
    // A tombstone is written by revising, not by makeMemory. Passing `deleted`
    // to makeMemory is silently ignored, so this used to assert nothing.
    reviseMemory(on("2026-02-11", "promised to ring Maya about the invoice"), { deleted: true }),
  ]);
  check("a tombstone does not count as an occurrence", out.length === 0, JSON.stringify(out));
}

section("ordering is useful");
{
  const out = computePatterns([
    on("2026-03-01", "promised to send Dev the photos", { person: "Dev" }),
    on("2026-03-02", "promised to send Dev the photos", { person: "Dev" }),
    on("2026-01-04", "promised to ring Maya about the invoice"),
    on("2026-01-09", "promised to ring Maya about the invoice"),
  ]);
  check("most recent comes first", out[0]?.person === "Dev", JSON.stringify(out.map((o) => `${o.person} ${o.last}`)));
  check("the claim shown is the most recent wording", out[0]?.claim === "promised to send Dev the photos");
}

section("nothing at all is a valid book");
{
  check("empty in, empty out", computePatterns([]).length === 0);
  check("no promises at all, empty out", computePatterns([
    makeMemory({ person: "Maya", type: "trait", text: "vegetarian" }),
  ]).length === 0);
}

console.log("");
if (failures > 0) { console.log(`${failures} check(s) FAILED`); process.exit(1); }
console.log("all checks passed");
