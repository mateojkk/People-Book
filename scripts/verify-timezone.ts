/**
 * "Today" has to mean today where the user is.
 *
 * Every date in this app was computed as `now.toISOString().slice(0, 10)`, which
 * is UTC. That is wrong for anyone whose evening crosses midnight -- at 11pm in
 * London it is already tomorrow in UTC, so a birthday arrives a day early and an
 * overdue promise is counted a day late. A companion that says someone's
 * birthday is tomorrow, on the day before, is worse than one that says nothing.
 */
import { todayISO } from "../shared/memory-codec.js";

let failures = 0;
let checks = 0;
function section(n: string) { console.log(`\n${n}`); }
function check(label: string, ok: boolean, detail = "") {
  checks++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

// 23:30 on 2 October. In London that is still the 2nd; in UTC it is the 3rd
// only after 01:00, so use a zone far enough ahead to straddle it.
const late = new Date("2026-10-02T23:30:00.000Z");

section("the bug");
{
  check("UTC says the 2nd", todayISO(late) === "2026-10-02", todayISO(late));
}

section("zones ahead of UTC");
{
  check("Tokyo is already the 3rd", todayISO(late, "Asia/Tokyo") === "2026-10-03", todayISO(late, "Asia/Tokyo"));
  check("Sydney is the 3rd", todayISO(late, "Australia/Sydney") === "2026-10-03", todayISO(late, "Australia/Sydney"));
}

section("zones behind UTC");
{
  // 02:00 on the 3rd in UTC; still the 2nd in New York and Los Angeles.
  const early = new Date("2026-10-03T02:00:00.000Z");
  check("UTC says the 3rd", todayISO(early) === "2026-10-03", todayISO(early));
  check("New York is still the 2nd", todayISO(early, "America/New_York") === "2026-10-02", todayISO(early, "America/New_York"));
  check("Los Angeles is still the 2nd", todayISO(early, "America/Los_Angeles") === "2026-10-02", todayISO(early, "America/Los_Angeles"));
}

section("a zone that has a DST rule");
{
  // The reason a fixed offset would be wrong and Intl is right: New York is
  // UTC-4 in October and UTC-5 in January.
  check("New York in October is the 3rd at 02:00Z", todayISO(new Date("2026-10-03T02:00:00.000Z"), "America/New_York") === "2026-10-02");
  check("and in January it is still the 2nd", todayISO(new Date("2026-01-03T02:00:00.000Z"), "America/New_York") === "2026-01-02", todayISO(new Date("2026-01-03T02:00:00.000Z"), "America/New_York"));
}

section("the shape is always YYYY-MM-DD");
{
  for (const zone of ["UTC", "Asia/Kolkata", "Pacific/Auckland", "America/Sao_Paulo"]) {
    check(`${zone} is zero padded`, /^\d{4}-\d{2}-\d{2}$/.test(todayISO(late, zone)), todayISO(late, zone));
  }
}

section("a bad zone must not take a notification engine down");
{
  check("nonsense falls back to UTC", todayISO(late, "Not/AZone") === todayISO(late), todayISO(late, "Not/AZone"));
  check("empty string falls back too", todayISO(late, "") === todayISO(late));
  check("undefined falls back too", todayISO(late, undefined) === todayISO(late));
}

section("year boundaries");
{
  check("new year in Tokyo", todayISO(new Date("2025-12-31T15:00:00.000Z"), "Asia/Tokyo") === "2026-01-01", todayISO(new Date("2025-12-31T15:00:00.000Z"), "Asia/Tokyo"));
  check("new year in New York", todayISO(new Date("2026-01-01T02:00:00.000Z"), "America/New_York") === "2025-12-31", todayISO(new Date("2026-01-01T02:00:00.000Z"), "America/New_York"));
}

console.log("");
if (failures > 0) { console.log(`${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`all ${checks} checks passed`);
