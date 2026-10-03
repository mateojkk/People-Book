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

/**
 * How many of these notifications have not been seen.
 *
 * Compared on the notification's own date, not on fetch time, so a notification
 * that arrived while the tab was closed still counts as unseen.
 */
export function unreadCount(dates: readonly string[]): number {
  const since = seenAt();
  // Never opened it, so everything on file is unread. Showing 0 to someone who
  // has not looked yet would be the one dishonest answer available here.
  if (!since) return Math.min(dates.length, MAX_SHOWN);
  const cutoff = Date.parse(since);
  return Math.min(dates.filter((d) => Date.parse(d) > cutoff).length, MAX_SHOWN);
}

/** What the badge should print. "9+" is easier to read than "99". */
export function badgeLabel(count: number): string {
  return count > MAX_SHOWN ? `${MAX_SHOWN}+` : String(count);
}
