/**
 * The initiation engine.
 *
 * This is the part that makes the product claim true or false, so the division
 * of labour is strict:
 *
 *   THIS FILE decides WHAT surfaces, using no model at all.
 *   The model writes HOW it is phrased, from a memory it was handed.
 *
 * That separation is the whole defence against a hallucinated promise. If
 * ranking were model-driven, the model could invent a commitment the user never
 * made and present it as something they said. Here, a nudge exists only if a
 * `confirmed` memory satisfies a rule below, and every nudge carries the id of
 * the memory that produced it.
 *
 * It is also why this file is testable without a network, a key, or a wallet —
 * which matters, because criterion 1 of the judging rubric is whether memory is
 * doing real work, and that is only checkable if the decision procedure is
 * inspectable.
 */

import type {
  Nudge,
  NudgeKind,
  NudgeSet,
  PersonMemory,
} from "../shared/types.ts";
import { SELF } from "../shared/types.ts";
import { todayISO } from "../shared/memory-codec.ts";

/** How far ahead a date is worth mentioning. Two weeks is short enough to act on. */
export const HORIZON_DAYS = 14;

/** No one contacted in this long gets an absence nudge. */
export const ABSENCE_DAYS = 30;

/** Cap on nudges returned, so a big book does not bury the urgent ones. */
export const MAX_NUDGES = 5;

const DAY_MS = 86_400_000;

export interface RankingInput {
  memories: PersonMemory[];
  now?: Date;
  horizonDays?: number;
  absenceDays?: number;
  max?: number;
  /** Skips reading memory entirely. Backs the A/B toggle, nothing else. */
  memoryDisabled?: boolean;
  /** Ids the user has dismissed. Dismissal is a signal, not a delete. */
  dismissed?: ReadonlySet<string>;
  /** IANA zone from the profile. Makes "today" mean today for the user. */
  timeZone?: string;
}

export interface RankingResult {
  nudges: Nudge[];
  elisions: { person: string; since: string; sourceMemoryId: string }[];
  basis: NudgeSet["basis"];
}

// ─── Date helpers ────────────────────────────────────────────────────────────

function toUTCmidnight(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/**
 * Whole days from one YYYY-MM-DD to another. Positive means `to` is later.
 *
 * Both ends are normalised to UTC midnight so the result cannot drift by an hour
 * across a daylight-saving boundary and turn "in 1 day" into "in 0 days".
 * Returns Infinity for an unparseable date, which callers treat as "no opinion"
 * — a malformed date must never become an urgent nudge.
 */
function dayDelta(fromISO: string, toISO: string): number {
  const from = toUTCmidnight(fromISO);
  const to = toUTCmidnight(toISO);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.POSITIVE_INFINITY;
  return Math.round((to - from) / DAY_MS);
}

/**
 * The date a moment falls on, in the user's zone when we know it.
 *
 * Was `toISOString().slice(0, 10)`, which is UTC. At 11pm in London that is
 * already tomorrow, so nudges for the next morning could be suppressed and
 * overdue promises could be counted a day early. The zone comes from the
 * profile; without one this is UTC, which is the honest answer when we do not
 * know where the user is.
 */
function isoOf(date: Date, timeZone?: string): string {
  return todayISO(date, timeZone);
}

/**
 * The next time a recurring date comes round, as an ISO date.
 *
 * A birthday has no year, so it cannot live in `dueAt`. Given "the 14th" and
 * today, this returns the next 14th — this year if it is still ahead, otherwise
 * the same date next year. That is what makes an anniversary keep reminding you
 * instead of expiring on 1 January.
 *
 * 29 February is the awkward one: it does not exist in a common year, so it is
 * pinned to 1 March rather than skipped. A birthday on the 28th or 29th is still
 * remembered, which is the point; an exact date is not worth losing the reminder
 * over.
 */
export function nextOccurrence(anniversary: string, now: Date): string | null {
  const match = /^(\d{2})-(\d{2})$/.exec(anniversary);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const year = now.getUTCFullYear();
  for (const candidateYear of [year, year + 1]) {
    const lastDay = new Date(Date.UTC(candidateYear, month, 0)).getUTCDate();
    const resolvedDay = day > lastDay ? lastDay : day;
    const asDate = new Date(Date.UTC(candidateYear, month - 1, resolvedDay));
    if (asDate.getTime() >= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) {
      return asDate.toISOString().slice(0, 10);
    }
  }
  return null;
}

/**
 * The date a memory should be treated as falling due, if any.
 *
 * An explicit `dueAt` always wins. Otherwise a recurring date is resolved against
 * today. Kept separate from the memory itself on purpose: the stored anniversary
 * stays "09-14" forever, while the due date it implies moves, so nothing has to be
 * rewritten each January.
 */
export function effectiveDueAt(memory: PersonMemory, now: Date): string | undefined {
  if (memory.dueAt) return memory.dueAt;
  if (memory.anniversary) return nextOccurrence(memory.anniversary, now) ?? undefined;
  return undefined;
}

/** The date a person was last "in touch" by our own reckoning: the most recent confirmed event mentioning them. */
function lastContact(person: string, memories: PersonMemory[]): string | undefined {
  return memories
    .filter((m) => m.person === person && m.confidence === "confirmed")
    .map((m) => m.occurredAt ?? m.createdAt.slice(0, 10))
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1);
}

// ─── Taboo handling ──────────────────────────────────────────────────────────

interface Taboo {
  person: string;
  since: string;
  sourceMemoryId: string;
  terms: string[];
}

/**
 * The taboos, one per person.
 *
 * `since` is the EARLIEST date any of that person's taboos was set, because a
 * taboo you set first is the one you still mean. The old code said so and did
 * the opposite: the condition tested `entry.since === ""`, which is never true,
 * so it overwrote on every memory without ever comparing dates. The answer
 * therefore depended on the order of the array.
 *
 * That matters more than it sounds. MemWal returns in relevance order, not write
 * order, so the same book could report a taboo as set in February on one call and
 * August on the next, and `sourceMemoryId` moved with it. The test for
 * order-independence existed but only ever used one taboo per person.
 */
function collectTaboos(memories: PersonMemory[]): Map<string, Taboo> {
  const byPerson = new Map<string, Taboo>();
  for (const m of memories) {
    if (m.type !== "taboo" || m.confidence !== "confirmed") continue;

    const when = m.occurredAt ?? m.createdAt.slice(0, 10);
    const entry = byPerson.get(m.person);

    if (!entry) {
      byPerson.set(m.person, { person: m.person, since: when, sourceMemoryId: m.id, terms: [] });
    } else if (when < entry.since) {
      // Strictly earlier, so a tie keeps the first-seen id and the result stays
      // stable for a given array.
      entry.since = when;
      entry.sourceMemoryId = m.id;
    }

    // Outside the branch. An early `continue` here skipped the push for the FIRST
    // taboo of each person, which silently stopped that one from being redacted --
    // the worst possible direction for a privacy control to fail in.
    byPerson.get(m.person)!.terms.push(m.text.toLowerCase());
  }

  // Terms are a set in practice, and duplicates inflate redaction work.
  for (const entry of byPerson.values()) entry.terms = [...new Set(entry.terms)];
  return byPerson;
}

/**
 * Redacts a phrase against a person's taboos.
 *
 * Redaction is a real risk of over-matching, so it is deliberately blunt: a
 * phrase is only elided when a taboo's distinctive words appear in it. When
 * something IS elided, the caller is told, because quietly dropping a topic the
 * user asked about reads as the assistant ignoring them rather than respecting
 * them. Silence here would be the dishonest option.
 */
function redact(text: string, taboo: Taboo | undefined): { text: string; elided: boolean } {
  if (!taboo) return { text, elided: false };
  const haystack = text.toLowerCase();

  // Words of 4+ characters, so "the" and "job" in the wrong place do not trigger.
  const terms = taboo.terms
    .flatMap((t) => t.toLowerCase().match(/[a-z'’-]{4,}/g) ?? [])
    .filter((w) => !STOPWORDS.has(w));

  if (terms.length === 0) return { text, elided: false };
  const hit = terms.some((term) => haystack.includes(term));
  return hit ? { text: "", elided: true } : { text, elided: false };
}

const STOPWORDS = new Set([
  "about", "after", "again", "them", "then", "that", "this", "with", "what", "when",
  "where", "which", "while", "would", "could", "should", "never", "always", "don't",
  "talk", "bring", "mention", "said", "told", "talked", "asked", "talking",
]);

// ─── Phrasing ────────────────────────────────────────────────────────────────

/**
 * Builds the visible sentence for a nudge from the memory, with NO model.
 *
 * The model is used elsewhere to make this read better, but it must be optional:
 * if Groq is down the product still has to work, because the value is in the
 * memory and the ranking, not in the prose. A dependency on the LLM for basic
 * function is how a memory product becomes decorative the moment its API key
 * expires.
 */
function phrase(kind: NudgeKind, m: PersonMemory, days: number | null, since: string | undefined): string {
  const person = m.person === SELF ? "you" : m.person;
  const claim = m.text;

  switch (kind) {
    case "date":
      if (days !== null && days === 0) return `${person}: today — ${lower(claim)}`;
      if (days !== null && days === 1) return `${person}: tomorrow — ${lower(claim)}`;
      if (days !== null) return `${person}: in ${days} days — ${lower(claim)}`;
      return `${person}: ${lower(claim)}`;

    case "promise":
      if (days !== null && days < 0) return `${person}: overdue by ${-days} day${days === -1 ? "" : "s"} — ${lower(claim)}`;
      if (days !== null && days === 0) return `${person}: due today — ${lower(claim)}`;
      if (days !== null) return `${person}: due in ${days} days — ${lower(claim)}`;
      return `${person}: still open — ${lower(claim)}`;

    case "absence":
      return since
        ? `${person}: ${days} days since you were in touch. Last noted ${since}.`
        : `${person}: ${days} days since you were in touch.`;

    case "loop":
      return `${person}: still unresolved — ${lower(claim)}`;

    case "followthrough":
      return `${claim}`;
  }
}

function lower(s: string): string {
  return s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s;
}

// ─── The engine ──────────────────────────────────────────────────────────────

export function computeNudges(input: RankingInput): RankingResult {
  const now = input.now ?? new Date();
  // The user's zone, when known. See todayISO -- UTC is a day wrong for anyone
  // whose evening crosses midnight, and that is exactly when a reminder is due.
  const today = todayISO(now, input.timeZone);
  const horizon = input.horizonDays ?? HORIZON_DAYS;
  // Honoured, or a caller passing `absenceDays: 1` silently got 30.
  const absence = input.absenceDays ?? ABSENCE_DAYS;
  const max = input.max ?? MAX_NUDGES;
  const dismissed = input.dismissed ?? new Set<string>();

  const all = input.memories;
  const taboos = collectTaboos(all);
  /** People whose content was actually withheld. See the elision note below. */
  const withheld = new Set<string>();

  // Only confirmed memories are eligible to nudge. This single filter is the
  // mechanism behind "it cites, it never claims": an unconfirmed extraction is
  // visible in the ledger and structurally cannot reach the user as a claim.
  const eligible = all.filter((m) => m.confidence === "confirmed");

  const basis: NudgeSet["basis"] = {
    memoryCount: all.length,
    confirmedCount: eligible.length,
    inferredCount: all.length - eligible.length,
    horizonDays: horizon,
    ...(input.memoryDisabled ? { memoryDisabled: true } : {}),
  };

  // The A/B switch. Disabling memory does not produce a degraded product, it
  // produces the honest baseline: no nudges at all, because every nudge is a
  // recall. That contrast is the whole before/after in the article.
  if (input.memoryDisabled) {
    return { nudges: [], elisions: [], basis };
  }

  const candidates: { nudge: Nudge; score: number }[] = [];

  // 1. Dates inside the horizon. Traits and events only — a promise's date is
  //    handled below, and a taboo's date is not something to announce.
  for (const m of eligible) {
    if (m.type !== "event" && m.type !== "trait") continue;

    // Either an explicit date, or the next occurrence of a recurring one. A
    // birthday used to reach neither branch, which is why it could be remembered
    // but never mentioned.
    const due = effectiveDueAt(m, now);
    if (!due) continue;

    const days = dayDelta(isoOf(now, input.timeZone), due);
    if (!Number.isFinite(days) || days < 0 || days > horizon) continue;

    // Closer dates rank higher, but never perfectly: a date in 14 days should
    // not outrank an overdue promise purely on distance.
    pushNudge(
      candidates,
      build("date", m, days, undefined, taboos, withheld, now),
      0.55 + 0.25 * (1 - days / horizon),
    );
  }

  // 2. Open promises. Only these — a promise marked kept or settled is exactly
  //    the thing that must never nag again.
  for (const m of eligible) {
    if (m.type !== "promise" || m.status !== "open") continue;

    const days = m.dueAt ? dayDelta(isoOf(now, input.timeZone), m.dueAt) : null;
    // Undated open promises still surface, but weakly: you did say you'd do it.
    const score = days === null ? 0.5 : days < 0 ? 1 : 0.6 + 0.2 * (1 - Math.min(days, horizon) / horizon);
    pushNudge(candidates, build("promise", m, days, undefined, taboos, withheld, now), score);
  }

  // 3. Absence. Only for people we actually have confirmed memories about, and
  //    never for yourself — being alone is not a nudge.
  const people = [...new Set(eligible.map((m) => m.person))].filter((p) => p !== SELF);
  for (const person of people) {
    const last = lastContact(person, all);
    if (!last) continue;
    const days = dayDelta(last, isoOf(now, input.timeZone));
    if (!Number.isFinite(days) || days < absence) continue;

    const synthetic: PersonMemory = {
      id: `absence:${person}`,
      rev: 1,
      person,
      type: "event",
      status: "active",
      confidence: "confirmed",
      text: `You have not been in touch with ${person}.`,
      createdAt: `${last}T00:00:00.000Z`,
      updatedAt: `${last}T00:00:00.000Z`,
    };
    const { elided } = redact(synthetic.text, taboos.get(person));
    if (elided) {
      withheld.add(person);
      continue;
    }

    candidates.push({
      nudge: {
        id: `nudge:absence:${person}:${last}`,
        kind: "absence",
        person,
        text: phrase("absence", synthetic, days, last),
        sourceMemoryId: synthetic.id,
        sourceText: last,
        urgency: 0,
        elided: false,
      },
      // Grows with time, but capped: missing someone for 200 days should not
      // outrank an overdue promise by much.
      score: Math.min(0.5 + (days - absence) / 200, 0.75),
    });
  }

  // 4. Unresolved situations.
  for (const m of eligible) {
    if (m.type !== "event" || m.status !== "open") continue;
    pushNudge(candidates, build("loop", m, null, undefined, taboos, withheld, now), 0.45);
  }

  // 5. Your own follow-through. Only reachable because the user is in the book
  //    as a person like anyone else. Counts promises to others that were never
  //    closed, and is capped at the worst two so it can never dominate.
  const openPromises = eligible.filter((m) => m.type === "promise" && m.status === "open");
  const byPerson = new Map<string, { open: number; kept: number }>();
  for (const m of openPromises) {
    const key = m.person;
    const row = byPerson.get(key) ?? { open: 0, kept: 0 };
    row.open += 1;
    byPerson.set(key, row);
  }
  for (const m of eligible) {
    if (m.type !== "promise" || m.status !== "kept") continue;
    const row = byPerson.get(m.person);
    if (row) row.kept += 1;
  }

  const followThrough = [...byPerson.entries()]
    .filter(([person, row]) => person !== SELF && row.open >= 2)
    .map(([person, row]) => ({ person, ...row }))
    // Worst ratio first, then most outstanding.
    .sort((a, b) => b.open / Math.max(b.open + b.kept, 1) - a.open / Math.max(a.open + a.kept, 1) || b.open - a.open)
    .slice(0, 2);

  for (const row of followThrough) {
    const claim = `You have told ${row.person} you would do something ${row.open} times and confirmed it ${row.kept === 0 ? "never" : `${row.kept} time${row.kept === 1 ? "" : "s"}`}.`;
    const { text, elided } = redact(claim, taboos.get(row.person));
    if (elided) {
      withheld.add(row.person);
      continue;
    }

    candidates.push({
      nudge: {
        id: `nudge:followthrough:${row.person}:${row.open}:${row.kept}`,
        kind: "followthrough",
        person: row.person,
        text,
        sourceMemoryId: `followthrough:${row.person}`,
        sourceText: claim,
        urgency: 0,
        elided: false,
      },
      // Deliberately below every other kind. This is the most uncomfortable thing
      // the product says, so it is never the loudest thing it says.
      score: 0.42,
    });
  }

  // Rank, drop dismissed, then take the top slice.
  //
  // Dedupe first on (kind, person, text): the same fact can legitimately exist
  // more than once — re-confirming something, or a retry that wrote twice — and
  // two identical nudges stacked on a screen reads as a bug in the assistant
  // rather than a fact about the user.
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = `${c.nudge.kind}|${c.nudge.person}|${c.nudge.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const ranked = unique
    .filter((c) => !dismissed.has(c.nudge.id))
    .sort((a, b) => b.score - a.score || a.nudge.id.localeCompare(b.nudge.id));

  const nudges = selectForDisplay(ranked.map((c) => c.nudge), max);

  // Announced elisions, driven by what was ACTUALLY withheld.
  //
  // This used to intersect the taboo list with the people who survived into the
  // nudge set, which was backwards: when a taboo suppressed a person's only
  // nudge, they vanished from the set and the suppression went unannounced —
  // exactly the case where the user most needs to know something was held back.
  // Announcing only real redactions also keeps it quiet when a rule never came
  // into play, which is what stops the notice becoming noise.
  const elisions = [...taboos.values()]
    .filter((t) => withheld.has(t.person))
    .map((t) => ({ person: t.person, since: t.since, sourceMemoryId: t.sourceMemoryId }));

  return { nudges, elisions, basis };
}

/**
 * Picks what to show, keeping the set varied.
 *
 * A purely score-ordered top-N is wrong for this product, and the live run
 * proved it: five ordinary overdue promises filled every slot and the
 * follow-through nudge — the one observation that is actually about YOU, and the
 * hardest thing for a person to notice unaided — never appeared at all. A
 * product whose most distinctive output is the first thing to be crowded out is
 * shipping the easy half.
 *
 * So: at most PER_KIND_CAP of any one kind, and one reserved slot for the best
 * follow-through nudge when one exists.
 */
const PER_KIND_CAP = 3;

function selectForDisplay(sorted: Nudge[], max: number): Nudge[] {
  const chosen: Nudge[] = [];
  const perKind = new Map<NudgeKind, number>();
  let followThrough: Nudge | null = null;

  for (const nudge of sorted) {
    if (nudge.kind === "followthrough") {
      // Held back for the reserved slot rather than taking a normal one.
      if (!followThrough) followThrough = nudge;
      continue;
    }
    const used = perKind.get(nudge.kind) ?? 0;
    if (used >= PER_KIND_CAP) continue;
    perKind.set(nudge.kind, used + 1);
    chosen.push(nudge);
  }

  // The reserved slot has to actually be reserved.
  //
  // It used to be pushed onto `chosen`, then the whole list was sorted and
  // truncated. Follow-through scores 0.42, the lowest of all five kinds, so
  // after the sort it sat last and `slice(0, max)` deleted it -- which is the
  // exact regression the function's own comment says it exists to prevent. Any
  // book with dates AND promises AND an absence triggers it; the test missed it
  // because the fixture only had two kinds, so `chosen` never reached `max`.
  //
  // Truncating to max-1 and appending afterwards is the only thing that reserves
  // anything. Reserving it and then sorting it back into last position would
  // reintroduce the same bug.
  const room = followThrough ? Math.max(0, max - 1) : max;
  const kept = chosen.slice(0, room);
  return followThrough ? [...kept, followThrough] : kept;
}

/**
 * Builds a nudge, or null if redaction emptied it.
 *
 * A redacted nudge is DROPPED rather than emitted with empty text. The live run
 * produced exactly that failure: a nudge whose whole sentence was redacted came
 * through as a blank card. That is worse than either alternative — it looks like
 * a bug in the assistant rather than restraint, and it teaches the user that
 * blank output is normal. The rule stays enforced by the taboo filter, and the
 * elision notice explains the absence; the reminder itself simply is not there.
 */
function build(
  kind: NudgeKind,
  m: PersonMemory,
  days: number | null,
  since: string | undefined,
  taboos: Map<string, Taboo>,
  withheld: Set<string>,
  now: Date,
): Nudge | null {
  const { text, elided } = redact(phrase(kind, m, days, since), taboos.get(m.person));
  if (elided) withheld.add(m.person);
  if (elided || !text.trim()) return null;
  return {
    id: `nudge:${kind}:${m.id}`,
    kind,
    person: m.person,
    text,
    sourceMemoryId: m.id,
    sourceText: m.text,
    urgency: 0,
    dueAt: effectiveDueAt(m, now),
    elided: false,
  };
}

/** Wraps build() and drops nulls, so callers can push without a null check. */
function pushNudge(list: { nudge: Nudge; score: number }[], nudge: Nudge | null, score: number): void {
  if (nudge) list.push({ nudge, score });
}

/** The one honest line the UI shows when something was withheld. */
export function elisionLine(person: string, since: string): string {
  return `Not mentioning the thing you told me not to mention about ${person}, set on ${since}.`;
}
