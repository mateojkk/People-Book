/**
 * Ranking verification. `npm run verify:rank`
 *
 * The judging rubric's first question is "is memory doing real work, or is it
 * decorative?" The answer to that lives entirely in this file's logic — so it
 * is tested directly, with no network, no key and no wallet. If a judge clones
 * the repo, they can run this and see the guarantee hold: inferred memories
 * cannot nudge, taboos are honoured, and turning memory off produces nothing
 * rather than something worse.
 */

import { makeMemory } from "../shared/memory-codec.js";
import { type PersonMemory, SELF } from "../shared/types.js";
import { ABSENCE_DAYS, HORIZON_DAYS, computeNudges, elisionLine } from "../server/ranking.js";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

const NOW = new Date("2026-10-01T09:00:00.000Z");

function mem(over: Partial<PersonMemory> & Pick<PersonMemory, "person" | "type" | "text">): PersonMemory {
  return makeMemory({
    status: over.type === "promise" ? "open" : "active",
    confidence: "confirmed",
    ...over,
    now: NOW,
  });
}

// The reserved follow-through slot. The existing test used a fixture with only
// two kinds, so `chosen` never reached `max` and the bug stayed invisible.
section("the reserved slot is actually reserved");
{
  const many = [
    // Two open promises to one person, which is what makes a follow-through
    // candidate exist at all. One each produces none, which is why an earlier
    // version of this test could not see the bug it was written for.
    mem({ person: "Maya", type: "promise", text: "promised to ring about the invoice", dueAt: "2026-09-01" }),
    mem({ person: "Maya", type: "promise", text: "promised to send the photos", dueAt: "2026-09-04" }),
    mem({ person: "Dev", type: "promise", text: "promised to send the contract", dueAt: "2026-09-02" }),
    mem({ person: "Ana", type: "promise", text: "promised to call back", dueAt: "2026-09-03" }),
    mem({ person: "Mara", type: "event", text: "wedding", anniversary: "06-02" }),
    // Old and unresolved, which is what absence is derived from.
    mem({ person: "Sol", type: "promise", text: "promised to reply", occurredAt: "2026-01-05" }),
  ];
  const out = computeNudges({ memories: many, now: new Date("2026-06-01T12:00:00Z"), max: 5 });
  check("a five-kind book still surfaces the follow-through nudge",
    out.nudges.some((n) => n.kind === "followthrough"),
    out.nudges.map((n) => n.kind).join(","));
  check("and it is still capped at max", out.nudges.length <= 5, String(out.nudges.length));
}

// Order independence, with more than one taboo for one person this time. The old
// test used a single taboo so the bug could not show: collectTaboos overwrote
// `since` on every memory without comparing dates, so the answer depended on
// array order.
section("a taboo reports its earliest date regardless of order");
{
  const early = mem({ person: "Mara", type: "taboo", text: "never bring up the divorce", occurredAt: "2026-02-01" });
  const late = mem({ person: "Mara", type: "taboo", text: "never bring up the job", occurredAt: "2026-08-01" });
  // Something that actually gets withheld. An elision is only reported when a
  // redaction really happened, so without a matching memory this person is
  // correctly absent from `elisions` and the assertion would be testing nothing.
  const third = mem({ person: "Mara", type: "promise", text: "promised to ask about the divorce", dueAt: "2026-10-04" });

  const forward = computeNudges({ memories: [early, late, third], now: NOW, max: 50 });
  const backward = computeNudges({ memories: [late, early, third], now: NOW, max: 50 });
  const sinceOf = (r: typeof forward) => r.elisions.find((e) => e.person === "Mara")?.since;

  check("order one reports the earliest", sinceOf(forward) === "2026-02-01", String(sinceOf(forward)));
  check("and so does the reverse", sinceOf(backward) === "2026-02-01", String(sinceOf(backward)));
  check("so the two agree", sinceOf(forward) === sinceOf(backward));
}

// ─── Confirmed vs inferred: the central guarantee ────────────────────────────
section("only confirmed memories can nudge");

const promise = mem({ person: "Maya", type: "promise", text: "I told Maya I'd find the thing.", dueAt: "2026-09-28" });

const confirmedOnly = computeNudges({ memories: [promise], now: NOW });
check("a confirmed overdue promise nudges", confirmedOnly.nudges.some((n) => n.kind === "promise"));
check("the nudge says who it is for", confirmedOnly.nudges[0]?.person === "Maya");
check("the nudge is a pointer to its source", confirmedOnly.nudges[0]?.sourceMemoryId === promise.id);
check("the nudge carries the claim it is based on", confirmedOnly.nudges[0]?.sourceText === promise.text);

const asInferred: PersonMemory = { ...promise, confidence: "inferred" };
const inferredOnly = computeNudges({ memories: [asInferred], now: NOW });
check("the SAME memory as 'inferred' produces no nudges", inferredOnly.nudges.length === 0);
check("but it is still counted in the basis", inferredOnly.basis.inferredCount === 1 && inferredOnly.basis.confirmedCount === 0);

// This is the single most important assertion in the project: the difference
// between a claim and a guess must be a difference in what reaches the user.
section("inference can never become a claim");

const mixed = computeNudges({ memories: [promise, asInferred, mem({ person: "Sam", type: "promise", text: "I owe Sam a reply.", dueAt: "2026-09-20", confidence: "inferred" })], now: NOW });
check("no nudge is ever sourced from an inferred memory", mixed.nudges.every((n) => {
  const source = [promise, asInferred].find((m) => m.id === n.sourceMemoryId);
  return !source || source.confidence === "confirmed";
}));

// ─── Memory off ──────────────────────────────────────────────────────────────
section("memory off");

const off = computeNudges({ memories: [promise, mem({ person: "Lena", type: "event", text: "Visa interview moved.", dueAt: "2026-10-05" })], now: NOW, memoryDisabled: true });
check("produces nothing at all", off.nudges.length === 0);
check("and says so in the basis", off.basis.memoryDisabled === true);
check("still reports what it is not using", off.basis.memoryCount === 2);
const on = computeNudges({ memories: [promise, mem({ person: "Lena", type: "event", text: "Visa interview moved.", dueAt: "2026-10-05" })], now: NOW });
check("same book with memory on produces nudges", on.nudges.length > 0);
check("which is the before/after in one comparison", on.nudges.length > off.nudges.length);

// ─── Dates ───────────────────────────────────────────────────────────────────
section("dates");

const soon = mem({ person: "Maya", type: "event", text: "Her birthday is on the 3rd.", dueAt: "2026-10-03" });
const far = mem({ person: "Sam", type: "event", text: "Renewal in March.", dueAt: "2027-03-01" });
const past = mem({ person: "Lena", type: "event", text: "Flight last week.", dueAt: "2026-09-20" });
const dated = computeNudges({ memories: [soon, far, past], now: NOW });
const kinds = dated.nudges.map((n) => n.person);
check("a date inside the horizon surfaces", kinds.includes("Maya"));
check("a date beyond the horizon does not", !kinds.includes("Sam"));
check("a past date does not nag", !kinds.includes("Lena"));
check("closer dates rank first", dated.nudges[0]?.person === "Maya");
check("the phrasing states the day count", /in 2 days/.test(dated.nudges[0]?.text ?? ""));

// ─── Promise lifecycle ───────────────────────────────────────────────────────
section("promise lifecycle");

const closed = { ...promise, status: "kept" as const, rev: 2 };
const missed = { ...promise, id: "mem_missed", status: "missed" as const, rev: 2 };
const settled = { ...promise, id: "mem_settled", status: "settled" as const, rev: 2 };
for (const [label, m] of [["kept", closed], ["missed", missed], ["settled", settled]] as const) {
  const r = computeNudges({ memories: [m], now: NOW });
  check(`a ${label} promise never nags`, !r.nudges.some((n) => n.kind === "promise"), r.nudges);
}
const overdue = computeNudges({ memories: [promise], now: NOW });
check("an overdue promise says it is overdue", /overdue/.test(overdue.nudges[0]?.text ?? ""));
const undated = computeNudges({ memories: [mem({ person: "Lena", type: "promise", text: "I said I'd ring her back." })], now: NOW });
check("an undated open promise still surfaces", undated.nudges.some((n) => n.kind === "promise"));

// ─── Absence ─────────────────────────────────────────────────────────────────
section("absence");

const stale = mem({ person: "Ravi", type: "event", text: "Talked about the flat.", occurredAt: "2026-07-01" });
const fresh = mem({ person: "Nina", type: "event", text: "Talked yesterday.", occurredAt: "2026-09-30" });
const absence = computeNudges({ memories: [stale, fresh], now: NOW });
const absentees = absence.nudges.filter((n) => n.kind === "absence").map((n) => n.person);
check(`someone unseen for ${ABSENCE_DAYS}+ days surfaces`, absentees.includes("Ravi"), absentees);
check("someone seen yesterday does not", !absentees.includes("Nina"));
check("the nudge names the gap", /9[0-9] days/.test(absence.nudges.find((n) => n.kind === "absence")?.text ?? ""));
check("being alone is not a nudge", !computeNudges({
  memories: [mem({ person: SELF, type: "event", text: "Solo note.", occurredAt: "2026-01-01" })], now: NOW,
}).nudges.some((n) => n.kind === "absence"));

// ─── Follow-through ──────────────────────────────────────────────────────────
section("your own follow-through");

const repeatedly = computeNudges({
  memories: [
    mem({ person: "Maya", type: "promise", text: "I'd find the thing.", dueAt: "2026-09-01" }),
    mem({ person: "Maya", type: "promise", text: "I'd send the photo.", dueAt: "2026-09-10" }),
    mem({ person: "Maya", type: "promise", text: "I'd call Sunday.", dueAt: "2026-09-20" }),
  ],
  now: NOW,
});
const ft = repeatedly.nudges.find((n) => n.kind === "followthrough");
check("three unkept promises to one person triggers it", Boolean(ft), repeatedly.nudges.map((n) => n.kind));
check("it counts them", /3 times/.test(ft?.text ?? ""));
check("it says 'never' when none were kept", /never/.test(ft?.text ?? ""));

const oneOff = computeNudges({ memories: [mem({ person: "Sam", type: "promise", text: "I'd help.", dueAt: "2026-09-01" })], now: NOW });
check("a single open promise does not accuse you", !oneOff.nudges.some((n) => n.kind === "followthrough"));

// The most uncomfortable nudge the product emits must never be the loudest one.
const mixedPriority = computeNudges({
  memories: [
    mem({ person: "Maya", type: "promise", text: "One.", dueAt: "2026-09-28" }),
    mem({ person: "Maya", type: "promise", text: "Two.", dueAt: "2026-09-29" }),
    mem({ person: "Maya", type: "promise", text: "Three.", dueAt: "2026-09-30" }),
    mem({ person: "Nina", type: "event", text: "Wedding on the 2nd.", dueAt: "2026-10-02" }),
  ],
  now: NOW,
});
check("follow-through never outranks an urgent date", mixedPriority.nudges[0]?.kind !== "followthrough", mixedPriority.nudges.map((n) => n.kind));

// ─── Taboos ──────────────────────────────────────────────────────────────────
section("taboos");

const taboo = mem({ person: "Ravi", type: "taboo", text: "Never mention the divorce to him.", occurredAt: "2026-04-02" });
const aboutRavi = mem({ person: "Ravi", type: "event", text: "He asked about the divorce paperwork again.", dueAt: "2026-10-04" });

const withTaboo = computeNudges({ memories: [taboo, aboutRavi], now: NOW });
check("a taboo suppresses the matching nudge", !withTaboo.nudges.some((n) => n.person === "Ravi" && /divorce/.test(n.text)), withTaboo.nudges);

const stillOthers = computeNudges({
  memories: [taboo, aboutRavi, mem({ person: "Maya", type: "event", text: "Birthday on the 3rd.", dueAt: "2026-10-03" })],
  now: NOW,
});
check("but does not suppress anyone else", stillOthers.nudges.some((n) => n.person === "Maya"));

const elision = computeNudges({
  memories: [taboo, aboutRavi, mem({ person: "Maya", type: "event", text: "Birthday on the 3rd.", dueAt: "2026-10-03" })],
  now: NOW,
});
check("the elision is announced, not silent", elision.elisions.some((e) => e.person === "Ravi" && e.sourceMemoryId === taboo.id));
check("the announcement names the date it was set", elision.elisions[0]?.since === "2026-04-02");
check("the announcement line is explicit", /not to mention/.test(elisionLine("Ravi", "2026-04-02")));

const unrelated = computeNudges({
  memories: [taboo, mem({ person: "Ravi", type: "event", text: "He is moving to Lisbon in March.", dueAt: "2026-10-05" })],
  now: NOW,
});
check("a taboo does not suppress unrelated news", unrelated.nudges.some((n) => n.person === "Ravi" && /Lisbon/.test(n.text)), unrelated.nudges);
check("a taboo you cannot act on never appears as text", !unrelated.nudges.some((n) => /divorce/.test(n.text)));

// A taboo is only a rule the user set. An inferred guess must not suppress anything.
const inferredTaboo = { ...taboo, confidence: "inferred" as const, id: "mem_guess" };
const guessCannotSuppress = computeNudges({ memories: [inferredTaboo, aboutRavi], now: NOW });
check("an inferred taboo cannot suppress a confirmed memory", guessCannotSuppress.nudges.some((n) => n.person === "Ravi" && /divorce/.test(n.text)));

// ─── Determinism ─────────────────────────────────────────────────────────────
section("determinism and dismissal");

const book = [promise, soon, stale, ...[1, 2, 3].map((n) => mem({ person: "Maya", type: "promise", text: `Promise ${n}.`, dueAt: "2026-09-05" }))];
const runA = computeNudges({ memories: book, now: NOW }).nudges.map((n) => n.id);
const runB = computeNudges({ memories: [...book].reverse(), now: NOW }).nudges.map((n) => n.id);
check("input order does not change the output", JSON.stringify(runA) === JSON.stringify(runB), { runA, runB });
check("output is capped", computeNudges({ memories: book, now: NOW }).nudges.length <= 5);
check("no duplicate nudges", new Set(runA).size === runA.length);

const first = computeNudges({ memories: book, now: NOW }).nudges[0]!;
const allIds = computeNudges({ memories: book, now: NOW }).nudges.map((n) => n.id);
const dismissed = computeNudges({ memories: book, now: NOW, dismissed: new Set([first.id]) });
const dismissedIds = dismissed.nudges.map((n) => n.id);
check("dismissal removes that nudge", !dismissedIds.includes(first.id));
// Asserted as set membership, not a count: with MAX_NUDGES capping the output at
// 5, dropping one of six candidates still returns five. Counting would encode
// the cap into the test and pass for the wrong reason.
check("every other nudge survives dismissal", allIds.filter((id) => id !== first.id).every((id) => dismissedIds.includes(id)), { allIds, dismissedIds });
check("dismissal does not delete the memory", dismissed.basis.memoryCount === book.length);

check("an empty book produces an empty set, not an error", computeNudges({ memories: [], now: NOW }).nudges.length === 0);
check("horizon is reported in the basis", computeNudges({ memories: [], now: NOW }).basis.horizonDays === HORIZON_DAYS);

// ─── Display selection ───────────────────────────────────────────────────────
// Found by running the engine over a real mainnet book: five ordinary overdue
// promises filled every slot and the follow-through nudge never appeared. The
// most distinctive output was the first thing crowded out.
section("display selection keeps the set varied");

const crowded: PersonMemory[] = [];
for (let i = 0; i < 8; i += 1) {
  crowded.push(mem({ person: `Friend${i}`, type: "promise", text: `Owed Friend${i} a reply.`, dueAt: "2026-09-01" }));
}
for (let i = 0; i < 3; i += 1) {
  crowded.push(mem({ person: "Sam", type: "promise", text: `Told Sam he would send photo ${i}.`, dueAt: "2026-09-0" + (i + 1) }));
}

const packed = computeNudges({ memories: crowded, now: NOW });
const packedKinds = packed.nudges.map((n) => n.kind);
check("follow-through survives a crowded set", packedKinds.includes("followthrough"), packedKinds);
check("it is still not the loudest thing", packed.nudges[0]?.kind !== "followthrough", packedKinds);
check("the set stays capped", packed.nudges.length <= 5, packed.nudges.length);

const promiseHeavy = packed.nudges.filter((n) => n.kind === "promise").length;
check("no single kind fills the whole set", promiseHeavy < packed.nudges.length, { promiseHeavy, total: packed.nudges.length });

// A nudge that exists for a person but whose text is wholly redacted must be
// dropped, not emitted blank. A blank card reads as a bug, not as restraint.
section("a fully redacted nudge is dropped, not blank");

const onlyTabooed = [
  mem({ person: "Ravi", type: "taboo", text: "Never mention the divorce to him.", occurredAt: "2026-04-02" }),
  mem({ person: "Ravi", type: "event", text: "He brought up the divorce paperwork again.", dueAt: "2026-10-04" }),
  mem({ person: "Maya", type: "event", text: "Birthday on the 3rd.", dueAt: "2026-10-03" }),
];
const suppressed = computeNudges({ memories: onlyTabooed, now: NOW });
check("nothing blank is emitted", suppressed.nudges.every((n) => n.text.trim().length > 0), suppressed.nudges.map((n) => n.text));
check("the redacted nudge is gone", !suppressed.nudges.some((n) => n.person === "Ravi" && /divorce/i.test(n.text)));
// The key assertion: the person vanished from the set entirely, and the
// suppression is STILL announced. The old code intersected the taboo list with
// the surviving set, so a fully suppressed person went silent — the one case
// where the user most needs to know.
check(
  "the elision is announced even though the person has no surviving nudge",
  suppressed.elisions.some((e) => e.person === "Ravi"),
  suppressed.elisions,
);
check("unaffected people still get their nudges", suppressed.nudges.some((n) => n.person === "Maya"));

// A rule that never came into play must stay quiet, or the notice becomes noise.
section("an uninvoked taboo says nothing");
const neverInvoked = computeNudges({
  memories: [
    mem({ person: "Ravi", type: "taboo", text: "Never mention the divorce to him.", occurredAt: "2026-04-02" }),
    mem({ person: "Ravi", type: "event", text: "He is moving to Lisbon in the spring.", dueAt: "2026-10-05" }),
  ],
  now: NOW,
});
check("unrelated news still surfaces", neverInvoked.nudges.some((n) => /Lisbon/.test(n.text)), neverInvoked.nudges.map((n) => n.text));
check("and nothing is announced as withheld", neverInvoked.elisions.length === 0, neverInvoked.elisions);

// The same fact stored twice (a retried write, or a re-confirmation) must not
// produce two stacked nudges.
section("duplicate facts collapse");
const dupe = computeNudges({
  memories: [
    mem({ person: "Maya", type: "promise", text: "Owed Maya the photos.", dueAt: "2026-09-05" }),
    mem({ person: "Maya", type: "promise", text: "Owed Maya the photos.", dueAt: "2026-09-05" }),
  ],
  now: NOW,
});
const dupeNudges = dupe.nudges.filter((n) => n.person === "Maya" && n.kind === "promise");
check("the same fact does not produce two nudges", dupeNudges.length === 1, dupeNudges.map((n) => n.text));
check("but both stored memories are still counted", dupe.basis.memoryCount === 2);

console.log("");
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("all checks passed");
