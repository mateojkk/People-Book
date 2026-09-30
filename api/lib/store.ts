/**
 * The memory store: typed CRUD on top of MemWal's flat text blobs.
 *
 * ── Three things this file is careful about ─────────────────────────────────
 *
 * 1. Deletion. MemWal ships no delete. The mock client has a `forget`, the real
 *    one does not, so code written against the mock silently appears to work
 *    while the next recall resurrects everything. We therefore implement forget
 *    as an append: a new blob with the same id and `deleted: true`, collapsed
 *    on read. The raw history stays on Walrus — we do not pretend to erase
 *    immutable storage — but it stops being visible or actionable, which is the
 *    part a user actually needs.
 *
 * 2. Enumeration. MemWal has no "list all memories" call; `recall` is top-K
 *    semantic search only. So the ledger is assembled by fanning out a fixed
 *    set of broad queries and unioning the results, deduped by blob id. That is
 *    a genuine coverage ceiling at large scale, and it is documented in the
 *    README rather than hidden. `memoryCount()` from listNamespaces is the
 *    authoritative total, so the UI can tell the truth about coverage instead
 *    of implying the ledger is complete when it is not.
 *
 * 3. Honesty on failure. A write that did not land throws. Nothing here reports
 *    success for a write that did not happen, because the failure mode is a
 *    memory the user later sees quoted back to them as something they said.
 */

import { MemWal } from "@mysten-incubation/memwal";
import {
  collapseById,
  isLive,
  makeMemory,
  type MakeMemoryInput,
  parseMemory,
  reviseMemory,
  serializeMemory,
} from "../../shared/memory-codec.ts";
import type { PersonMemory } from "../../shared/types.ts";
import { NAMESPACE, RECALL_LIMIT, dropClient, getClient, withWriteRetry } from "./memwal.ts";

/**
 * Broad queries used to enumerate a namespace.
 *
 * Each one is phrased to be semantically close to a different slice of the book,
 * because recall is embedding search: asking once for "everything" returns the
 * things most similar to the word "everything", not the namespace. Spread across
 * types, plus a catch-all, this covers a personal book well.
 */
const ENUMERATION_QUERIES: readonly string[] = [
  "a promise I made to someone",
  "a date that matters, a birthday or an appointment",
  "something I should never mention to them",
  "how to be with them, how they like to be contacted",
  "something that happened, a change, a piece of news",
  "a fact about who they are, their life, their situation",
  "something about me, my own commitments and habits",
  "people I know and what I owe them",
];

export interface StoreOptions {
  accountId: string;
  namespace?: string;
}

export class MemoryNotFoundError extends Error {
  readonly code = "memory_not_found";
  constructor(id: string) {
    super(`No memory with id ${id} in this account.`);
    this.name = "MemoryNotFoundError";
  }
}

export class PeopleBookStore {
  private readonly accountId: string;
  private readonly namespace: string;
  private client: MemWal | null = null;

  constructor(options: StoreOptions) {
    this.accountId = options.accountId;
    this.namespace = options.namespace ?? NAMESPACE;
  }

  private get(): MemWal {
    if (!this.client) this.client = getClient(this.accountId, this.namespace);
    return this.client;
  }

  /** Drops a wedged client so the next call rebuilds it. */
  reset(): void {
    dropClient(this.accountId, this.namespace);
    this.client = null;
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Appends a memory. Returns what was stored, with the assigned id.
   *
   * Retried once via withWriteRetry on relayer throttling. The retry writes the
   * SAME text with the SAME id, so if the first attempt did land and only the
   * ack was lost, the second write is a byte-identical duplicate that collapses
   * away — it does not double-write.
   */
  async remember(input: MakeMemoryInput): Promise<PersonMemory> {
    const memory = makeMemory(input);
    await this.writeBlob(serializeMemory(memory), `${memory.id}:1`);
    return memory;
  }

  /** Appends a new revision of an existing memory (status change, promotion, tombstone). */
  async revise(memory: PersonMemory, patch: Partial<Omit<PersonMemory, "id" | "createdAt" | "rev">>): Promise<PersonMemory> {
    const next = reviseMemory(memory, patch);
    await this.writeBlob(serializeMemory(next), `${next.id}:${next.rev}`);
    return next;
  }

  private async writeBlob(text: string, idempotencyKey: string): Promise<void> {
    try {
      await withWriteRetry(() => this.get().rememberAndWait(text, this.namespace, { idempotencyKey } as never));
    } catch (error) {
      // A wedged client is the most common cause of a persistent failure here.
      this.reset();
      throw error;
    }
  }

  /**
   * Forgets a memory.
   *
   * Writes a tombstone rather than mutating anything. If the write fails, the
   * caller must be told — a failed delete that reports success leaves a memory
   * the user asked to be rid of still on their book, and still able to produce
   * nudges.
   */
  async forget(id: string): Promise<PersonMemory> {
    const current = await this.getById(id);
    if (!current) throw new MemoryNotFoundError(id);
    if (current.deleted === true) return current;

    return this.revise(current, { deleted: true });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * Fans out the enumeration queries and unions the hits.
   *
   * Runs the queries concurrently because each one is a relayer round trip and
   * they are independent. Failures on individual queries are tolerated — a
   * partial ledger is still a ledger — but if every query fails we surface the
   * error rather than returning an empty book that looks like a fresh account.
   */
  async listLive(): Promise<{ memories: PersonMemory[]; coverage: "complete" | "partial" }> {
    const results = await Promise.allSettled(
      ENUMERATION_QUERIES.map((query) => this.get().recall({ query, limit: RECALL_LIMIT, namespace: this.namespace })),
    );

    const blobs = new Map<string, string>();
    let failed = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        failed += 1;
        continue;
      }
      for (const hit of result.value.results ?? []) {
        // Dedupe by blob id. The same memory is legitimately returned by several
        // queries, and the stored text differs per revision, so the blob id is
        // the only honest key here.
        blobs.set(hit.blob_id, hit.text);
      }
    }

    if (failed === ENUMERATION_QUERIES.length) {
      throw new Error("Walrus Memory did not respond. We could not read your book, so we are not going to show you an empty one.");
    }

    const parsed: PersonMemory[] = [];
    for (const text of blobs.values()) {
      const memory = parseMemory(text);
      if (memory) parsed.push(memory);
    }

    const collapsed = collapseById(parsed).filter(isLive);
    collapsed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { memories: collapsed, coverage: failed > 0 ? "partial" : "complete" };
  }

  /**
   * Fetches one memory by id.
   *
   * Walrus is not random-accessible by our own id, so this leans on recall and
   * then filters. Exact-id equality is required afterwards — a near miss would be
   * far worse than no result, because it could return someone else's memory
   * under the wrong id.
   */
  async getById(id: string): Promise<PersonMemory | null> {
    const { memories } = await this.listLive();
    return memories.find((m) => m.id === id) ?? null;
  }

  /**
   * Authoritative blob count for this account, straight from the relayer.
   *
   * This is what the hackathon submission asks for as proof, and it is also the
   * honest way to tell a user whether the ledger above is the whole book: if
   * this number is larger than the list, the ledger is partial and we say so.
   */
  async memoryCount(): Promise<number | null> {
    try {
      const { namespaces } = await this.get().listNamespaces({ limit: 500 });
      const mine = namespaces.find((n) => n.name === this.namespace);
      return mine?.memory_count ?? 0;
    } catch {
      return null;
    }
  }

  /** Probes the relayer and the delegate key, for the health endpoint. */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const result = await this.get().health();
      const healthy = (result as { status?: string })?.status !== "unhealthy";
      return { ok: healthy, detail: healthy ? "relayer reachable" : "relayer reported unhealthy" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Writes many memories, used by the demo cast loader.
   *
   * Sequential rather than bulk because the relayer throttles aggressively under
   * concurrent writes, and a bulk call that half-fails gives the user a demo
   * book that is quietly incomplete. Slow and honest beats fast and wrong.
   */
  async seed(memories: MakeMemoryInput[]): Promise<PersonMemory[]> {
    const written: PersonMemory[] = [];
    for (const input of memories) {
      written.push(await this.remember(input));
    }
    return written;
  }
}
