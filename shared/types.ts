/**
 * Types shared between the browser and the API.
 *
 * Both sides must agree exactly on these shapes: the browser renders nudges and
 * the ledger, the API produces them. Keeping them in one file removes a whole
 * class of "works on the server, breaks in the client" bugs.
 */

// ─── Memory model ────────────────────────────────────────────────────────────

/**
 * What a memory is FOR. This is not decoration — the initiation engine only
 * reads a subset of these types, so a bad classification changes what the
 * assistant is able to bring you.
 */
export type MemoryType =
  /** A durable fact about someone: "Maya is vegetarian", "works nights". */
  | "trait"
  /** Something that happened, with a date: "her visa interview moved to Oct 2". */
  | "event"
  /** The user committed to something. The core of the whole product. */
  | "promise"
  /** Explicitly off-limits. Never surfaced, always acknowledged as elided. */
  | "taboo"
  /** How to be with someone: "call her, don't text", "he'll ask about the job". */
  | "howto"
  /** Current state that supersedes older facts: "Maya now works at Initech". */
  | "update"
  /**
   * A standing instruction about how the ASSISTANT should work, addressed to
   * `you`. "Use JetBrains Mono, not Inter", "don't ask me before editing files".
   *
   * Separate from `howto`, which is how to be with a person. This is how to be
   * with me, and it is the one type that exists because the user is the subject.
   */
  | "correction";

/**
 * Promise lifecycle. `open` is the only status the initiation engine surfaces —
 * a promise you already kept should never nag you again.
 */
export type MemoryStatus =
  /** Still outstanding. */
  | "open"
  /** Done. Closed by the user, never inferred. */
  | "kept"
  /** The date passed and it did not happen. */
  | "missed"
  /** Resolved one way or another; no longer worth surfacing. */
  | "settled"
  /** Standing fact, not a commitment. */
  | "active";

/**
 * The most important field in the system.
 *
 * `confirmed` = the user said it, or explicitly confirmed it. These may nudge.
 * `inferred`  = the model extracted it and nobody checked. These are visible in
 *               the ledger but are STRUCTURALLY INCAPABLE of surfacing as a
 *               nudge, which is what makes a bad extraction harmless instead of
 *               harmful. See README > "It cites, it never claims".
 */
export type MemoryConfidence = "confirmed" | "inferred";

export interface PersonMemory {
  /** Stable id, generated at capture. Referenced by nudges and by `supersedes`. */
  id: string;
  /**
   * Write revision, starting at 1 and incremented on every rewrite of this id.
   *
   * MemWal is append-only and returns blobs in RELEVANCE order, not write
   * order, so "which write is current" cannot be decided by array position or by
   * `updatedAt` alone — two writes in the same millisecond tie. `rev` makes the
   * collapse order-independent, which is what stops a status flip from silently
   * losing. See codec.collapseById.
   */
  rev: number;
  /**
   * Display name of the subject. The user themself is the reserved name
   * "you" — you are in the book too, and the follow-through nudges depend on it.
   */
  person: string;
  type: MemoryType;
  status: MemoryStatus;
  confidence: MemoryConfidence;
  /**
   * The claim, in plain language. This leads the stored text because MemWal
   * embeds it, and the person name plus the claim words are what make
   * "what did I promise Maya?" retrieve the right blob.
   */
  text: string;
  /** ISO date (YYYY-MM-DD). When the thing was said or happened. */
  occurredAt?: string;
  /** ISO date (YYYY-MM-DD). When it becomes due. Drives date and promise nudges. */
  dueAt?: string;
  /**
   * "MM-DD" for a date that comes round every year, such as a birthday.
   *
   * Separate from dueAt because a birthday has no year: there is nowhere to put
   * one. Without this, "her birthday is the 14th" was stored as a bare trait with
   * no date and could therefore never produce a reminder. The ranker computes the
   * next occurrence from this, so it keeps working in every year.
   */
  anniversary?: string;
  /** Id of a memory this one replaces. Keeps history instead of overwriting. */
  supersedes?: string;
  /**
   * WHY the user gave the instruction. Corrections only.
   *
   * This is the whole point of the type. A bare instruction -- "no Inter" -- gets
   * violated anyway, because the next time the situation looks slightly
   * different the instruction does not obviously apply and the safe reading is
   * that it no longer holds. The reason is what makes it survive: "no Inter,
   * because it's a wide face and the measure breaks" is recognisably the same
   * problem when it comes back as "no Inter, the type is too wide".
   *
   * Optional, because the user does not always give one. An absent reason is
   * stored as absent rather than invented.
   */
  reason?: string;
  /**
   * Tombstone marker. MemWal ships no delete, so forgetting writes a new blob
   * with the same id and `deleted: true`, and every read filters tombstones out.
   * See api/lib/store.ts > tombstone().
   */
  deleted?: boolean;
  /**
   * The user's original sentence, stored only when they opt in per memory. It
   * is the most sensitive thing we hold, which is exactly why it is off by
   * default — see README > "What is deliberately not stored".
   */
  verbatim?: string;
  createdAt: string;
  updatedAt: string;
}

/** The reserved `person` value for the user themself. */
export const SELF = "you";

export const MEMORY_TYPES: readonly MemoryType[] = [
  "trait",
  "event",
  "promise",
  "taboo",
  "howto",
  "update",
  "correction",
];

// ─── Initiation ──────────────────────────────────────────────────────────────

/**
 * Why the assistant surfaced something. The kind is shown in the UI, because
 * "here's a nudge" is only trustworthy if you can see what triggered it.
 */
export type NudgeKind =
  /** A date inside the horizon. */
  | "date"
  /** A promise still open, due or overdue. */
  | "promise"
  /** Someone has not been in touch for a while. */
  | "absence"
  /** An unresolved situation from before. */
  | "loop"
  /** A pattern about the user's OWN follow-through. */
  | "followthrough";

export interface Nudge {
  /** Deterministic, derived from the source memory. Stable across reloads. */
  id: string;
  kind: NudgeKind;
  person: string;
  /** Human phrasing. Written by the LLM from the memory, never invented. */
  text: string;
  /** The memory this came from. Every nudge is a pointer, never a claim. */
  sourceMemoryId: string;
  /** The memory text verbatim, so the UI can show the claim it is based on. */
  sourceText: string;
  /** Deterministic 0..1. Higher sorts first. Computed in ranking.ts. */
  urgency: number;
  dueAt?: string;
  /**
   * True when a taboo for this person was withheld while producing this nudge.
   * Drives the honest elision notice in the UI.
   */
  elided: boolean;
}

export interface NudgeSet {
  nudges: Nudge[];
  /**
   * One line per person whose forbidden topics shaped this set, naming the
   * memory that established the rule. Silence here would be dishonest.
   */
  elisions: { person: string; since: string; sourceMemoryId: string }[];
  /** When the set was computed. Shown so staleness is visible. */
  computedAt: string;
  /** Deterministic inputs, echoed so a judge can see why the set looks like this. */
  basis: {
    memoryCount: number;
    confirmedCount: number;
    inferredCount: number;
    horizonDays: number;
    /** Set when the ranking ran WITHOUT reading memory. The A/B toggle. */
    memoryDisabled?: boolean;
  };
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

export interface LedgerEntry {
  memory: PersonMemory;
  /** Why this memory exists, in the user's terms. Null for confirmed-at-capture. */
  capturedBy?: string;
}

// ─── Capture ─────────────────────────────────────────────────────────────────

/** A memory the model proposes, before the user has confirmed it. */
/**
 * A recurring date, as "MM-DD".
 *
 * Birthdays and anniversaries have no year, which is exactly why they could not be
 * reminded about: there was nowhere to put one. `dueAt` is a full ISO date, so it
 * cannot hold "the 14th" -- and a birthday stored without a date is just a trait,
 * which never produces a nudge. The ranker computes the next occurrence from this
 * instead, so it keeps working in every year rather than expiring on New Year's.
 */
export interface MemoryCandidate {
  person: string;
  type: MemoryType;
  status: MemoryStatus;
  text: string;
  occurredAt?: string;
  dueAt?: string;
  /** "MM-DD" for a date that recurs every year, such as a birthday. */
  anniversary?: string;
  /** The writer's reason for a correction. Only for type "correction". */
  reason?: string;
  /** Why the model thinks this is worth keeping. Shown so the user can judge. */
  reasoning: string;
  /**
   * 0..1. Below CONFIRM_THRESHOLD the candidate is not even offered for
   * promotion — a low-confidence guess is worse than nothing.
   */
  confidence: number;
  /** True when the user explicitly asked for this, so no confirmation needed. */
  explicit: boolean;
  /**
   * The id of an open promise this candidate completes ("I called Maya"
   * fulfills "Call Maya"). Set by the model, verified by code: takeTurn only
   * honours it when it names a real open promise, otherwise it is ignored and
   * the candidate is filed as new. Without this, reporting a completion files a
   * second memory while the promise stays open forever -- the app then both
   * nags about something done and cannot say it was done.
   */
  fulfillsPromiseId?: string;
}

/** The model is never asked to invent; it is asked to extract. */
export interface CaptureResult {
  candidates: MemoryCandidate[];
  /** Set when extraction failed outright. We say so rather than guessing. */
  error?: string;
}

export const CONFIRM_THRESHOLD = 0.55;
