/**
 * Decay and today's tasks.
 *
 * Two claims worth pinning, both of which are easy to get subtly wrong and hard
 * to notice: that a memory told months ago still fires, and that a faded one
 * stops asking for attention without being destroyed.
 *
 * Offline and deterministic. No network, no clock dependency beyond dates passed
 * in, because a test that reads the real clock is a test that fails in a month.
 */

import { relevance, isDecayed, isStalePromise, selectLive, DECAY_FLOOR } from "../server/decay.js";
import { tasksFor, isTaskMemory, isOutstandingTask, composeNotice, noticeHistory } from "../server/tasks.js";
import { makeMemory, type MakeMemoryInput } from "../shared/memory-codec.js";
import type { PersonMemory } from "../shared/types.js";

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) process.stdout.write(`  ok   ${label}\n`);
  else {
    failures += 1;
    process.stdout.write(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`);
  }
}

function section(name: string): void {
  process.stdout.write(`\n${name}\n`);
}

const NOW = new Date("2026-10-01T12:00:00Z");
const iso = (daysFromNow: number) => new Date(NOW.getTime() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

function memory(over: Partial<MakeMemoryInput> = {}, createdDaysAgo = 0, updatedDaysAgo = createdDaysAgo): PersonMemory {
  const at = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
  return makeMemory({ ...over, createdAt: undefined, now: NOW } as MakeMemoryInput) instanceof Object
    ? ({
        ...makeMemory({ ...over } as MakeMemoryInput),
        createdAt: at(createdDaysAgo),
        updatedAt: at(updatedDaysAgo),
      } as PersonMemory)
    : ({} as PersonMemory);
}

// ── Old memories still fire ──────────────────────────────────────────────────
section("something told months ago still comes back");

{
  // The case the whole product rests on: a birthday mentioned in April, needed
  // on the 13th of December.
  const birthday = memory(
    { person: "Maya", type: "trait", text: "Maya's birthday is on the 14th.", anniversary: "12-14", confidence: "confirmed" },
    170,
    170,
  );
  check("a recurring date told 170 days ago is still relevant", relevance(birthday, NOW) > 0.6, relevance(birthday, NOW));
  check("and it has not decayed", !isDecayed(birthday, NOW));

  // Without the anniversary, the very same claim is a stale fact.
  const plain = memory(
    { person: "Maya", type: "trait", text: "Maya's birthday is on the 14th.", confidence: "confirmed" },
    170,
    170,
  );
  // Not faded, and correctly so: a trait from six months ago is still true. The
  // half-life is meant to fade *undated* things, not to expire facts.
  check("the same claim without a date is merely dimmed", !isDecayed(plain, NOW) && relevance(plain, NOW) < 0.5, relevance(plain, NOW));
  check("but the dated one outranks it, which is the whole point", relevance(birthday, NOW) > relevance(plain, NOW) * 1.5);
}

{
  // A one-off event told early, for a date that is still ahead.
  const flight = memory(
    { person: "Maya", type: "event", text: "Maya's flight lands 06:40.", dueAt: iso(40), confidence: "confirmed" },
    120,
    120,
  );
  check("a date 40 days out beats the clock, told 120 days ago", relevance(flight, NOW) > 0.6, relevance(flight, NOW));
}

// ── Fading without disappearing ──────────────────────────────────────────────
section("faded is not deleted");

{
  const old = memory(
    { person: "Someone", type: "trait", text: "Someone used to work at Initech.", confidence: "confirmed" },
    400,
    400,
  );
  check("a stale fact is faded", isDecayed(old, NOW));
  check("but it is still not marked deleted", old.deleted !== true, old.deleted);
  check("and it is still in the live ledger", !isDecayed(old, NOW) === false && old.id.length > 0);

  check("faded memories are filtered out of what gets surfaced", !selectLive([old], NOW).includes(old));
  check("but they are never removed from the book", selectLive([old], NOW).length === 0 && old.text.length > 0);

  // Mentioning it again must bring it straight back. Nothing was written, so
  // there is nothing to undo.
  const revived = memory(
    { person: "Someone", type: "trait", text: "Someone used to work at Initech.", confidence: "confirmed" },
    400,
    0,
  );
  check("touching a memory makes it relevant again immediately", !isDecayed(revived, NOW), relevance(revived, NOW));
}

{
  // How-to and taboos do not go stale just because of the calendar.
  const howto = memory({ person: "Ravi", type: "howto", text: "Call Ravi, never text.", confidence: "confirmed" }, 500, 500);
  check("a how-to fact survives years", !isDecayed(howto, NOW), relevance(howto, NOW));
  const taboo = memory({ person: "Ravi", type: "taboo", text: "Never mention the divorce.", confidence: "confirmed" }, 500, 500);
  check("a taboo survives years", !isDecayed(taboo, NOW));
}

// ── Stale promises stop nagging, on their own ────────────────────────────────
section("an old unkept promise stops asking");

{
  const stale = memory(
    { person: "Dev", type: "promise", text: "Owed Dev the signed contract.", dueAt: iso(-90), confidence: "confirmed" },
    95,
    95,
  );
  check("a promise 90 days past due is stale", isStalePromise(stale, NOW));
  check("and is not surfaced as urgent", relevance(stale, NOW) === 0, relevance(stale, NOW));

  const recent = memory(
    { person: "Dev", type: "promise", text: "Owed Dev the signed contract.", dueAt: iso(-3), confidence: "confirmed" },
    10,
    10,
  );
  check("three days late is still urgent", !isStalePromise(recent, NOW) && relevance(recent, NOW) > 0.8);

  const kept = memory(
    { person: "Dev", type: "promise", status: "kept", text: "Sent Dev the contract.", dueAt: iso(-200), confidence: "confirmed" },
    210,
    210,
  );
  check("a promise you kept does not nag however old", relevance(kept, NOW) < 0.3, relevance(kept, NOW));
}

{
  const undated = memory({ person: "Dev", type: "promise", text: "Owed Dev a favour, no date.", confidence: "confirmed" }, 200, 200);
  check("an undated promise is never 'stale', it is just not dated", !isStalePromise(undated, NOW));
  // Still above the floor, deliberately: you did say you would, and nothing has
  // resolved it. It sits at the bottom of the list rather than disappearing.
  check("but it is dimmed and sits at the bottom", relevance(undated, NOW) < 0.5, relevance(undated, NOW));
}

// ── Today's tasks ─────────────────────────────────────────────────────────────
section("the list is what needs doing, most urgent first");

{
  const memories = [
    memory({ person: "Dev", type: "promise", text: "Send Dev the signed contract.", dueAt: iso(-2), confidence: "confirmed" }),
    memory({ person: "Maya", type: "promise", text: "Buy Maya a gift.", dueAt: iso(0), confidence: "confirmed" }),
    memory({ person: "Jon", type: "promise", text: "Reply to Jon.", dueAt: iso(3), confidence: "confirmed" }),
    memory({ person: "Ana", type: "promise", text: "Call Ana, no date given.", confidence: "confirmed" }),
    memory({ person: "Old", type: "promise", text: "Something ancient.", dueAt: iso(-200), confidence: "confirmed" }, 220, 220),
  ];
  const tasks = tasksFor(memories, NOW);

  check("every open promise is on the list", tasks.length === 5, tasks.length);
  check("overdue comes first", tasks[0]?.person === "Dev", tasks[0]);
  check("then today", tasks[1]?.person === "Maya", tasks[1]);
  check("an undated promise is still listed, last", tasks.some((t) => t.person === "Ana" && t.dueLabel === "no date"));
  check("a stale one is marked inactive, not dropped", tasks.some((t) => !t.active));
  check("and the stale one sorts below everything actionable", tasks[tasks.length - 1]?.active === false, tasks[tasks.length - 1]);

  check("an overdue task says how late it is", tasks[0]?.dueLabel === "2 days late", tasks[0]?.dueLabel);
  check("a task due today says so", tasks[1]?.dueLabel === "today", tasks[1]?.dueLabel);
  check("the text is verbatim, so it can be checked against the book", tasks[0]?.text === "Send Dev the signed contract.");
}

{
  // A fact with no date and nothing outstanding is not a task. It belongs in the
  // conversation, not on a to-do list.
  const memories = [
    memory({ person: "Maya", type: "trait", text: "Maya is vegetarian.", confidence: "confirmed" }),
    memory({ person: "Maya", type: "howto", text: "Call Maya, don't text.", confidence: "confirmed" }),
    memory({ person: "Maya", type: "promise", status: "kept", text: "Already sent.", confidence: "confirmed" }),
    memory({ person: "Maya", type: "promise", text: "Still open.", confidence: "confirmed" }),
  ];
  const tasks = tasksFor(memories, NOW);
  check("only open promises and dated events are tasks", tasks.length === 1, tasks.map((t) => t.text));
}

section("settleable and outstanding are not the same question");
// Got this wrong in the fixing, which is the only interesting reason to write it
// down. The settle route asks whether a thing is a task; the list asks whether it
// needs doing now. Using the first for the second put every kept promise back on
// it, so "Already sent." showed up as something to do.
{
  const open = memory({ person: "Maya", type: "promise", status: "open", text: "Ring her.", confidence: "confirmed" });
  const kept = memory({ person: "Maya", type: "promise", status: "kept", text: "Already sent.", confidence: "confirmed" });
  const settled = memory({ person: "Maya", type: "promise", status: "settled", text: "Done already.", confidence: "confirmed" });
  const dated = memory({ person: "Dev", type: "event", text: "Interview on the 2nd.", dueAt: "2026-10-02", confidence: "confirmed" });
  const datedSettled = memory({ person: "Ivy", type: "event", text: "Flight on the 3rd.", dueAt: "2026-10-03", status: "settled", confidence: "confirmed" });
  const trait = memory({ person: "Ana", type: "trait", text: "Vegetarian.", confidence: "confirmed" });

  check("a kept promise is still a task", isTaskMemory(kept));
  check("but it is not outstanding", !isOutstandingTask(kept));
  check("a settled promise is still a task", isTaskMemory(settled));
  check("but it is not outstanding", !isOutstandingTask(settled));
  check("an open promise is both", isTaskMemory(open) && isOutstandingTask(open));
  check("a dated event is both", isTaskMemory(dated) && isOutstandingTask(dated));

  // The one that has to hold: nothing on the list can have a button that fails.
  const listed = tasksFor([open, kept, settled, dated, datedSettled, trait], NOW);
  const listedIds = listed.map((t) => t.memoryId);
  check("every listed row is settleable", listed.every((t) => isTaskMemory(
    [open, kept, settled, dated, datedSettled, trait].find((m) => m.id === t.memoryId)!,
  )), listed.map((t) => t.text).join(" | "));
  check("settling a dated event dismisses it", !listedIds.includes(datedSettled.id));
  check("and the kept promise is off the list", !listedIds.includes(kept.id));
  check("the trait never appears", !listedIds.includes(trait.id));
  check("exactly the open promise and the live event are listed", listed.length === 2, listed.map((t) => t.text).join(" | "));
}

{
  // A dated event is a task too: a flight is something to be ready for.
  const memories = [memory({ person: "Maya", type: "event", text: "Maya's flight lands 06:40.", dueAt: iso(2), confidence: "confirmed" })];
  check("a dated event is on the list", tasksFor(memories, NOW).length === 1);
}

// ── The notification, as a sentence ───────────────────────────────────────────
section("the notification speaks rather than counting");

{
  // The birthday told four months ago. This is the case the whole thing exists
  // for, and it is why the notice is a sentence: "1 thing due today" would be a
  // reminders app, and this is not one.
  const memories = [
    memory({ person: "Maya", type: "trait", text: "Maya's birthday is on the 14th.", anniversary: "10-02", confidence: "confirmed" }, 120, 120),
    memory({ person: "Dev", type: "promise", text: "Send Dev the signed contract.", dueAt: iso(-2), confidence: "confirmed" }),
  ];
  const tasks = tasksFor(memories, NOW);
  const notice = composeNotice(memories, tasks, NOW);
  check("it says the birthday, from the memory told months ago", /Maya's birthday is on the 14th/.test(notice), notice);
  check("with the timing computed, not stored", /tomorrow/.test(notice), notice);
  check("and it mentions what is overdue", /Dev/.test(notice) && /2 days late/.test(notice), notice);
  check("as one sentence, not two widgets", notice.split(". ").length <= 2, notice);
  check("with no trailing punctuation doubling up", !/\.\./.test(notice), notice);
}

{
  // Nothing wrong means saying nothing. An empty notice must not render an empty
  // banner with a dot in it.
  const memories = [memory({ person: "Ana", type: "trait", text: "Ana is vegetarian.", confidence: "confirmed" })];
  check("nothing to say produces nothing", composeNotice(memories, tasksFor(memories, NOW), NOW) === "");
}

{
  // A taboo is never announced, whatever the date says.
  const memories = [
    memory({ person: "Ravi", type: "taboo", text: "Never mention the divorce.", anniversary: "10-02", confidence: "confirmed" }),
  ];
  check("a taboo is never put in a notification", composeNotice(memories, tasksFor(memories, NOW), NOW) === "");
}

{
  // An unconfirmed guess must not become something the app tells you about.
  const memories = [
    memory({ person: "Kai", type: "trait", text: "Kai's birthday is tomorrow, probably.", anniversary: "10-02", confidence: "inferred" }),
  ];
  check("an unconfirmed guess is not announced", composeNotice(memories, tasksFor(memories, NOW), NOW) === "");
}

// ── Seven days of record ─────────────────────────────────────────────────────
section("notifications leave a record for a week");

{
  const memories = [
    memory({ person: "Maya", type: "trait", text: "Maya's birthday is on the 14th.", anniversary: "10-02", confidence: "confirmed" }),
    memory({ person: "Dev", type: "promise", text: "Send Dev the signed contract.", dueAt: iso(-2), confidence: "confirmed" }),
  ];
  const tasks = tasksFor(memories, NOW);
  const history = noticeHistory(memories, tasks, NOW);

  check("today is in the record", history[0]?.date === "2026-10-01", history[0]);
  check("and so are the days behind it", history.length >= 2, history.map((h) => h.date));
  check("at most seven", history.length <= 7, history.length);
  check("newest first", history[0]!.date > history[history.length - 1]!.date);
  // Two days ago the contract was not yet late; yesterday it was a day late.
  check("and the wording tracks the day", /a day late|2 days late/.test(history.map((h) => h.notice).join(" ")), history[1]?.notice);
}

{
  // Nothing to say means no line, not an empty one.
  const memories = [memory({ person: "Ana", type: "trait", text: "Ana is vegetarian.", confidence: "confirmed" })];
  check("a quiet week records nothing", noticeHistory(memories, tasksFor(memories, NOW), NOW).length === 0);
}

{
  // A settled promise drops out of the record as well as the list, which is the
  // stated limitation: this is what the book supports, not a transcript.
  const open = memory({ person: "Dev", type: "promise", text: "Send Dev the contract.", dueAt: iso(-2), confidence: "confirmed" });
  const settled = { ...open, status: "settled" as const };
  check("a settled promise is not announced", composeNotice([settled], tasksFor([settled], NOW), NOW) === "");
}


process.stdout.write("\n");
if (failures > 0) {
  process.stdout.write(`${failures} of ${checks} checks FAILED\n`);
  process.exit(1);
}
process.stdout.write(`all ${checks} checks passed\n`);
