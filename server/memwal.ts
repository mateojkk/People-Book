/**
 * Server-side MemWal client construction.
 *
 * ── Transitional ─────────────────────────────────────────────────────────────
 *
 * This file is what the migration away from a server-held key is dismantling. The
 * browser now holds the delegate keypair (see src/lib/memwal.ts) and signs every
 * request itself; /api/memwal relays them to the relayer without a key.
 *
 * What remains here is the old path, kept working only so the migration can be
 * verified one step at a time rather than all at once. `getClient()` reads a key
 * from the environment, which is precisely the thing that must not survive.
 *
 * The isomorphic half — namespace constants, error types, write retry — now lives
 * in shared/memwal.ts, so the browser never has to pull this module in.
 *
 * DELETE along with MEMWAL_DELEGATE_KEY, `npm run keygen`, and the `delegate`
 * flag in /api/health.
 */

import { MemWal } from "@mysten-incubation/memwal";
import { MemWalConfigError, MEMWAL_REQUEST_TIMEOUT_MS, assertAppNamespace } from "../shared/memwal.ts";

export {
  NAMESPACE_PREFIX,
  NAMESPACE,
  assertAppNamespace,
  RECALL_LIMIT,
  MEMWAL_REQUEST_TIMEOUT_MS,
  MemWalConfigError,
  MemWalWriteError,
  withWriteRetry,
  isConfigError,
  isWriteError,
} from "../shared/memwal.ts";

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
 * then granted a delegate key into. It is never guessed and never defaulted: an
 * account id we were not given is a memory space we have no right to touch.
 */
export function getClient(accountId: string, namespace: string = "book"): MemWal {
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
    requestTimeoutMs: MEMWAL_REQUEST_TIMEOUT_MS,
  });
  clients.set(`${accountId}::${namespace}`, client);
  return client;
}

/**
 * Disposes cached clients. Called from the error path of long-lived processes so
 * a wedged client does not poison every later request.
 */
export function dropClient(accountId: string, namespace: string = "book"): void {
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