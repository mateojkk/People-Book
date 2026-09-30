/**
 * MemWal client construction.
 *
 * The key thing this file exists to enforce: the app holds a DELEGATE key, not
 * a master key. A delegate key is registered on-chain into one specific user's
 * own MemWalAccount, so it cannot address anyone else's memory space. If this
 * process is compromised, the blast radius is the accounts that explicitly
 * granted it — and each of them can revoke it in one transaction without our
 * cooperation. See README > "The memory is yours, provably".
 */

import { MemWal } from "@mysten-incubation/memwal";

/**
 * The one namespace this app ever reads or writes.
 *
 * FORCED, not configurable. Every route constructs its store from this constant
 * and no route accepts a namespace from the request, because a caller who could
 * name a namespace could read a different one. Isolation here is "we decide",
 * not "you decide" — see resolveStore() in api/[[...route]].ts.
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
export const NAMESPACE = `${NAMESPACE_PREFIX}-people`;

/**
 * Refuses any namespace outside this app's prefix.
 *
 * Throwing rather than warning is deliberate. A namespace mistake in a memory
 * layer is not a cosmetic error: it reads or overwrites the wrong data in
 * somebody's account, and the user has no way to see that happened.
 */
export function assertAppNamespace(namespace: string): string {
  if (!namespace.startsWith(`${NAMESPACE_PREFIX}-`)) {
    throw new Error(
      `Refusing to use namespace "${namespace}": this app only touches ${NAMESPACE_PREFIX}-* namespaces, so it cannot read or overwrite memory that is not its own.`,
    );
  }
  return namespace;
}

/**
 * Requests a namespace count this high and the relayer will clamp it. 200 is
 * comfortably above what a personal book reaches (a heavy user is a few
 * hundred memories) while staying inside the documented clamp of 500.
 */
export const RECALL_LIMIT = 200;

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
 * One client per (accountId, namespace), cached for the life of the process.
 *
 * A serverless function is reused across requests, so this cache turns the
 * ledger from one client construction per page view into one per cold start.
 */
const clients = new Map<string, MemWal>();

/**
 * Returns a MemWal client scoped to one user's account.
 *
 * `accountId` is the onchain MemWalAccount object id that the OWNER created and
 * then granted our delegate key into. It is never guessed and never defaulted:
 * an account id we were not given is a memory space we have no right to touch.
 */
export function getClient(accountId: string, namespace: string = NAMESPACE): MemWal {
  assertAppNamespace(namespace);
  const cached = clients.get(`${accountId}::${namespace}`);
  if (cached) return cached;

  // MEMWAL_PRIVATE_KEY is the name the MemWal docs and existing projects use, so
  // it is accepted as a fallback. Same value either way: a 32-byte Ed25519 seed,
  // here granted into a user's own account rather than minted for a shared one.
  // Read without requireEnv, which throws on the first missing name and would
  // never reach the fallback.
  const key = process.env.MEMWAL_DELEGATE_KEY || process.env.MEMWAL_PRIVATE_KEY;
  if (!key) {
    throw new MemWalConfigError(
      "No delegate key configured. Run `npm run keygen` and set MEMWAL_DELEGATE_KEY. Without one there is nowhere to write memory, and we do not pretend otherwise.",
    );
  }
  const serverUrl = process.env.MEMWAL_SERVER_URL ?? "https://relayer.memory.walrus.xyz";

  const client = MemWal.create({
    key,
    accountId,
    serverUrl,
    namespace,
    // Measured against the production relayer: rememberAsync returns in ~10s
    // but the job can take ~45s to seal, embed and upload to Walrus. The default
    // request timeout is shorter than that, so a normal write looks like a
    // network failure.
    requestTimeoutMs: 120_000,
  });
  clients.set(`${accountId}::${namespace}`, client);
  return client;
}

/**
 * Disposes cached clients. Called from the error path of long-lived processes so
 * a wedged client does not poison every later request.
 */
export function dropClient(accountId: string, namespace: string = NAMESPACE): void {
  assertAppNamespace(namespace);
  const cacheKey = `${accountId}::${namespace}`;
  const client = clients.get(cacheKey);
  if (!client) return;
  try {
    client.destroy();
  } catch {
    // destroy() is best-effort. A throw here must not mask the original error.
  }
  clients.delete(cacheKey);
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
