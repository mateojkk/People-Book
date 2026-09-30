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
