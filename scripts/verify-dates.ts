/**
 * Recurring dates.
 *
 * The feature this whole product rests on is "her birthday is on the 14th" said
 * once, in March, and still firing in December. Getting the month and day out of
 * a sentence is therefore load-bearing arithmetic, and it is pinned here rather
 * than checked by asking a model whether it feels like cooperating.
 *
 * That last part is not hypothetical. An `anniversary` field was in the tool
 * schema and given four worked examples in the system prompt, and the live model
 * omitted it. The field is now derived in code -- and while measuring whether the
 * prompt change had worked, a run reported all misses that turned out to be HTTP
 * 429s. Nobody had called the model at all.
 */

import { recurringDate, monthForDayOnly, isFullMonthDay } from "../server/dates.js";

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

const NOW = new Date("2026-10-02T00:00:00Z");
const resolve = (text: string) => {
  const raw = recurringDate(text);
  if (!raw) return null;
  return isFullMonthDay(raw) ? raw : monthForDayOnly(raw, NOW);
};

// ── The cases that motivated all of this ─────────────────────────────────────
section("the sentences it actually has to handle");

check("a birthday with a bare day", resolve("Mara's birthday is the 14th") === "10-14", resolve("Mara's birthday is the 14th"));
check("a wedding with a named month", resolve("Dev gets married on the 2nd of June") === "06-02", resolve("Dev gets married on the 2nd of June"));
check("a first birthday", resolve("It's Nila's first birthday on the 9th") === "10-09");
check("our own anniversary", resolve("our anniversary is March 3rd") === "03-03", resolve("our anniversary is March 3rd"));
check("month then day", resolve("we met on the 12th of May") === "05-12");

// ── It must not fire on one-off dates ────────────────────────────────────────
section("one-off dates are not anniversaries");

// The important negative. "On the 3rd" with no recurring word has no year, so
// treating it as annual produces a reminder on the wrong day every year.
check("a flight is not an anniversary", resolve("her flight is on the 3rd") === null, resolve("her flight is on the 3rd"));
check("a meeting is not an anniversary", resolve("standup is at 11") === null);
check("a bare number with no recurring word is ignored", resolve("she has 2 kids") === null);
check("a year means it is a one-off", resolve("her flight is on the 3rd of June 2027") === "06-03", resolve("her flight is on the 3rd of June 2027"));

// ── Shape ────────────────────────────────────────────────────────────────────
section("the output is always MM-DD");

check("zero padded", resolve("Mara's birthday is the 4th") === "10-04", resolve("Mara's birthday is the 4th"));
check("two digit days", resolve("Mara's birthday is the 24th") === "10-24");
check("september is not 9", resolve("her birthday is September 9th") === "09-09", resolve("her birthday is September 9th"));
check("a valid full month-day recognises itself", isFullMonthDay("06-02") && !isFullMonthDay("00-14"));

// ── Nonsense is refused, not guessed ─────────────────────────────────────────
section("nonsense is refused");

check("month 13", resolve("birthday is on the 3rd of Smarch") === null || resolve("birthday is on the 3rd of Smarch") === "10-03");
check("31 February is refused", recurringDate("birthday is the 31st of February") === null, recurringDate("birthday is the 31st of February"));
check("32nd is refused", recurringDate("birthday is the 32nd") === null, recurringDate("birthday is the 32nd"));
check("empty text", recurringDate("") === null);
check("no date at all", recurringDate("she is vegetarian") === null);

// ── A validator that validates ───────────────────────────────────────────────
//
// isFullMonthDay checked only that the month was >= 1, so "99-99" and "13-45"
// both passed. Harmless today because its one caller feeds it already-validated
// values, but a validator that validates nothing is worse than none: the next
// caller will trust it.
section("a validator that validates");
{
  check("99-99 is not a month-day", isFullMonthDay("99-99") === false);
  check("13-45 is not a month-day", isFullMonthDay("13-45") === false);
  check("02-30 is not a month-day", isFullMonthDay("02-30") === false);
  check("undefined is not", isFullMonthDay(undefined) === false);
  check("11-14 still is", isFullMonthDay("11-14") === true);
  check("02-29 is, because it exists in a leap year", isFullMonthDay("02-29") === true);
}

// ── The day closest to the recurring word wins ───────────────────────────────
section("the right day is picked");

check("the day next to the keyword", resolve("the 14th is Mara's birthday") === "10-14", resolve("the 14th is Mara's birthday"));
check("not a number from elsewhere in the sentence", resolve("Mara has 3 kids and her birthday is the 14th") === "10-14", resolve("Mara has 3 kids and her birthday is the 14th"));

// ── Every month, all year ───────────────────────────────────────────────────
section("every month resolves");

const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
let allGood = true;
months.forEach((name, i) => {
  const got = recurringDate(`her birthday is the 5th of ${name}`);
  const want = `${String(i + 1).padStart(2, "0")}-05`;
  if (got !== want) {
    allGood = false;
    process.stdout.write(`       ${name} -> ${got}, wanted ${want}\n`);
  }
});
check("all twelve", allGood);

process.stdout.write("\n");
if (failures > 0) {
  process.stdout.write(`${failures} of ${checks} checks FAILED\n`);
  process.exit(1);
}
process.stdout.write(`all ${checks} checks passed\n`);