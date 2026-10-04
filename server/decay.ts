import { todayISO } from "../shared/memory-codec.js";
/**
 * Decay.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 * The point of a memory app is that something told it months ago still fires at
 * the right moment: the birthday you mentioned in March, on the 13th of the
 * following year. That only works if old memories are still *reachable*.
 *
 * The opposite failure is just as real. A book that only ever grows becomes a
 * landfill: forty people, none of them current, and every notification is noise
 * you learn to swipe away without reading. Then the two that matter are in the
 * same pile as the other thirty-eight.
 *
 * So relevance decays, and decayed memories stop asking for your attention.
 *
 * ── What it deliberately does not do ─────────────────────────────────────────
 * It never deletes, and it never writes.
 *
 * That is the whole design. Decay is a *read-time* computation: a memory that has
 * faded is still in your account, still in the ledger, still exportable, and
 * still fully readable — it has simply stopped competing for attention. Because
 * nothing is written, decay cannot lose anything, needs no migration, cannot
 * resurrect a tombstone, and reverses by itself the moment a memory becomes
 * relevant again. A memory you mention today is relevant today.
 *
 * Automatic deletion would be the opposite on every count: irreversible,
 * unappealable, and it would mean the app deciding on its own that something you
 * told it was worthless. If you want it gone, you remove it.
 */

import type { PersonMemory } from "../shared/types.js";

/** How long before an untethered memory has faded out of relevance. */
export const HALF_LIFE_DAYS = 120;

/** Below this, a memory is faded: still shown, but it stops surfacing. */
export const DECAY_FLOOR = 0.18;

/** An open promise this long past due stops nagging on its own. */
export const SETTLE_AFTER_DAYS = 60;

const DAY_MS = 86_400_000;

function daysBetween(fromISO: string, toISO: string): number {
  const from = Date.parse(`${fromISO}T00:00:00Z`);
  const to = Date.parse(`${toISO}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN;
  return Math.round((to - from) / DAY_MS);
}



/**
 * How much this memory deserves attention right now, 0..1.
 *
 * Built so that no single factor can carry a memory on its own. Age pulls
 * everything down, and only something time-bound pushes back up — which is
 * exactly the shape of the problem: undated facts fade, dated things come back.
 */
export function relevance(memory: PersonMemory, now: Date): number {
  const today = todayISO(now);

  // Base: a half-life curve from the last time it was touched.
  const anchor = memory.updatedAt?.slice(0, 10) || memory.createdAt?.slice(0, 10);
  const age = anchor ? daysBetween(anchor, today) : 0;
  if (!Number.isFinite(age)) return DECAY_FLOOR;

  let score = Math.pow(0.5, Math.max(0, age) / HALF_LIFE_DAYS);

  // A date in the future is the strongest signal there is: this is precisely the
  // thing that must still be around in three months to be any use.
  if (memory.dueAt) {
    const untilDue = daysBetween(today, memory.dueAt);
    if (Number.isFinite(untilDue)) {
      if (untilDue > 0) {
        // Closer is stronger, but a date a year out still beats an undated fact.
        score = Math.max(score, Math.min(1, 0.62 + 0.38 * Math.exp(-untilDue / 21)));
      } else {
        // Overdue. Still urgent, but it is not a fresh arrival.
        const overdue = -untilDue;
        score = Math.max(score, untilDue >= -3 ? 0.95 : 0.5);
        // ...and a promise stops asking entirely once it is long past.
        if (memory.type === "promise" && overdue > SETTLE_AFTER_DAYS) score = 0;
      }
    }
  }

  // A recurring date does not fade between cycles. The next occurrence is what
  // matters, and `anniversary` has none -- so it is re-anchored by hand here, the
  // same way the ranker resolves it. This is the whole "told it three months
  // ago" case: without it, a birthday decays into the ground by December.
  if (memory.anniversary) {
    const next = nextOccurrenceOf(memory.anniversary, today);
    if (next !== null) {
      const untilNext = daysBetween(today, next);
      if (Number.isFinite(untilNext)) {
        score = Math.max(score, untilNext >= 0 ? Math.min(1, 0.6 + 0.4 * Math.exp(-untilNext / 14)) : 0.3);
      }
    }
  }

  // Lifecycle beats the clock. A promise kept or settled is history, not a task,
  // however recently it was written.
  if (memory.type === "promise") {
    if (memory.status === "open") score *= 1.15;
    else score *= 0.25;
  }

  // How-to facts do not really go stale. "Call her, don't text" is true next
  // year unless someone told us otherwise.
  if (memory.type === "howto" || memory.type === "taboo") score = Math.max(score, 0.5);

  // An event that already happened is history. That is not decay, that is the
  // memory being correct.
  if (memory.type === "event" && memory.occurredAt) {
    const since = daysBetween(memory.occurredAt, today);
    if (Number.isFinite(since) && since > 30) score *= 0.4;
  }

  // Never extracted-and-checked, so never quite as load-bearing.
  if (memory.confidence === "inferred") score *= 0.8;

  return Math.max(0, Math.min(1, score));
}

/** True when this memory has faded: visible in the ledger, silent in notifications. */
export function isDecayed(memory: PersonMemory, now: Date): boolean {
  return relevance(memory, now) < DECAY_FLOOR;
}

/**
 * Whether a promise has gone stale enough to stop being a notification.
 *
 * Read-time only. The promise is never rewritten -- it stays `open` on chain,
 * because a month past due is not the same as a month overdue, and only the user
 * decides the difference.
 */
export function isStalePromise(memory: PersonMemory, now: Date): boolean {
  if (memory.type !== "promise" || memory.status !== "open" || !memory.dueAt) return false;
  const overdue = daysBetween(memory.dueAt, todayISO(now));
  return Number.isFinite(overdue) && overdue > SETTLE_AFTER_DAYS;
}

/**
 * Memories worth surfacing, best first, with everything faded dropped.
 *
 * The filter lives here rather than in the ranker so that "what deserves
 * attention" is one decision in one place. Every caller gets the same answer,
 * which is what stops a decayed memory from resurfacing through some other path.
 */
export function selectLive<T extends PersonMemory>(memories: readonly T[], now: Date): T[] {
  return memories.filter((m) => relevance(m, now) >= DECAY_FLOOR);
}

/**
 * The next occurrence of "MM-DD" on or after `fromISO`. Mirrors the ranker,
 * including its answer for 29 February in a common year: the 28th, not 1 March.
 * An earlier comment here claimed 1 March, which is what the other two
 * implementations actually did NOT do.
 */
/**
 * The next occurrence of "MM-DD" on or after `fromISO`.
 *
 * Returns null when the value cannot be resolved, and the caller treats that as
 * "no signal". It used to return `fromISO`, which is indistinguishable from
 * "the anniversary is today" -- so a malformed value scored
 * 0.6 + 0.4 * exp(0) = 1.0, the maximum relevance, while the ranker returned
 * null for the same input. Not reachable today only because parseMemory rejects
 * such memories; it is a landmine for whoever loosens that check.
 */
function nextOccurrenceOf(anniversary: string, fromISO: string): string | null {
  const match = /^(\d{2})-(\d{2})$/.exec(anniversary);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  // A real day in a real month, not just two pairs of digits.
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(2000, month, 0)).getUTCDate()) return null;

  const year = Number(fromISO.slice(0, 4));
  for (const candidate of [year, year + 1]) {
    const lastDay = new Date(Date.UTC(candidate, month, 0)).getUTCDate();
    const resolved = day > lastDay ? lastDay : day;
    const asISO = new Date(Date.UTC(candidate, month - 1, resolved)).toISOString().slice(0, 10);
    if (asISO >= fromISO) return asISO;
  }
  return null;
}