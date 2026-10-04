/**
 * The MemWal delegate keypair, in the browser.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * This keypair used to live on the server, in MEMWAL_DELEGATE_KEY, and the server
 * signed every read and write with it. That gave one key standing authority over
 * every account that ever connected: compromise the server and you compromise
 * everyone, at once, permanently. It is also the request shape wallet security
 * scanners read as a drainer — a key that outlives the session and keeps acting
 * for you afterwards, held by a server — which is why the deployed site came back
 * flagged as "malicious behavior" with no way to connect a wallet.
 *
 * So the key moved here. It is generated per user, in the browser, and it never
 * leaves: requests are signed client-side and relayed through /api/memwal, which
 * forwards them to the relayer without holding anything.
 *
 * This is the model vela/frontend/src/hooks/useMemWal.ts already uses. Porting it
 * rather than inventing one is the point — Vela works and does not get flagged.
 *
 * ── What the grant actually is ───────────────────────────────────────────────
 *
 * `addDelegateKey` records this public key on the *user's own* MemWalAccount. It
 * is not a Sui address alias, so it cannot move the user's coins or touch any other
 * account — it can only sign memory writes inside the one account that granted it.
 * `removeDelegateKey` revokes it on chain with no cooperation from this app. That
 * asymmetry (revocable by the user alone) is the property that makes holding it in
 * the browser safe rather than merely tidier.
 */

import { MemWal } from "@mysten-incubation/memwal";
import { generateDelegateKey } from "@mysten-incubation/memwal/account";
import {
  MEMWAL_REQUEST_TIMEOUT_MS,
  NAMESPACE,
  assertAppNamespace,
} from "../../shared/memwal.ts";

export interface StoredDelegate {
  privateKey: string;
  publicKey: string;
  suiAddress: string;
}

/**
 * Same origin, through our relay. NOT the relayer directly: the relayer sends no
 * Access-Control-Allow-Origin on preflight, so a direct browser call fails with
 * "Failed to fetch". The relay exists for that reason and nothing else.
 */
export const RELAY_URL = `${window.location.origin}/api/memwal`;

const storageKey = (address: string) => `peoplebook_delegate_${address.toLowerCase()}`;

export function loadDelegate(address: string): StoredDelegate | null {
  try {
    const raw = window.localStorage.getItem(storageKey(address));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDelegate>;
    if (!parsed.privateKey || !parsed.publicKey) return null;
    return {
      privateKey: parsed.privateKey,
      publicKey: parsed.publicKey,
      suiAddress: parsed.suiAddress ?? "",
    };
  } catch {
    // A corrupt or unreadable entry is treated as absent rather than fatal: the
    // only recovery is to generate a new key and re-grant, which the caller does
    // by asking the wallet to authorise again.
    return null;
  }
}

export function saveDelegate(address: string, delegate: StoredDelegate): void {
  try {
    window.localStorage.setItem(storageKey(address), JSON.stringify(delegate));
  } catch {
    // Private browsing, or a full quota. The key still works for this session, but
    // the user will be asked to authorise again next time. Surfaced by the caller
    // through the same "needs authorisation" path as a first-time user.
  }
}

export function forgetDelegate(address: string): void {
  try {
    window.localStorage.removeItem(storageKey(address));
  } catch {
    /* nothing useful to do */
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(Math.floor(clean.length / 2));
  // Bound the loop by clean.length, not out.length. Vela's original is right and
  // an earlier port of it here was not: `i < out.length` stops after the first
  // byte, so a 32-byte public key decoded to one byte. That would have registered a
  // truncated key on chain and failed every subsequent write, with an auth error
  // that points nowhere near hex decoding.
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

/**
 * The existing keypair for this address, or a freshly generated one.
 *
 * Returns whether it is new so the caller knows whether the wallet signature that
 * grants it is still needed. A key in localStorage is not proof it is still
 * granted on chain — it may have been revoked, or granted from a browser that no
 * longer exists — so `isAuthorised` is answered by the server, not by this cache.
 */
export async function getOrCreateDelegate(
  address: string,
): Promise<{ delegate: StoredDelegate; isNew: boolean }> {
  const existing = loadDelegate(address);
  if (existing) return { delegate: existing, isNew: false };

  const generated = await generateDelegateKey();
  const delegate: StoredDelegate = {
    privateKey: generated.privateKey,
    publicKey: bytesToHex(generated.publicKey),
    suiAddress: generated.suiAddress,
  };
  saveDelegate(address, delegate);
  return { delegate, isNew: true };
}

/**
 * A MemWal client that signs with the browser-held key and talks through the relay.
 *
 * `accountId` is the user's own MemWalAccount object id, resolved from the public
 * AccountRegistry — a chain read, not a key operation, so it needs no signing.
 *
 * `namespace` is forced through the same assertion the server used, not merely
 * defaulted. This function is reachable from browser code, which means from
 * anything that manages to inject a value, so the guard that stops the app reading
 * someone else's memories has to live here too rather than only on the server that
 * no longer exists.
 */
export function createBrowserMemWal(
  delegate: StoredDelegate,
  accountId: string,
  namespace: string = NAMESPACE,
): MemWal {
  return MemWal.create({
    key: delegate.privateKey,
    accountId,
    serverUrl: RELAY_URL,
    namespace: assertAppNamespace(namespace),
    // Same reason the server set it: the SDK default is shorter than a mainnet
    // write actually takes, so an ordinary save looks like a network failure.
    requestTimeoutMs: MEMWAL_REQUEST_TIMEOUT_MS,
  });
}