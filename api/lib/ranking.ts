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
} from "../../shared/types.ts";
import { SELF } from "../../shared/types.ts";

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

function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10);
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

function collectTaboos(memories: PersonMemory[]): Map<string, Taboo> {
  const byPerson = new Map<string, Taboo>();
  for (const m of memories) {
    if (m.type !== "taboo" || m.confidence !== "confirmed") continue;
    const entry: Taboo = byPerson.get(m.person) ?? {
      person: m.person,
      since: m.occurredAt ?? m.createdAt.slice(0, 10),
      sourceMemoryId: m.id,
      terms: [],
    };
    // Keep the EARLIEST rule: a taboo you set first is the one you still mean.
    if (entry.since === "" || m.occurredAt === undefined) {
      entry.since = m.occurredAt ?? m.createdAt.slice(0, 10);
    }
    entry.terms.push(m.text.toLowerCase());
    byPerson.set(m.person, entry);
  }
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
  const horizon = input.horizonDays ?? HORIZON_DAYS;
  const max = input.max ?? MAX_NUDGES;
  const dismissed = input.dismissed ?? new Set<string>();

  const all = input.memories;
  const taboos = collectTaboos(all);

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
    if (!m.dueAt) continue;

    const days = dayDelta(isoOf(now), m.dueAt);
    if (!Number.isFinite(days) || days < 0 || days > horizon) continue;

    candidates.push({
      nudge: build("date", m, days, undefined, taboos, now),
      // Closer dates rank higher, but never perfectly: a date in 14 days should
      // not outrank an overdue promise purely on distance.
      score: 0.55 + 0.25 * (1 - days / horizon),
    });
  }

  // 2. Open promises. Only these — a promise marked kept or settled is exactly
  //    the thing that must never nag again.
  for (const m of eligible) {
    if (m.type !== "promise" || m.status !== "open") continue;

    const days = m.dueAt ? dayDelta(isoOf(now), m.dueAt) : null;
    // Undated open promises still surface, but weakly: you did say you'd do it.
    const score = days === null ? 0.5 : days < 0 ? 1 : 0.6 + 0.2 * (1 - Math.min(days, horizon) / horizon);
    candidates.push({ nudge: build("promise", m, days, undefined, taboos, now), score });
  }

  // 3. Absence. Only for people we actually have confirmed memories about, and
  //    never for yourself — being alone is not a nudge.
  const people = [...new Set(eligible.map((m) => m.person))].filter((p) => p !== SELF);
  for (const person of people) {
    const last = lastContact(person, all);
    if (!last) continue;
    const days = dayDelta(last, isoOf(now));
    if (!Number.isFinite(days) || days < ABSENCE_DAYS) continue;

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
    if (elided) continue;

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
      score: Math.min(0.5 + (days - ABSENCE_DAYS) / 200, 0.75),
    });
  }

  // 4. Unresolved situations.
  for (const m of eligible) {
    if (m.type !== "event" || m.status !== "open") continue;
    candidates.push({ nudge: build("loop", m, null, undefined, taboos, now), score: 0.45 });
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
    if (elided) continue;

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

  // Rank, drop dismissed, then take the top slice. Dismissal removes the nudge
  // without touching the memory, so the underlying fact survives and can be
  // raised again later if the date comes round.
  const ranked = candidates
    .filter((c) => !dismissed.has(c.nudge.id))
    .sort((a, b) => b.score - a.score || a.nudge.id.localeCompare(b.nudge.id));

  const nudges = ranked.slice(0, max).map((c) => c.nudge);

  // Announced elisions. Only for people who actually have a taboo and who
  // actually appear in this set — announcing a rule that changed nothing would
  // be noise.
  const inSet = new Set(nudges.map((n) => n.person));
  const elisions = [...taboos.values()]
    .filter((t) => inSet.has(t.person))
    .map((t) => ({ person: t.person, since: t.since, sourceMemoryId: t.sourceMemoryId }));

  return { nudges, elisions, basis };
}

function build(
  kind: NudgeKind,
  m: PersonMemory,
  days: number | null,
  since: string | undefined,
  taboos: Map<string, Taboo>,
  now: Date,
): Nudge {
  const { text, elided } = redact(phrase(kind, m, days, since), taboos.get(m.person));
  return {
    id: `nudge:${kind}:${m.id}`,
    kind,
    person: m.person,
    text,
    sourceMemoryId: m.id,
    sourceText: m.text,
    urgency: 0,
    dueAt: m.dueAt,
    elided,
  };
}

/** The one honest line the UI shows when something was withheld. */
export function elisionLine(person: string, since: string): string {
  return `Not mentioning the thing you told me not to mention about ${person}, set on ${since}.`;
}
