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
} from "./types.ts";

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
  supersedes?: string;
  deleted?: boolean;
  verbatim?: string;
  createdAt: string;
  updatedAt: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

export function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface MakeMemoryInput {
  person: string;
  type: MemoryType;
  text: string;
  status?: MemoryStatus;
  confidence?: MemoryConfidence;
  occurredAt?: string;
  dueAt?: string;
  supersedes?: string;
  verbatim?: string;
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
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    ...(input.verbatim ? { verbatim: input.verbatim } : {}),
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
  if (memory.supersedes) meta.supersedes = memory.supersedes;
  if (memory.verbatim) meta.verbatim = memory.verbatim;
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
  if (typeof m.supersedes !== "undefined" && typeof m.supersedes !== "string") return false;
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
  for (const key of ["occurredAt", "dueAt", "supersedes", "verbatim"] as const) {
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
