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
import {
  NAMESPACE,
  RECALL_LIMIT,
  assertAppNamespace,
  dropClient,
  getClient,
  withWriteRetry,
} from "./memwal.ts";

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

/**
 * Enumeration tuning, all of it measured against the production relayer.
 *
 * CONCURRENCY: eight concurrent recalls at limit 200 against one relayer is
 * enough to trip its throttle, and being throttled by our own read pattern is
 * avoidable. Batches of two keep the ledger read well inside a normal request.
 *
 * ATTEMPTS/BACKOFF: the first recall after a write took 22.6s against a 3.5s
 * warm baseline, and fails outright during that window. One retry is enough to
 * cover index lag without turning a read into a minute-long request.
 */
const ENUMERATION_CONCURRENCY = 2;
const ENUMERATION_ATTEMPTS = 3;
const ENUMERATION_BACKOFF_MS = 1_500;

/**
 * A ceiling on one enumeration, and a per-recall timeout beneath it.
 *
 * Enumeration is eight recalls run two at a time, so its cost is four sequential
 * rounds. Measured against the live relayer that is 20-35s per request, and
 * while that holds there is no timeout anywhere in the path: the request hangs
 * until the dev proxy gives up and answers 502, which reads as "the app is
 * broken" rather than "the network was slow".
 *
 * So the budget is explicit. Past it, whatever came back is returned as partial,
 * which is already a state this function knows how to report honestly, and the
 * user gets a short ledger instead of an error page. A single recall that hangs
 * is bounded too, so one stuck call cannot eat the whole budget.
 */
const ENUMERATION_BUDGET_MS = 20_000;
const RECALL_TIMEOUT_MS = 12_000;

/** Fails a call that outlives its budget, without pretending to cancel it. */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A short-lived cache of the enumerated ledger, per account and namespace.
 *
 * Long enough that one screen's worth of parallel reads collapses into a single
 * enumeration, short enough that a write is visible almost immediately. This is
 * deliberately not a durable cache: the ledger is the user's memory, and the
 * only thing being avoided is asking the relayer the same question twice in one
 * render.
 */
const ENUMERATION_TTL_MS = 15_000;

/**
 * `all` is every revision of every memory, uncollapsed. `memories` is the same
 * set folded down to the latest revision of each id.
 *
 * Both are kept because they answer different questions: "what does it know" wants
 * `memories`, and "what did it used to believe, and when did that change" wants
 * `all`. Carrying both out of one enumeration means history costs no extra
 * requests, which is the difference between a feature that ships and one that is
 * always one query away from being cut.
 */
type Enumeration = {
  all: PersonMemory[];
  memories: PersonMemory[];
  coverage: "complete" | "partial";
};
const enumerationCache = new Map<string, { at: number; value: Enumeration }>();
/** Bumped on every write; see invalidate(). */
const enumerationGeneration = new Map<string, number>();
const enumerationsInFlight = new Map<string, Promise<Enumeration>>();

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
    // Validated here, at construction, rather than left to the first read.
    // getClient() also checks, but that is lazy: a misconfigured store would
    // build fine and only fail on the first query, which is late enough for the
    // failure to look like a relayer problem rather than a wiring mistake.
    this.namespace = assertAppNamespace(options.namespace ?? NAMESPACE);
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
  /**
   * Drops the cached enumeration.
   *
   * Every write must call this, and none of them did. The cache holds a 15-second
   * enumeration, so after any write the next read returned a book that did not
   * contain what had just been written. That is the bug behind "saving takes
   * forever": the save succeeded, the response re-read from cache, and the UI
   * showed the old value, so it looked like nothing happened and you pressed it
   * again.
   *
   * Not a performance trade. A cache that does not know about the writes it is
   * caching is not a cache, it is a way of being confidently wrong for 15 seconds.
   */
  private invalidate(): void {
    const key = `${this.accountId}:${this.namespace}`;
    enumerationCache.delete(key);
    // Bumping the generation means any enumeration already in flight started
    // before this write, and must not be allowed to cache its now-stale result
    // on completion. Deleting the entry alone does not help: the in-flight
    // promise resolves afterwards and writes the old view straight back.
    enumerationGeneration.set(key, (enumerationGeneration.get(key) ?? 0) + 1);
  }

  async remember(input: MakeMemoryInput): Promise<PersonMemory> {
    const memory = makeMemory(input);
    await this.writeBlob(serializeMemory(memory), `${memory.id}:1`);
    this.invalidate();
    return memory;
  }

  /** Appends a new revision of an existing memory (status change, promotion, tombstone). */
  async revise(memory: PersonMemory, patch: Partial<Omit<PersonMemory, "id" | "createdAt" | "rev">>): Promise<PersonMemory> {
    const next = reviseMemory(memory, patch);
    await this.writeBlob(serializeMemory(next), `${next.id}:${next.rev}`);
    this.invalidate();
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
    // Already gone. That is the state the caller asked for, so it is success.
    // The guard was unreachable while getById filtered tombstones, which is why
    // forgetting twice used to throw.
    if (current.deleted === true) return current;

    return this.revise(current, { deleted: true });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * Runs one enumeration query, retrying transient failures.
   *
   * Retrying is not defensive padding, it is required for correctness right
   * after a write. Measured against production: the first recall following a
   * bulk write took 22.6s while the same query took 3.5s once the index caught
   * up, and during that window the queries fail rather than returning thin
   * results. Without a retry, a verification read immediately after seeding
   * concludes the whole namespace is empty — which is exactly the false negative
   * this method exists to avoid.
   */
  private async queryWithRetry(query: string): Promise<{ blobId: string; text: string }[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= ENUMERATION_ATTEMPTS; attempt += 1) {
      try {
        const result = await withDeadline(
          this.get().recall({
            query,
            limit: RECALL_LIMIT,
            namespace: this.namespace,
          }),
          RECALL_TIMEOUT_MS,
          `recall "${query}"`,
        );
        return (result.results ?? []).map((hit) => ({ blobId: hit.blob_id, text: hit.text }));
      } catch (error) {
        lastError = error;
        if (attempt < ENUMERATION_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, ENUMERATION_BACKOFF_MS * attempt));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Fans out the enumeration queries and unions the hits.
   *
   * Queries run in small batches rather than all at once: eight concurrent
   * high-limit recalls against one relayer is enough to trigger its throttle,
   * and being throttled by our own read pattern is not a good look.
   *
   * Partial failure is tolerated and reported as `coverage: "partial"`, because
   * a short ledger is more useful than none. If every query fails we surface the
   * error rather than returning an empty book that looks like a fresh account.
   */
  async listLive(): Promise<{ memories: PersonMemory[]; coverage: "complete" | "partial" }> {
    // One enumeration, shared. The UI asks for the ledger, the nudges and the
    // people list on the same render, and each of those wants the same eight
    // recalls. Without this they run concurrently and the relayer sees three
    // enumerations at once, which is both slower per request and a good way to
    // get throttled. In-flight dedupe plus a short TTL turns that into one.
    const key = `${this.accountId}:${this.namespace}`;
    const running = enumerationsInFlight.get(key);
    if (running) return running;

    const work = this.enumerate();
    enumerationsInFlight.set(key, work);
    try {
      const fresh = await work;
      enumerationCache.set(key, { at: Date.now(), value: fresh });
      return fresh;
    } finally {
      enumerationsInFlight.delete(key);
    }
  }

  /**
   * enumerate(), but sharing the in-flight dedupe and the cache with listLive.
   */
  private async enumerateCached(): Promise<Enumeration> {
    const key = `${this.accountId}:${this.namespace}`;
    const running = enumerationsInFlight.get(key);
    if (running) return running;

    const work = this.enumerate();
    enumerationsInFlight.set(key, work);
    try {
      return await work;
    } finally {
      enumerationsInFlight.delete(key);
    }
  }

  private async enumerate(): Promise<Enumeration> {
    const key = `${this.accountId}:${this.namespace}`;
    const cached = enumerationCache.get(key);
    if (cached && Date.now() - cached.at < ENUMERATION_TTL_MS) return cached.value;
    const generationAtStart = enumerationGeneration.get(key) ?? 0;

    const blobs = new Map<string, string>();
    let failed = 0;
    let lastError: unknown;

    const deadline = Date.now() + ENUMERATION_BUDGET_MS;

    for (let i = 0; i < ENUMERATION_QUERIES.length; i += ENUMERATION_CONCURRENCY) {
      // Out of budget: stop here and report what we have. A truncated ledger
      // that says it is truncated beats a request that never returns.
      if (Date.now() >= deadline) {
        failed += ENUMERATION_QUERIES.length - i;
        break;
      }
      const batch = ENUMERATION_QUERIES.slice(i, i + ENUMERATION_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map((q) => this.queryWithRetry(q)));
      for (const result of settled) {
        if (result.status === "rejected") {
          failed += 1;
          lastError = result.reason;
          continue;
        }
        for (const hit of result.value) {
          // Dedupe by blob id, not by text. The same memory is legitimately
          // returned by several queries, and two REVISIONS of one memory are two
          // different blobs with the same logical id — so a text key would
          // either merge them wrongly or fail to merge the identical repeats.
          blobs.set(hit.blobId, hit.text);
        }
      }
    }

    if (failed === ENUMERATION_QUERIES.length) {
      throw new Error(
        `Walrus Memory did not respond. We could not read your book, so we are not going to show you an empty one. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }

    const parsed: PersonMemory[] = [];
    for (const text of blobs.values()) {
      const memory = parseMemory(text);
      if (memory) parsed.push(memory);
    }

    const collapsed = collapseById(parsed).filter(isLive);
    collapsed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { all: parsed, memories: collapsed, coverage: failed > 0 ? "partial" : "complete" };
  }

  /**
   * Every revision of one memory, oldest first.
   *
   * `listLive` folds each id down to its latest revision, which is correct for
   * reading and throws the rest away. Those revisions are not history on our side
   * -- they are separate immutable blobs on chain, one per write, keyed
   * `${id}:${rev}`, and they stay there after a correction. So the chain of what
   * was believed, and when it changed, is sitting there already.
   *
   * This is what makes a correction inspectable rather than merely stored: you can
   * ask what it thought in March and get the March answer, not the current one.
   */
  async listHistory(id: string): Promise<PersonMemory[]> {
    // Through listLive, not enumerate directly. enumerate is the raw worker; the
    // dedupe and the cache live in listLive. Calling enumerate here meant a
    // /history request ran alongside a ledger read instead of joining it -- which
    // doubled the relayer fan-out and pushed peak concurrency past
    // ENUMERATION_CONCURRENCY, which is the throttling the constants exist to
    // avoid.
    const { all } = await this.enumerateCached();
    return all
      .filter((m) => m.id === id)
      .sort((a, b) => a.rev - b.rev);
  }

  /**
   * Every live correction, as rules rather than facts.
   *
   * Separate from listLive on purpose. The ledger renders these among other
   * people's facts, which is where they get read as trivia; the prompt needs them
   * grouped and labelled as binding.
   */
  async listCorrections(): Promise<PersonMemory[]> {
    const { memories } = await this.listLive();
    return memories.filter((m) => m.type === "correction");
  }

  /**
   * Fetches one memory by id.
   *
   * Walrus is not random-accessible by our own id, so this leans on recall and
   * then filters. Exact-id equality is required afterwards — a near miss would be
   * far worse than no result, because it could return someone else's memory
   * under the wrong id.
   */
  /**
   * One memory by id, INCLUDING a tombstoned one.
   *
   * This used to read through listLive(), which filters tombstones out. So a
   * forgotten memory was unfindable, and `forget`'s own idempotency guard below
   * could never fire -- forgetting twice threw MemoryNotFoundError instead of
   * returning quietly. Double-clicking Undo, or a retried undo after a partial
   * failure, surfaced "That memory is already gone" as an error.
   *
   * It also made two `deleted === true` checks elsewhere unreachable, and meant
   * no route could ever bring a memory back.
   *
   * Tombstones are filtered at the edges -- listLive for reading, listCorrections
   * and listHistory as appropriate -- not here. A lookup by exact id is how you
   * check whether something was deleted.
   */
  async getById(id: string): Promise<PersonMemory | null> {
    const { all } = await this.enumerate();
    const matching = all.filter((m) => m.id === id);
    if (!matching.length) return null;
    return matching.reduce((a, b) => (b.rev > a.rev ? b : a));
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
   * Writes many memories concurrently, for the demo cast loader.
   *
   * Sequential writes cost ~45s each on mainnet, which is ~18 minutes for a
   * 25-person book — unusable for a one-click demo. Bulk brings that down to
   * roughly the time of the slowest item.
   *
   * Bulk is treated as UNTRUSTED here. `rememberBulkAndWait` is documented to
   * return one result per input item, in order, with a per-item status, and there
   * is a known case of a batch being accepted while nothing lands. So the result
   * is checked twice: per-item status first, then a re-read to confirm the claims
   * are actually recallable. A seed that quietly half-wrote would leave a judge
   * looking at a book that is missing people, which is worse than a visible error.
   */
  async seedBulk(inputs: MakeMemoryInput[]): Promise<{ written: PersonMemory[]; failed: string[] }> {
    if (inputs.length === 0) return { written: [], failed: [] };
    // Seeding writes dozens of blobs. Dropping the cache once at the end rather
    // than per write: a seed is a bulk load, and invalidating per item would only
    // make the enumeration that follows slower.
    this.invalidate();

    // The relayer caps a bulk request at 20 items. Chunked at 10 rather than 20
    // to stay under the limit with margin, and because a smaller batch is less
    // likely to be throttled into a partial landing.
    const CHUNK = 10;
    const chunks: MakeMemoryInput[][] = [];
    for (let i = 0; i < inputs.length; i += CHUNK) {
      chunks.push(inputs.slice(i, i + CHUNK));
    }

    const written: PersonMemory[] = [];
    const failed: string[] = [];

    // Chunks are sequential, items within a chunk are concurrent. Going fully
    // parallel would mean several batches in flight at once, which is exactly
    // the load the relayer throttles.
    for (const chunk of chunks) {
      const memories = chunk.map((input) => makeMemory(input));
      const items = memories.map((memory) => ({ text: serializeMemory(memory) }));

      let result: Awaited<ReturnType<MemWal["rememberBulkAndWait"]>> | null = null;
      try {
        result = await this.get().rememberBulkAndWait(items, {
          pollIntervalMs: 2_000,
          // Generous: mainnet seal + embed + upload runs ~45s per item, and a
          // congested relayer is slower. Bounded so a stuck batch fails loudly.
          timeoutMs: 300_000,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        for (const memory of memories) failed.push(`${memory.person}: ${detail}`);
        continue;
      }

      memories.forEach((memory, index) => {
        const item = result?.results?.[index];
        if (!item || item.status !== "done" || !item.blob_id) {
          failed.push(`${memory.person}: ${item?.error ?? item?.status ?? "no result returned"}`);
        } else {
          written.push(memory);
        }
      });
    }

    // Final re-read, because a "done" status is the server's word for it and the
    // only proof is that the text comes back out of a recall.
    const { memories: readBack } = await this.listLive();
    const recalled = new Set(readBack.map((m) => m.id));
    const confirmed = written.filter((m) => recalled.has(m.id));
    const unconfirmed = written.filter((m) => !recalled.has(m.id));

    return {
      written: confirmed,
      failed: [
        ...failed,
        ...unconfirmed.map((m) => `${m.person}: reported done but did not come back on recall`),
      ],
    };
  }

  /** Sequential writes. Used for small batches where clarity beats speed. */
  async seed(memories: MakeMemoryInput[]): Promise<PersonMemory[]> {
    const written: PersonMemory[] = [];
    for (const input of memories) {
      written.push(await this.remember(input));
    }
    return written;
  }
}
