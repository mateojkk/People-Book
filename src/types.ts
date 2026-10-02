/**
 * Client-side re-exports of the shared contract.
 *
 * The browser and the API must agree exactly on these shapes, so the definitions
 * live in shared/ and are re-exported rather than duplicated. A duplicated type
 * is a silent drift bug waiting for a release.
 */
export type {
  CaptureResult,
  LedgerEntry,
  MemoryCandidate,
  MemoryConfidence,
  MemoryStatus,
  MemoryType,
  Nudge,
  NudgeKind,
  NudgeSet,
  PersonMemory,
} from "../shared/types.ts";
export { SELF, MEMORY_TYPES, CONFIRM_THRESHOLD } from "../shared/types.ts";

/**
 * A repeated claim, computed from the book. Mirrors api/lib/patterns.ts.
 *
 * Declared on the client rather than imported from api/, because the browser
 * bundle should not pull the server module across to describe six fields.
 */
export interface Pattern {
  kind: "repeated-promise" | "unkept" | "slipped";
  person: string;
  claim: string;
  count: number;
  first: string;
  last: string;
  dates: string[];
  memoryIds: string[];
}
