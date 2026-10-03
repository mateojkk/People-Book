/**
 * The unread badge.
 *
 * The distinction being protected: a badge that counts what you have not SEEN
 * (clears when you look) versus one that counts what needs DOING (never clears).
 * The response already carries `dueCount` for the second thing, and conflating
 * them is how you get a badge people learn to ignore.
 */
export {};

let failures = 0;
let checks = 0;
function section(n: string) { console.log(`\n${n}`); }
function check(label: string, ok: boolean, detail = "") {
  checks++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

// A localStorage stand-in, because the module under test reads the real one.
const store = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

const { seenAt, markSeen, unreadCount, badgeLabel, SEEN_EVENT } = await import("../src/lib/unread.ts");

section("before it has ever been opened");
{
  const dates = ["2026-10-02", "2026-10-01", "2026-09-30"];
  check("everything on file counts", unreadCount(dates) === 3, String(unreadCount(dates)));
  check("not zero, though -- never-opened is not read", unreadCount(dates) > 0);
  check("and seenAt is null", seenAt() === null);
}

section("opening it clears the badge");
{
  store.clear();
  // Backdate the "seen" marker so the dates above are in the past.
  store.set("pb.notifications.seenAt.v1", new Date(Date.now() + 60_000).toISOString());
  check("all seen", unreadCount(["2026-10-02", "2026-10-01"]) === 0, String(unreadCount(["2026-10-02"])));
  check("a notification from later still counts", unreadCount(["2099-01-01"]) === 1);
}

section("a notification that arrived while the tab was closed");
{
  store.clear();
  store.set("pb.notifications.seenAt.v1", "2026-10-02T12:00:00.000Z");
  // Compared on the notification's own date, not on fetch time, or anything
  // generated while the tab was shut would be silently marked read.
  check("older than seen does not count", unreadCount(["2026-10-01T09:00:00.000Z"]) === 0);
  check("newer than seen does", unreadCount(["2026-10-03T09:00:00.000Z"]) === 1);
  check("and a mixed set counts only the new one", unreadCount(["2026-10-01T09:00:00.000Z", "2026-10-03T09:00:00.000Z"]) === 1);
}

section("marking seen");
{
  store.clear();
  markSeen();
  check("it records something", typeof seenAt() === "string");
  check("and the badge is then zero", unreadCount(["2026-10-02"]) === 0);
}

section("the label");
{
  check("1 is 1", badgeLabel(1) === "1");
  check("9 is 9", badgeLabel(9) === "9");
  check("100 caps at 9… no: at 99+", badgeLabel(100) === "99+", badgeLabel(100));
  check("and the count itself caps at 99", unreadCount(new Array(200).fill("2099-01-01")) === 99);
}

section("a corrupt marker must not break the rail");
{
  store.set("pb.notifications.seenAt.v1", "not a date");
  check("garbage reads as never-seen, not as a crash", seenAt() === null);
  check("so everything counts", unreadCount(["2026-10-02"]) === 1);
}

section("storage that throws");
{
  const original = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
  } as unknown as Storage;
  let threw = false;
  try { markSeen(); seenAt(); } catch { threw = true; }
  check("private browsing does not take the rail down", !threw);
  (globalThis as { localStorage?: Storage }).localStorage = original;
}

section("it announces itself to the rail");
{
  // The module dispatches on `window`, and this runs in node, so `window` has to
  // exist for the assertion to mean anything. Asserted properly rather than
  // skipped: the whole point of the event is that the rail clears without a
  // refetch, and that is exactly the thing a silent rename would break.
  const bus = new EventTarget();
  (globalThis as { window?: unknown }).window = bus;
  let fired = 0;
  bus.addEventListener(SEEN_EVENT, () => { fired++; });
  markSeen();
  check("an event is emitted so the rail can clear live", fired === 1, String(fired));
  delete (globalThis as { window?: unknown }).window;
}

console.log("");
if (failures > 0) { console.log(`${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`all ${checks} checks passed`);
