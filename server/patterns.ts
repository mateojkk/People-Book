/**
 * Patterns — "what do I keep saying?"
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The other four questions in the product ("what happened with her", "why did it
 * change", "what did I promise", "what did we decide") are all lookups. They can
 * be answered by retrieving the right memories and showing them. This one cannot,
 * because the answer is not a memory — it is a shape across many memories, and
 * nothing in your book will ever contain it. You promised to ring Maya in January,
 * March and May. No single memory knows that. Only the set does.
 *
 * So it has to be computed, deterministically. A model asked "what do I keep
 * saying" will answer fluently and invent the answer, which is the one thing this
 * product must never do.
 *
 * ── Why it is conservative ───────────────────────────────────────────────────
 * A false pattern is far more damaging than a missed one. If it tells you that
 * you keep forgetting to ring, and you actually do not, you will stop trusting
 * every other claim it makes — and the whole value of this product is that its
 * claims come from your actual history. So the bar is deliberately high: two
 * occurrences minimum, same subject, and only claims that normalise to the same
 * thing. Missing a pattern costs you one unanswered question. Inventing one costs
 * the product.
 *
 * ── Read-time, like decay ────────────────────────────────────────────────────
 * Nothing is written. Patterns are derived from whatever the ledger already
 * holds, so there is nothing to migrate, nothing to keep consistent, and no way
 * for this file to become a second source of truth that disagrees with your book.
 */

import type { PersonMemory } from "../shared/types.js";

/** How many separate occurrences before something counts as a pattern. */
export const MIN_OCCURRENCES = 2;

/**
 * Content words needed before two memories are considered the same claim.
 *
 * Two, not three. It was three, and that silently dropped "promised to send the
 * photos" -- a perfectly real claim that comes down to two content words once
 * "promised" and "the" are dropped. Bare "promised to call" still fails, which
 * is the case worth protecting against, because a single verb like "call" is
 * exactly the sort of thing that matches by accident.
 */
const MIN_CLAIM_WORDS = 2;

/** Stop words, and the filler that makes two sentences look identical. */
const STOP = new Set([
  "a", "an", "the", "and", "or", "but", "so", "then", "that", "this", "to", "of",
  "in", "on", "at", "for", "with", "is", "was", "were", "be", "been", "being",
  "it", "its", "i", "me", "my", "we", "our", "you", "your", "he", "she", "they",
  "them", "his", "her", "their", "am", "do", "does", "did", "have", "has", "had",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "not", "no", "yes", "about", "from", "up", "out", "just", "now", "again",
  "promised", "said", "says", "will", "going", "gonna", "want", "wanted", "need",
  "needed", "like", "really", "very", "still", "again", "next", "last",
]);

export type PatternKind =
  /** Said to the same person, same commitment, more than once. */
  | "repeated-promise"
  /** Said more than once and never resolved. */
  | "unkept"
  /** A promise that keeps getting pushed to a new date. */
  | "slipped";

export interface Pattern {
  kind: PatternKind;
  /** The reserved "you" or the person's display name. */
  person: string;
  /** The claim, taken from the most recent occurrence rather than invented. */
  claim: string;
  /** How many separate times this was said. */
  count: number;
  /** ISO date of the earliest and latest occurrence. */
  first: string;
  last: string;
  /** The dates it was said, so the shape is inspectable rather than asserted. */
  dates: string[];
  /**
   * The memory ids behind it, so the user can be shown the actual evidence
   * instead of a conclusion. A pattern you cannot check is a claim.
   */
  memoryIds: string[];
}

/**
 * Reduces a claim to the thing that makes two sentences the same sentence.
 *
 * Deliberately crude and deliberately lossy. This is a bag of content words with
 * the dates stripped out, because "promised to ring Maya on the 4th" and
 * "promised to ring Maya on the 18th" are the same promise and differ only in a
 * number the user is trying to forget.
 */
function fingerprint(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    // Numbers are almost always the date, which is exactly what varies between
    // two tellings of the same promise. Ordinals included -- "on the 4th" and
    // "on the 18th" are the same promise, and a bare digit filter misses both
    // because "4th" is not a number. That was found by the test, not by reading.
    .filter((w) => w && !STOP.has(w) && !/^\d+(st|nd|rd|th)?$/.test(w));

  return words.join(" ");
}

function occurrenceKey(m: PersonMemory): string {
  return `${m.person.toLowerCase()}|${fingerprint(m.text)}`;
}

function isoDate(m: PersonMemory): string {
  return (m.occurredAt ?? m.createdAt).slice(0, 10);
}

/**
 * What you keep saying.
 *
 * Only `promise` memories qualify. A repeated trait ("Maya works nights") is not
 * a pattern worth interrupting anyone about -- it is simply true, and being told
 * it repeatedly would be noise dressed up as insight. A repeated *commitment* is
 * different: it is either something you keep failing to do or something you keep
 * promising, and both are worth knowing.
 */
export function computePatterns(memories: readonly PersonMemory[]): Pattern[] {
  const promises = memories.filter((m) => m.type === "promise" && m.deleted !== true);

  const groups = new Map<string, PersonMemory[]>();
  for (const m of promises) {
    if (fingerprint(m.text).split(" ").filter(Boolean).length < MIN_CLAIM_WORDS) continue;
    const key = occurrenceKey(m);
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }

  const patterns: Pattern[] = [];
  for (const group of groups.values()) {
    if (group.length < MIN_OCCURRENCES) continue;

    const ordered = [...group].sort((a, b) => isoDate(a).localeCompare(isoDate(b)));
    // Safe: the group is length >= MIN_OCCURRENCES, which is at least 2.
    const latest = ordered[ordered.length - 1]!;
    const dates = ordered.map(isoDate);
    const settled = ordered.some((m) => m.status === "kept");

    // Kept once means the pattern broke: you did it. Reporting it as a habit
    // after that would be reporting the past.
    if (settled) continue;

    // Slipped: the same promise, with a later date on each telling. Sorted
    // ascending, so a strictly increasing dueAt run means it kept moving.
    const slipped =
      ordered.length >= 2 &&
      ordered.every((m, i) => i === 0 || Boolean(m.dueAt) && Boolean(ordered[i - 1]!.dueAt)) &&
      ordered.every((m, i) => i === 0 || (m.dueAt ?? "") > (ordered[i - 1]!.dueAt ?? ""));

    patterns.push({
      kind: slipped ? "slipped" : ordered.some((m) => m.status === "missed") ? "unkept" : "repeated-promise",
      person: latest.person,
      // The most recent wording, because that is the one the user recognises.
      claim: latest.text,
      count: ordered.length,
      first: dates[0]!,
      last: dates[dates.length - 1]!,
      dates,
      memoryIds: ordered.map((m) => m.id),
    });
  }

  // Most recent first, then most repeated: the thing you just did again is the
  // one you would want to be told about.
  return patterns.sort((a, b) => b.last.localeCompare(a.last) || b.count - a.count);
}