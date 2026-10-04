/**
 * The book, from the browser.
 *
 * This is the data layer the app should be using. It reads and writes the user's
 * own MemWalAccount using a keypair generated on their machine, relayed through
 * /api/memwal. Nothing in this file, or anything it imports, can reach a
 * server-held key.
 *
 * ── How this replaces the old endpoints ──────────────────────────────────────
 *
 * The server used to own MemWal access, so every read and write went over HTTP to
 * a route that held the key. Now the browser does both directly, which means the
 * store-backed routes (`GET /api/memories`, `POST /api/memories`,
 * `DELETE /api/memories/:id`, `/api/tasks/:id/:action`, `/api/chat/undo`,
 * `POST /api/profile`) have no reason to exist — and no key to exist with.
 *
 * What stays server-side is everything that *computes* rather than stores: Groq
 * extraction, grounded replies, nudges, patterns. Those take memories as input
 * and return a result, and the server never needs a key to do them. That is the
 * line this migration draws: **the server remembers nothing.**
 *
 * ── A note on what this costs ────────────────────────────────────────────────
 *
 * Writes now happen where the user is. If the tab closes between extraction and
 * the write landing, that memory is not saved. That is inherent to a server that
 * holds no keys — it cannot sign on the user's behalf when they are not there —
 * and it is why extraction results are written as soon as they arrive rather than
 * batched.
 */

import type { MemWal } from "@mysten-incubation/memwal";
import { PeopleBookStore } from "../../shared/store.js";
import { createBrowserMemWal, getOrCreateDelegate, loadDelegate, type StoredDelegate } from "./memwal.js";

/** Why the book could not be opened, in terms the UI can act on. */
export type BookErrorKind = "no_delegate" | "rejected" | "unknown";

export class BookError extends Error {
  constructor(
    readonly kind: BookErrorKind,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BookError";
  }
}

/**
 * Does this error mean "the key is not granted on this account"?
 *
 * The relayer answers an unsigned or ungranted request with a 401. That is the
 * signal to ask the wallet to authorise, and it is the one case where retrying
 * without a new grant is pointless.
 */
function looksUnauthorised(error: unknown): boolean {
  const text = String(
    error instanceof Error ? `${error.message} ${(error as { status?: number }).status ?? ""}` : error,
  ).toLowerCase();
  return (
    text.includes("401") ||
    text.includes("unauthorized") ||
    text.includes("unauthorised") ||
    text.includes("delegate") ||
    text.includes("not authorized") ||
    text.includes("permission")
  );
}

/**
 * The store for one account, or the reason we cannot have one.
 *
 * Requires a delegate to already be stored locally. It does not create one,
 * because generating a key is not the same as being allowed to use it — that
 * needs a wallet signature, and doing it silently here would hide the one prompt
 * the user has to approve. Use `authoriseBook` for that.
 */
export async function openBook(
  address: string,
  accountId: string,
  namespace?: string,
): Promise<PeopleBookStore> {
  const delegate = loadDelegate(address);
  if (!delegate) {
    throw new BookError(
      "no_delegate",
      "This browser has not been authorised yet. It needs one signature from your wallet to store a key that can write to your own book.",
    );
  }
  return buildStore(delegate, accountId, namespace);
}

function buildStore(
  delegate: StoredDelegate,
  accountId: string,
  namespace?: string,
): PeopleBookStore {
  return new PeopleBookStore({
    accountId,
    ...(namespace ? { namespace } : {}),
    createClient: (id, ns) => createBrowserMemWal(delegate, id, ns),
  });
}

/**
 * Gets or makes the delegate keypair for this browser.
 *
 * `isNew` tells the caller whether the wallet signature is still outstanding. A
 * key in localStorage is not proof of a live on-chain grant — it may have been
 * revoked, or granted from a browser that no longer exists — so the signature is
 * re-requested on the error path rather than trusted from storage.
 */
export async function prepareDelegate(address: string): Promise<{
  delegate: StoredDelegate;
  isNew: boolean;
}> {
  return getOrCreateDelegate(address);
}

export function currentDelegate(address: string): StoredDelegate | null {
  return loadDelegate(address);
}

/**
 * Runs a book operation, translating a refused grant into a `no_delegate` error.
 *
 * The distinction matters: "your key is not authorised" needs a wallet prompt to
 * fix, while "the relayer is down" needs a retry. Collapsing them into one
 * message means either re-prompting for signatures that will not help, or telling
 * someone to retry when they actually need to authorise.
 */
export async function withBook<T>(
  address: string,
  accountId: string,
  operation: (store: PeopleBookStore) => Promise<T>,
  namespace?: string,
): Promise<T> {
  const store = await openBook(address, accountId, namespace);
  try {
    return await operation(store);
  } catch (error) {
    if (looksUnauthorised(error)) {
      throw new BookError(
        "no_delegate",
        "Walrus Memory rejected this browser's key. It may have been revoked on chain — which is exactly what that button is for. Authorise again to carry on.",
        error,
      );
    }
    throw error;
  }
}

export type { MemWal };