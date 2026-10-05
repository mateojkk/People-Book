/**
 * MemWal primitives that are safe to run in a browser.
 *
 * ── What lives here and why it is separated ──────────────────────────────────
 *
 * The delegate keypair lives in the user's browser, not on the server. That means
 * everything the browser needs to talk to the relayer has to be free of
 * `process.env`, `node:` imports and server-only paths — a single stray reference
 * drags the whole server module graph into the client bundle.
 *
 * So the file that used to hold both halves is split. The namespace constants, the
 * error types and the write retry are isomorphic and live here. The client cache,
 * `getClient()` and `dropClient()` read a key out of the environment and stay
 * server-side until they are deleted outright.
 *
 * Nothing here holds, reads, or derives a key.
 */

/**
 * The one namespace this app ever reads or writes.
 *
 * FORCED, not configurable. Every store is constructed from this constant and
 * nothing accepts a namespace from a request, because a caller who could name a
 * namespace could read a different one. Isolation here is "we decide", not "you
 * decide".
 *
 * The `book-` prefix is what stops us encroaching on someone else's memory. A
 * Walrus account can hold many namespaces, and a user connecting their wallet may
 * already have memories there from other apps or their own use. This app must
 * only ever touch its own, and the prefix is the boundary that makes that
 * checkable rather than merely intended: assertAppNamespace() below refuses
 * anything not prefixed `book-`, so a future route, a refactor or a bad constant
 * fails loudly instead of quietly reading someone else's book.
 *
 * To change the suffix, this is the only line to touch.
 */
export const NAMESPACE_PREFIX = "book";
export const NAMESPACE = NAMESPACE_PREFIX;

/**
 * Refuses any namespace outside this app's own.
 *
 * `book` itself is the app's namespace; `book-*` is reserved for it, so the
 * live-check script can work in `book-livecheck` without ever being able to point
 * at somebody else's memory. The trailing hyphen matters: without it, `bookshop`
 * and `notebook` would pass.
 *
 * Throwing rather than warning is deliberate. A namespace mistake in a memory
 * layer is not a cosmetic error: it reads or overwrites the wrong data in
 * somebody's account, and the user has no way to see that happened.
 */
export function assertAppNamespace(namespace: string): string {
  if (namespace !== NAMESPACE && !namespace.startsWith(`${NAMESPACE}-`)) {
    throw new Error(
      `Refusing to use namespace "${namespace}": this app only touches ${NAMESPACE} and ${NAMESPACE}-*, so it cannot read or overwrite memory that is not its own.`,
    );
  }
  return namespace;
}

/**
 * 50, not 200. Each enumerate fans out eight recalls and dedupes by blob id
 * *after* downloading, so the limit multiplies directly into bandwidth and
 * decrypt time: 8x200 is up to 1600 blobs per read. Vela does single recalls at
 * limit 50 against the same relayer in milliseconds; at the scale of every book
 * that exists (dozens of memories, not hundreds), eight overlapping queries at
 * 50 cover the same union as eight at 200 for a quarter of the payload.
 *
 * If a book ever outgrows this, enumeration reports partial coverage rather
 * than silently truncating -- that reporting exists precisely so this number
 * can stay small without lying about completeness.
 */
export const RECALL_LIMIT = 50;

/**
 * A write took longer than the relayer's default request timeout allows.
 *
 * Measured against production: rememberAsync returns in ~10s but the job can take
 * ~45s to seal, embed and upload to Walrus. The SDK default is shorter than that,
 * so an ordinary write looks like a network failure. Both the browser client and
 * the old server client set 120s for this reason.
 */
export const MEMWAL_REQUEST_TIMEOUT_MS = 120_000;

export class MemWalConfigError extends Error {
  readonly code = "memwal_config_missing";
  constructor(message: string) {
    super(message);
    this.name = "MemWalConfigError";
  }
}

export class MemWalWriteError extends Error {
  readonly code = "memwal_write_failed";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "MemWalWriteError";
  }
}

/**
 * The relayer throttles writes under load and accepts jobs that then stall past
 * the poll timeout. Both are transient: the same write usually succeeds seconds
 * later.
 *
 * So we retry once with a generous per-attempt cap. We deliberately do NOT retry
 * a third time: past two attempts the honest answer is that the write did not
 * land, and the caller must be told so. Reporting success for a write that never
 * happened is the single worst thing this system could do — it would put a
 * memory in the user's book that does not exist, and they would later be shown it
 * as something they said.
 */
export async function withWriteRetry<T>(
  operation: () => Promise<T>,
  opts: { attempts?: number; perAttemptMs?: number; onRetry?: (error: unknown, attempt: number) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 2;
  // Measured, not guessed. A mainnet write accepts in ~10s and completes in
  // ~45s, so a 25s cap failed writes that were about to succeed — and the retry
  // then raced the first attempt. 90s clears it with room for a congested
  // relayer, while still bounding a genuinely stuck one.
  const perAttemptMs = opts.perAttemptMs ?? 90_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`MemWal write exceeded ${perAttemptMs}ms`)),
          perAttemptMs,
        );
      });
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) opts.onRetry?.(error, attempt);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw new MemWalWriteError(
    "The write did not reach Walrus Memory. Nothing was saved, and we are not going to tell you otherwise.",
    lastError,
  );
}

export function isConfigError(error: unknown): error is MemWalConfigError {
  return error instanceof MemWalConfigError;
}

export function isWriteError(error: unknown): error is MemWalWriteError {
  return error instanceof MemWalWriteError;
}