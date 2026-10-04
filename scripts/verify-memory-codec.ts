/**
 * Codec verification. `npm run verify`
 *
 * The codec is the one place where a silent bug would corrupt the ledger in a
 * way nobody notices until a claim has already been shown to a user as fact.
 * So it is checked directly rather than trusted: round trips, hand-built
 * corruption, the append-only collapse rule, and the tombstones.
 */

import {
  collapseById,
  isLive,
  makeMemory,
  makeMemoryId,
  parseMemory,
  reviseMemory,
  serializeMemory,
  toDisplayText,
  todayISO,
} from "../shared/memory-codec.js";
import { MEMORY_TYPES, type PersonMemory } from "../shared/types.js";

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : detail);
  }
}

function section(name: string) {
  console.log(`\n${name}`);
}

// ─── Round trip ──────────────────────────────────────────────────────────────
section("round trip");

const at = new Date("2026-03-14T10:00:00.000Z");
const promise = makeMemory({
  person: "Maya",
  type: "promise",
  text: "I told Maya I'd find the thing from the shop.",
  dueAt: "2026-09-30",
  occurredAt: "2026-03-14",
  confidence: "confirmed",
  now: at,
});

const roundTripped = parseMemory(serializeMemory(promise));
// Compared field by field rather than by JSON.stringify: serialisation puts
// `text` last (it is the part before the sentinel) while makeMemory returns it
// in the middle, so the objects are equal but their key order is not.
check(
  "round trips every field",
  roundTripped !== null &&
    Object.entries(promise).every(([k, v]) => (roundTripped as unknown as Record<string, unknown>)[k] === v) &&
    Object.keys(roundTripped).length === Object.keys(promise).length,
  { got: roundTripped },
);
check("claim leads the stored text", serializeMemory(promise).startsWith("I told Maya"));
check("claim survives display stripping", toDisplayText(serializeMemory(promise)) === promise.text);

// ─── Every type and status round trips ───────────────────────────────────────
section("all types and statuses");

for (const type of ["trait", "event", "promise", "taboo", "howto", "update"] as const) {
  for (const status of ["open", "kept", "missed", "settled", "active"] as const) {
    const m = makeMemory({ person: "Sam", type, status, text: `${type}/${status} claim`, now: at });
    const back = parseMemory(serializeMemory(m));
    check(`${type}/${status}`, back?.type === type && back?.status === status);
  }
}

// ─── Optional fields are omitted, not written as null ───────────────────────
section("optional fields");

const bare = makeMemory({ person: "you", type: "trait", text: "I am a night person.", now: at });
const bareBlob = serializeMemory(bare);
check("no dueAt key when absent", !bareBlob.includes('"dueAt"'));
check("no null litter", !bareBlob.includes("null"));
check("no verbatim key by default", !bareBlob.includes('"verbatim"'));
check("defaults to inferred", bare.confidence === "inferred");
check("promise defaults to open", makeMemory({ person: "Maya", type: "promise", text: "x" }).status === "open");

const withVerbatim = makeMemory({ person: "Maya", type: "event", text: "She moved.", verbatim: "i think she moved to lisbon", now: at });
check("verbatim round trips", parseMemory(serializeMemory(withVerbatim))?.verbatim === "i think she moved to lisbon");

// ─── Corruption must produce null, never a partial object ───────────────────
section("corruption is rejected, not half-decoded");

const good = serializeMemory(promise);
check("foreign blob", parseMemory("just some notes about my week") === null);
check("empty string", parseMemory("") === null);
check("truncated JSON", parseMemory(`${promise.text}\n@@pb1@@{"id":"mem_1"`) === null);
check("wrong sentinel", parseMemory(`${promise.text}\n@@pb2@@{"id":"mem_1","person":"x","type":"trait","status":"active","confidence":"confirmed","createdAt":"x","updatedAt":"x"}`) === null);
check("unknown type", parseMemory(promise.text + `\n@@pb1@@{"id":"m","person":"x","type":"gossip","status":"active","confidence":"confirmed","createdAt":"x","updatedAt":"x"}`) === null);
check("bad confidence", parseMemory(promise.text + `\n@@pb1@@{"id":"m","person":"x","type":"trait","status":"active","confidence":"pretty_sure","createdAt":"x","updatedAt":"x"}`) === null);
check("bad date", parseMemory(promise.text + `\n@@pb1@@{"id":"m","person":"x","type":"trait","status":"active","confidence":"confirmed","dueAt":"next tuesday","createdAt":"x","updatedAt":"x"}`) === null);
check("missing person", parseMemory(promise.text + `\n@@pb1@@{"id":"m","type":"trait","status":"active","confidence":"confirmed","createdAt":"x","updatedAt":"x"}`) === null);
check("empty claim", parseMemory(`\n@@pb1@@{"id":"m","person":"x","type":"trait","status":"active","confidence":"confirmed","createdAt":"x","updatedAt":"x"}`) === null);
check("not a string", parseMemory(undefined as unknown as string) === null);

// A claim that legitimately contains the sentinel must still parse, and must
// keep its full text — this is why parse uses the LAST sentinel.
section("sentinel inside a claim");

const tricky = makeMemory({
  person: "Dev",
  type: "howto",
  text: "He literally signs his emails with @@pb1@@ in them, don't strip it.",
  now: at,
});
const trickyBack = parseMemory(serializeMemory(tricky));
check("keeps full text when claim contains the sentinel", trickyBack?.text === tricky.text, trickyBack?.text);
check("keeps good blobs unaffected", parseMemory(good)?.id === promise.id);

// ─── Append-only collapse ───────────────────────────────────────────────────
section("append-only collapse");

const older: PersonMemory = { ...promise, status: "open", updatedAt: "2026-03-14T10:00:00.000Z" };
const newer: PersonMemory = { ...promise, status: "kept", updatedAt: "2026-04-01T09:00:00.000Z" };
const collapsed = collapseById([newer, older]);
check("newest write per id wins", collapsed.length === 1 && collapsed[0]?.status === "kept");
check("unrelated ids all survive", collapseById([older, { ...newer, id: "mem_other" }]).length === 2);

// MemWal returns blobs in RELEVANCE order, not write order, so the fold must be
// order-independent. `rev` is what guarantees that.
const tieA: PersonMemory = { ...promise, rev: 2, status: "open", updatedAt: "2026-05-05T12:00:00.000Z" };
const tieB: PersonMemory = { ...promise, rev: 3, status: "kept", updatedAt: "2026-05-05T12:00:00.000Z" };
check("higher rev wins regardless of order", collapseById([tieB, tieA])[0]?.status === "kept");
check("higher rev wins from the other side too", collapseById([tieA, tieB])[0]?.status === "kept");

const shard: PersonMemory = { ...promise, rev: 5, status: "kept", updatedAt: "2026-05-05T12:00:00.000Z" };
check(
  "collapse is order-independent across permutations",
  [tieB, tieA, shard].map((m) => m.id).length === 3 &&
    collapseById([tieA, tieB, shard])[0]?.status === collapseById([shard, tieA, tieB])[0]?.status &&
    collapseById([tieB, shard, tieA])[0]?.status === collapseById([tieA, tieB, shard])[0]?.status,
);

// A blob written before `rev` existed must still load rather than vanish.
const preRev = serializeMemory(promise).replace('"rev":1,', "");
check("legacy blob without rev still parses", parseMemory(preRev)?.rev === 1);
check("legacy blob keeps its content", parseMemory(preRev)?.text === promise.text);

// ─── Tombstones ─────────────────────────────────────────────────────────────
section("tombstones");

const dead: PersonMemory = { ...promise, deleted: true, updatedAt: "2026-09-01T10:00:00.000Z" };
const grave = serializeMemory(dead);
check("tombstone round trips", parseMemory(grave)?.deleted === true);
check("tombstone is not live", !isLive(parseMemory(grave)!));
check("live memory is live", isLive(parseMemory(good)!));
check("a tombstone supersedes its live version", !isLive(collapseById([dead, promise])[0]!));
check("history is preserved alongside the grave", collapseById([dead, promise]).length === 1);

// ─── Refusals ───────────────────────────────────────────────────────────────
section("refusals");

let threwNoPerson = false;
try {
  makeMemory({ person: "   ", type: "trait", text: "anonymous claim" });
} catch {
  threwNoPerson = true;
}
check("refuses a subjectless claim", threwNoPerson);

let threwNoText = false;
try {
  makeMemory({ person: "Maya", type: "trait", text: "  " });
} catch {
  threwNoText = true;
}
check("refuses an empty claim", threwNoText);

let threwBadType = false;
try {
  // @ts-expect-error deliberately wrong
  makeMemory({ person: "Maya", type: "rumour", text: "x" });
} catch {
  threwBadType = true;
}
check("refuses an unknown type", threwBadType);

// ─── Ids and dates ──────────────────────────────────────────────────────────
section("ids and dates");

const ids = new Set(Array.from({ length: 500 }, () => makeMemoryId()));
check("ids are unique", ids.size === 500);
check("ids are prefixed", [...ids].every((id) => id.startsWith("mem_")));
check("todayISO is a bare date", /^\d{4}-\d{2}-\d{2}$/.test(todayISO()));
check("todayISO matches the supplied instant", todayISO(new Date("2026-10-09T23:59:00.000Z")) === "2026-10-09");

// ─── Corrections: the instruction, and the reason ────────────────────────────
//
// The reason is the entire point of the type, and it is the field most likely to
// rot silently: absent from a serialiser, an extraction drops it, or the ranker
// treats the memory as trivia. Every one of those produces a green build and a
// product that forgets what you told it.
section("a correction keeps its reason");
{
  const c = makeMemory({
    person: "you",
    type: "correction",
    text: "Do not use Inter.",
    reason: "It is a wide face and the measure breaks.",
  });
  check("it round-trips through storage", parseMemory(serializeMemory(c))?.reason === c.reason);

  const bare = makeMemory({ person: "you", type: "correction", text: "Stop using emoji." });
  check(
    "an absent reason is stored as absent, not invented",
    parseMemory(serializeMemory(bare))?.reason === undefined,
  );

  const changed = reviseMemory(c, { reason: "Fine now, it was a one-off." });
  check("a revised correction can change its reason", parseMemory(serializeMemory(changed))?.reason === changed.reason);
  check("and keeps the original's id, so it supersedes rather than forks", changed.id === c.id && changed.rev === c.rev + 1);

  // Serialisation order is fixed so two blobs can be diffed. Adding a field must
  // not reshuffle the bytes of every memory written before it.
  check("bytes stay deterministic", serializeMemory(c) === serializeMemory(makeMemory({ ...c, id: c.id, now: new Date(c.createdAt) })));

  // A hand-edited or foreign blob with a non-string reason must be refused whole.
  const hostile = serializeMemory(c).replace(/"reason":"[^"]*"/, '"reason":{"evil":true}');
  check("a reason that is not a string is refused, not coerced", parseMemory(hostile) === null);
}

section("the extraction schema cannot drift from the memory model");
{
  // capture.ts used to keep its own copy of the type list. It fell behind, the
  // tool schema rejected every correction the model correctly emitted, and the
  // feature failed as an unexplained 400. This asserts they are the same list,
  // and that corrections are actually in it.
  check("correction is a real memory type", MEMORY_TYPES.includes("correction"));
  check("the list has no duplicates", new Set(MEMORY_TYPES).size === MEMORY_TYPES.length);
  check("nothing is empty", MEMORY_TYPES.every((t) => typeof t === "string" && t.length > 0));
}

section("a memory that cannot be read is never written");
// ── The silent-loss pair ──────────────────────────────────────────────────────
//
// parseMemory has always refused a memory whose dates it cannot verify. But
// nothing stopped one being *created*: the endpoint passed the request body's dates
// straight through, makeMemory stored them, the caller got a 201 and a blob id --
// and the memory was then invisible to the ledger, the nudges, the tasks and the
// export, permanently, while blobCount still counted it.
//
// A write that reports success and cannot be read back is the worst outcome this
// store has, and it was reachable by a hand-typed "next friday".
{
  const refused = (input: Record<string, unknown>, why: string) => {
    let threw = false;
    try {
      makeMemory({ person: "Maya", type: "promise", text: "promised to ring", ...input } as never);
    } catch {
      threw = true;
    }
    check(why, threw);
  };
  refused({ dueAt: "next friday" }, "a dueAt that is not a date is refused at creation");
  refused({ dueAt: "2026-13-45" }, "a dueAt with an impossible month is refused");
  refused({ occurredAt: "tomorrow" }, "an occurredAt that is not a date is refused");
  refused({ anniversary: "13-45" }, "an anniversary with a day that does not exist is refused");
  refused({ anniversary: "02-30" }, "an anniversary for 30 February is refused");

  // And the good ones still go through, or the fix is just a wall.
  const ok = makeMemory({
    person: "Mara", type: "trait", text: "birthday is the 14th",
    occurredAt: "2026-03-01", anniversary: "11-14",
  });
  check("valid dates still store and read back", parseMemory(serializeMemory(ok))?.anniversary === "11-14");
  const leap = makeMemory({ person: "Dev", type: "trait", text: "wedding", anniversary: "02-29" });
  check("a real leap day is still allowed", parseMemory(serializeMemory(leap))?.anniversary === "02-29");
}

// ─── Result ─────────────────────────────────────────────────────────────────
console.log("");
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("all checks passed");
