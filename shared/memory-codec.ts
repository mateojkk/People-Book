/**
 * How a typed memory becomes the flat text MemWal actually stores, and back.
 *
 * ── Why this shape ─────────────────────────────────────────────────────────
 * MemWal's default client hands text to the relayer, which EMBEDS it for vector
 * search. So the layout is chosen for retrieval first and parsing second:
 *
 *   1. The claim in plain language comes FIRST. That is the text the embedder
 *      sees, so the person's name and the claim words are what make
 *      "what did I promise Maya?" retrieve the right blob.
 *   2. A machine-readable block trails after a sentinel. It is parsed, never
 *      embedded, and stripped before anything is shown to a human.
 *
 * The alternative — leading with JSON — measurably degrades recall, because
 * `{"person":"Maya","type":"promise"}` is a worse query target than
 * "I told Maya I'd find the thing from the shop."
 *
 * Writes are append-only: superseding a fact writes a NEW blob that points at
 * the old id. History is never destroyed, which is what makes the ledger
 * auditable.
 */

import {
  type MemoryConfidence,
  type MemoryStatus,
  type MemoryType,
  MEMORY_TYPES,
  type PersonMemory,
} from "./types.js";

/**
 * Sentinel separating the human text from the machine block.
 *
 * Deliberately ugly and ASCII-only: it has to survive a round trip through the
 * relayer, a JSON payload and a blob store without being mangled, and it must
 * never appear in ordinary prose. A short, all-caps, bracket-wrapped marker
 * reads as machine output to a human scanning the raw blob.
 */
const SENTINEL = "@@pb1@@";

/** The persisted payload. `text` is excluded — it is the part before the sentinel. */
interface MemoryMeta {
  id: string;
  rev: number;
  person: string;
  type: MemoryType;
  status: MemoryStatus;
  confidence: MemoryConfidence;
  occurredAt?: string;
  dueAt?: string;
  anniversary?: string;
  supersedes?: string;
  deleted?: boolean;
  verbatim?: string;
  /** The user's own reason for a correction. Absent is stored as absent. */
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A recurring date: "MM-DD".
 *
 * Validated for real ranges, not just shape. "13-45" is not a birthday, and letting
 * it through would put a date the ranker cannot compute into the ledger, where it
 * would sit looking like data forever.
 */
function isAnniversaryOrUndefined(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  const match = /^(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Reject a day that does not exist in that month, allowing for 29 Feb.
  const probe = new Date(Date.UTC(2024, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * Ids are short, sortable by creation, and derived from a counter plus a random
 * suffix. Sortable matters: when two writes land in the same millisecond we
 * break the tie deterministically instead of by insertion luck.
 */
export function makeMemoryId(now: Date = new Date()): string {
  const time = now.getTime().toString(36).padStart(9, "0");
  const rand = Math.random().toString(36).slice(2, 7);
  return `mem_${time}_${rand}`;
}

/**
 * Today's date, as YYYY-MM-DD.
 *
 * `now.toISOString().slice(0, 10)` is UTC, and that is wrong often enough to
 * matter: at 11pm in London it is already tomorrow in UTC, so a birthday would
 * arrive a day early and every "is this overdue" calculation would be off by one.
 * A companion that tells you someone's birthday is tomorrow, on the day before,
 * is worse than one that says nothing.
 *
 * `timeZone` is the user's, from their profile. Left off, it falls back to UTC,
 * which is the old behaviour and is the correct answer when we do not know where
 * the user is -- guessing a zone from an IP would be worse than admitting it.
 */
export function todayISO(now: Date = new Date(), timeZone?: string): string {
  if (!timeZone) return now.toISOString().slice(0, 10);
  try {
    // en-CA formats as YYYY-MM-DD, which is exactly the shape wanted and avoids
    // assembling one from parts.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    // An unknown zone from a stale browser list must not take a notification
    // engine down.
    return now.toISOString().slice(0, 10);
  }
}

export interface MakeMemoryInput {
  person: string;
  type: MemoryType;
  text: string;
  status?: MemoryStatus;
  confidence?: MemoryConfidence;
  occurredAt?: string;
  dueAt?: string;
  anniversary?: string;
  supersedes?: string;
  verbatim?: string;
  reason?: string;
  id?: string;
  now?: Date;
}

/** Default status per type, chosen so capture does not have to reason about it. */
const STATUS_FOR_TYPE: Record<MemoryType, MemoryStatus> = {
  promise: "open",
  event: "active",
  trait: "active",
  taboo: "active",
  howto: "active",
  update: "active",
  // A correction is live until it is revised or revoked. `open` would make it a
  // promise, which it is not; `active` is a standing fact about how to work.
  correction: "active",
};

export function makeMemory(input: MakeMemoryInput): PersonMemory {
  const now = input.now ?? new Date();
  const stamp = now.toISOString();

  if (!MEMORY_TYPES.includes(input.type)) {
    throw new Error(`Unknown memory type: ${input.type}`);
  }
  if (!input.person.trim()) {
    // Refusing a nameless memory is deliberate. A claim with no subject cannot
    // be shown in a brief, cannot be checked, and is how hallucinations about
    // people we have never heard of get in.
    throw new Error("A memory needs a person. Refusing to store a subjectless claim.");
  }
  if (!input.text.trim()) {
    throw new Error("A memory needs a claim. Refusing to store an empty one.");
  }

  // ── Dates are validated HERE, not only on read ──────────────────────────────
  //
  // parseMemory refuses a memory whose dates it cannot verify, which is right. But
  // until now that meant a bad date could still be written: the endpoint took
  // whatever the request body said, makeMemory stored it, the caller got a 201 and
  // a blob id, and the memory was then invisible to the ledger, the nudges, the
  // tasks and the export -- permanently, while blobCount still counted it.
  //
  // A write that reports success and cannot be read back is the worst outcome
  // this store has, and it was reachable by a hand-typed "next friday".
  //
  // Validating at creation means the value is checked once, by the same code that
  // will later read it, and a bad date is refused before it can become a
  // permanently orphaned blob.
  for (const [key, value] of [["occurredAt", input.occurredAt], ["dueAt", input.dueAt]] as const) {
    if (value !== undefined && !(typeof value === "string" && isRealISODate(value))) {
      throw new Error(`A memory's ${key} must be an ISO date (YYYY-MM-DD). Refusing to store "${value}".`);
    }
  }
  if (input.anniversary !== undefined && !isAnniversaryOrUndefined(input.anniversary)) {
    throw new Error(
      `A memory's anniversary must be a real MM-DD day. Refusing to store "${input.anniversary}".`,
    );
  }

  return {
    id: input.id ?? makeMemoryId(now),
    rev: 1,
    person: input.person.trim(),
    type: input.type,
    status: input.status ?? STATUS_FOR_TYPE[input.type],
    // Extracted-but-unreviewed is the only safe default for a new write. The
    // user can promote it; nothing promotes it for them.
    confidence: input.confidence ?? "inferred",
    text: input.text.trim(),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    ...(input.dueAt ? { dueAt: input.dueAt } : {}),
    ...(input.anniversary ? { anniversary: input.anniversary } : {}),
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    ...(input.verbatim ? { verbatim: input.verbatim } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * Renders a memory for storage.
 *
 * The key ordering in the JSON block is fixed rather than incidental, so the
 * stored bytes are deterministic for a given memory. That makes it possible to
 * diff two serialisations and know nothing but the values changed.
 */
export function serializeMemory(memory: PersonMemory): string {
  const meta: MemoryMeta = {
    id: memory.id,
    rev: memory.rev,
    person: memory.person,
    type: memory.type,
    status: memory.status,
    confidence: memory.confidence,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
  // Written in a fixed order, and only when present, so the common case stays
  // small and the optional fields cluster at the end.
  if (memory.occurredAt) meta.occurredAt = memory.occurredAt;
  if (memory.dueAt) meta.dueAt = memory.dueAt;
  if (memory.anniversary) meta.anniversary = memory.anniversary;
  if (memory.supersedes) meta.supersedes = memory.supersedes;
  if (memory.verbatim) meta.verbatim = memory.verbatim;
  // After verbatim, so the byte order of every pre-existing memory is unchanged.
  if (memory.reason) meta.reason = memory.reason;
  if (memory.deleted) meta.deleted = true;

  return `${memory.text}\n${SENTINEL}${JSON.stringify(meta)}`;
}

/**
 * Parses a stored blob back into a memory.
 *
 * Returns null — never a partial object — for anything that is not one of ours:
 * foreign blobs sharing the namespace, a truncated write, or a hand-edited
 * string. Callers must be able to skip what they cannot parse instead of
 * trusting a half-decoded claim.
 */
export function parseMemory(raw: string): PersonMemory | null {
  if (typeof raw !== "string") return null;

  // rsplit: use the LAST sentinel, so a claim that somehow contains the marker
  // text cannot truncate the payload.
  const at = raw.lastIndexOf(`\n${SENTINEL}`);
  if (at === -1) return null;

  const text = raw.slice(0, at).trim();
  if (!text) return null;

  // A payload carrying an id but no rev predates the revision counter. Rather
  // than reject it and silently drop a real memory from someone's book, treat
  // it as rev 1 and let a later write supersede it.
  let meta: unknown;
  try {
    meta = JSON.parse(raw.slice(at + 1 + SENTINEL.length));
  } catch {
    return null;
  }
  if (typeof meta === "object" && meta !== null && !("rev" in meta)) {
    (meta as Record<string, unknown>).rev = 1;
  }
  if (!isMeta(meta)) return null;

  return {
    ...meta,
    text,
  };
}

function isMeta(value: unknown): value is MemoryMeta {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;

  if (typeof m.id !== "string" || !m.id) return false;
  if (typeof m.rev !== "number" || !Number.isFinite(m.rev) || m.rev < 1) return false;
  if (typeof m.person !== "string" || !m.person) return false;
  if (typeof m.text !== "undefined" && typeof m.text !== "string") return false;
  if (!MEMORY_TYPES.includes(m.type as MemoryType)) return false;
  if (!isStatus(m.status)) return false;
  if (m.confidence !== "confirmed" && m.confidence !== "inferred") return false;
  if (!isISOOrUndefined(m.occurredAt)) return false;
  if (!isISOOrUndefined(m.dueAt)) return false;
  if (!isAnniversaryOrUndefined(m.anniversary)) return false;
  if (typeof m.supersedes !== "undefined" && typeof m.supersedes !== "string") return false;
  if (typeof m.reason !== "undefined" && typeof m.reason !== "string") return false;
  if (typeof m.verbatim !== "undefined" && typeof m.verbatim !== "string") return false;
  if (typeof m.deleted !== "undefined" && typeof m.deleted !== "boolean") return false;
  if (typeof m.createdAt !== "string" || !m.createdAt) return false;
  if (typeof m.updatedAt !== "string" || !m.updatedAt) return false;

  return true;
}

function isStatus(value: unknown): value is MemoryStatus {
  return (
    value === "open" ||
    value === "kept" ||
    value === "missed" ||
    value === "settled" ||
    value === "active"
  );
}

function isISOOrUndefined(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && ISO_DATE.test(value));
}

/**
 * Whether a string is a date that actually exists.
 *
 * `ISO_DATE` only checks the shape, so "2026-13-45" satisfies it -- and a memory
 * carrying that is perfectly readable while being unable to ever come due. A
 * silently-dead task is worse than a rejected one.
 *
 * Deliberately used on the WRITE path only. Tightening the read side as well
 * would turn every already-stored impossible date into an unreadable blob, which
 * is the silent-loss failure this whole check exists to prevent. Refusing new ones
 * costs nothing and orphans nothing.
 */
function isRealISODate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  // Day 0 of the next month is the last day of this one, which handles February
  // in a leap year without a special case.
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Strips the machine block for display. Any string that reaches a human goes
 * through this — nudges, briefs and the ledger all show the claim, never the
 * serialisation.
 */
export function toDisplayText(raw: string): string {
  return parseMemory(raw)?.text ?? raw;
}

/**
 * Produces the next revision of a memory: same id, bumped `rev`, fresh
 * `updatedAt`, with the caller's changes applied.
 *
 * Every rewrite goes through here — status flips, promotion from inferred to
 * confirmed, verbatim opt-in, and tombstones. Centralising it means `rev` can
 * never be forgotten on one of those paths, which is exactly the kind of
 * omission that makes a ledger quietly disagree with itself.
 */
export function reviseMemory(
  memory: PersonMemory,
  patch: Partial<Omit<PersonMemory, "id" | "createdAt" | "rev">>,
  now: Date = new Date(),
): PersonMemory {
  const next: PersonMemory = {
    ...memory,
    ...patch,
    id: memory.id,
    rev: memory.rev + 1,
    createdAt: memory.createdAt,
    updatedAt: now.toISOString(),
  };

  // Optional fields are dropped rather than set to undefined, so a rewrite that
  // clears a date does not leave a `"dueAt":undefined` hole in the JSON.
  for (const key of ["occurredAt", "dueAt", "supersedes", "verbatim", "reason"] as const) {
    if (next[key] === undefined) delete next[key];
  }
  if (next.deleted !== true) delete next.deleted;

  return next;
}

/**
 * Newest write for a given id wins.
 *
 * MemWal is append-only and has no delete, so the same id can appear many times
 * — a superseded fact, a status change, a tombstone. Collapsing on
 * (`rev`, `updatedAt`) means the ledger shows current state while the raw
 * namespace still holds the full history, which is the behaviour we actually
 * want.
 *
 * The comparison is a total order over (rev, updatedAt, id) so the result does
 * not depend on the order the relayer happened to return results in. Relying on
 * `updatedAt` alone was a real bug: two writes in the same millisecond tie, and
 * `>=` resolved the tie by array position, so a status flip could lose.
 */
export function collapseById(memories: PersonMemory[]): PersonMemory[] {
  const latest = new Map<string, PersonMemory>();
  for (const m of memories) {
    const prev = latest.get(m.id);
    if (!prev || isNewer(m, prev)) {
      latest.set(m.id, m);
    }
  }
  return [...latest.values()];
}

function isNewer(candidate: PersonMemory, incumbent: PersonMemory): boolean {
  if (candidate.rev !== incumbent.rev) return candidate.rev > incumbent.rev;
  if (candidate.updatedAt !== incumbent.updatedAt) {
    return candidate.updatedAt > incumbent.updatedAt;
  }
  // Pathological: same id, same rev, same instant. Fall back to a stable
  // comparison so the fold is deterministic rather than order-dependent.
  return candidate.text > incumbent.text;
}

/** Tombstones and foreign blobs never reach the UI. */
export function isLive(memory: PersonMemory): boolean {
  return memory.deleted !== true;
}
