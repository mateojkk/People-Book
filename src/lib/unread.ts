/**
 * The unread badge on Notifications.
 *
 * ── Why "unseen" and not "unread" ────────────────────────────────────────────
 * WhatsApp's badge counts messages you have not opened. That is the whole
 * pattern, and it is the right one here: a number that counts *what needs
 * doing* (`dueCount`, already on the response) is a to-do list wearing a
 * notification's clothes. A number that counts what you have not seen is a
 * notification badge, and it goes away the moment you look. Those are different
 * things and conflating them is why most apps have a badge people learn to
 * ignore.
 *
 * ── Why it is local ──────────────────────────────────────────────────────────
 * "Seen" is a property of one reader on one device, not of the memory. It lives
 * in localStorage, so opening Notifications on your phone does not clear the
 * badge on your laptop, and a cleared badge is never stored on chain next to
 * facts about your life. Nothing that can be forged and nothing that outlives the
 * tab.
 *
 * The trade is honest: clearing site data resets the badge, and it will reappear
 * once. That is the correct failure direction for a counter that would otherwise
 * be wrong forever.
 */

/** localStorage key. Versioned so a change of meaning does not read old state. */
const KEY = "pb.notifications.seenAt.v1";

/** Dispatched when Notifications is opened, so the rail can clear itself. */
export const SEEN_EVENT = "pb:notifications-seen";

/** A badge above this reads as noise rather than a count. WhatsApp does the same. */
const MAX_SHOWN = 99;

function storage(): Storage | null {
  try {
    // Private browsing and some embedded webviews throw on access rather than
    // returning null, which would take the rail down with it.
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** ISO instant the reader last opened Notifications. Null if never. */
export function seenAt(): string | null {
  // Wrapped, because storage() succeeding does not mean getItem() will: some
  // private-browsing modes and embedded webviews hand you an object that throws
  // on access rather than returning null. Unwrapped, one of those takes the
  // rail down on every render, which is a badge's whole failure mode.
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/** Marks everything currently on file as seen. */
export function markSeen(): void {
  try {
    storage()?.setItem(KEY, new Date().toISOString());
  } catch {
    // A badge that cannot be cleared is not worth failing a render over.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SEEN_EVENT));
}

/** Midnight UTC of the day an ISO instant falls on, as YYYY-MM-DD. */
function dayOf(instant: string): string {
  const at = Date.parse(instant);
  return Number.isNaN(at) ? instant.slice(0, 10) : new Date(at).toISOString().slice(0, 10);
}

/**
 * How many of these notification days you have not opened.
 *
 * Compared at DAY granularity, and this was a real bug. The notice dates arrive
 * as "YYYY-MM-DD", which Date.parse turns into midnight UTC, and they were being
 * compared against the full ISO instant of when you last opened the tab. So
 * today's notice was midnight and your last open was, say, 14:22 -- midnight is
 * always earlier, and today's notifications could never count again once you had
 * opened it that day. A badge that is always zero on the day you most want it is
 * worse than no badge.
 */
export function unseenNotices(dates: readonly string[]): number {
  const since = seenAt();
  // Never opened it, so everything on file is unseen. Showing 0 to someone who
  // has not looked yet would be the one dishonest answer available here.
  if (!since) return dates.length;
  const cutoff = dayOf(since);
  return dates.filter((d) => d.slice(0, 10) > cutoff).length;
}

/**
 * The number on the badge.
 *
 * Outstanding things, which is two things added together:
 *
 *   - notices from days you have not opened, and
 *   - tasks still marked active, i.e. not yet clicked done.
 *
 * The second half is the part that was missing and it is the part that matters.
 * Asked for a badge while holding an unclicked task and getting nothing, because
 * opening the tab had already cleared the count even though the task was right
 * there in the list. That is WhatsApp's behaviour applied to the wrong subject:
 * an unread message clears when you read it, and the equivalent of reading a
 * task here is finishing it, not looking at it.
 *
 * So the badge clears when the tab is open AND nothing is outstanding -- which
 * is what a person actually expects, and why the pill was absent before.
 */
export function unreadCount(opts: {
  dates: readonly string[];
  openTasks: number;
}): number {
  return Math.min(unseenNotices(opts.dates) + Math.max(0, opts.openTasks), MAX_SHOWN);
}

/** What the badge should print. "9+" is easier to read than "99". */
export function badgeLabel(count: number): string {
  return count > MAX_SHOWN ? `${MAX_SHOWN}+` : String(count);
}
