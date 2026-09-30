/**
 * Account ownership: the user creates their own MemWal account and grants this
 * app a scoped delegate key.
 *
 * ── Why this is the shape of the product ────────────────────────────────────
 * MemWal scopes every read and write to `owner address + namespace + app id`.
 * If the app held one master key and namespaced per user, the app would be the
 * custodian of every book it holds, and "your memory is yours" would be a
 * slogan. So instead:
 *
 *   1. The USER creates their own MemWalAccount (`create_account`).
 *   2. The USER registers our Ed25519 public key as a delegate
 *      (`add_delegate_key`). Owner-only, on chain, verifiable.
 *   3. The app can now act only inside that account.
 *   4. The USER can call `remove_delegate_key` at any time and the app loses
 *      access immediately, without our cooperation.
 *
 * Step 4 is the demo: a judge removes the delegate key on Sui and watches the
 * app stop working. That is a property you can check, not a claim you can make.
 *
 * Note the honest limit: this is a Sui transaction, so the user needs gas. A
 * zkLogin or sponsored-tx path would remove that friction but needs Enoki, which
 * is paid and gated. See README > "Known limitations".
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  addDelegateKey,
  createAccount,
  type AddDelegateKeyOpts,
  type AddDelegateKeyResult,
  type CreateAccountOpts,
  type CreateAccountResult,
} from "@mysten-incubation/memwal/account";
import type { WalletSigner } from "@mysten-incubation/memwal/manual";
import { delegateKeyToPublicKey } from "@mysten-incubation/memwal";

/**
 * Walrus Memory deployment IDs.
 *
 * These are deliberately NOT hardcoded. The published docs currently list mainnet
 * IDs that the production relayer does not serve (MystenLabs/MemWal#1032), and
 * hardcoding any pair means the app breaks again the next time they rotate. So we
 * read `packageId` from the relayer's own `/config` at runtime and cache it.
 *
 * `registryId` is not exposed by `/config`, so it must come from the environment.
 * The value below is the mainnet registry that pairs with the production
 * packageId; if the relayer ever reports a different package, the mismatch is
 * surfaced rather than silently used.
 */
/** The package the docs still list. Retired — the relayer does not serve it. */
export const RETIRED_PACKAGE_ID = "0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6";
export const FALLBACK_PACKAGE_ID = "0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5";
/** AccountRegistry for the live package. Verified against mainnet. */
export const FALLBACK_REGISTRY_ID = "0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f";

let cachedConfig: { packageId: string; registryId: string } | null = null;
let cachedRegistryCheck: { ok: boolean; detail: string } | null = null;

/**
 * Fetches the live packageId from the relayer's own /config, once per process.
 *
 * Hardcoding it is what broke this app the first time: the published docs list a
 * mainnet package the production relayer does not serve, so an account created
 * against it 401s. Reading it from the relayer means a rotation is a non-event.
 */
export async function deployment(): Promise<{ packageId: string; registryId: string }> {
  if (cachedConfig) return cachedConfig;

  const serverUrl = process.env.MEMWAL_SERVER_URL ?? "https://relayer.memory.walrus.xyz";
  let packageId = process.env.MEMWAL_PACKAGE_ID || FALLBACK_PACKAGE_ID;

  try {
    const response = await fetch(`${serverUrl}/config`, { signal: AbortSignal.timeout(8000) });
    if (response.ok) {
      const body = (await response.json()) as { packageId?: string };
      // An explicit env override wins, so a self-hosted or pinned deployment is
      // never silently overwritten by whatever a relayer happens to report.
      if (body.packageId && !process.env.MEMWAL_PACKAGE_ID) packageId = body.packageId;
    }
  } catch {
    // A relayer we cannot reach is not a reason to fail here; account creation
    // surfaces its own error if the deployment is genuinely wrong.
  }

  cachedConfig = { packageId, registryId: process.env.MEMWAL_REGISTRY_ID || FALLBACK_REGISTRY_ID };
  return cachedConfig;
}

/**
 * Confirms the registry actually belongs to the live package.
 *
 * A registry id and a package id are different values by nature, so comparing
 * the two strings proves nothing. The real question is whether the registry
 * OBJECT on chain is published by that package, which is a one-object lookup.
 * This is what catches a rotation: the registry silently stops matching, and
 * `create_account` fails with an opaque error instead of a sentence.
 */
export async function verifyRegistry(): Promise<{ ok: boolean; detail: string }> {
  if (cachedRegistryCheck) return cachedRegistryCheck;

  const { packageId, registryId } = await deployment();
  try {
    const client = suiClient();
    const res = await client.core.getObject({ objectId: registryId });
    const type = res.object?.type;

    if (!type) {
      cachedRegistryCheck = { ok: false, detail: `No object at registry id ${registryId} on ${process.env.SUI_RPC_URL ?? "the default mainnet fullnode"}.` };
      return cachedRegistryCheck;
    }
    if (!type.startsWith(`${packageId}::`)) {
      cachedRegistryCheck = {
        ok: false,
        detail: `The registry ${registryId} is published by ${type.split("::")[0]}, but the relayer serves ${packageId}. Set MEMWAL_REGISTRY_ID to the AccountRegistry for the current package, or run \`npm run check:registry <id>\` to verify a candidate.`,
      };
      return cachedRegistryCheck;
    }

    cachedRegistryCheck = { ok: true, detail: `${type} matches the relayer's package.` };
    return cachedRegistryCheck;
  } catch (error) {
    // Sui unreachable is not a deployment mismatch, and saying it is would send
    // someone off to change configuration that is already correct.
    cachedRegistryCheck = { ok: true, detail: `Could not verify on chain: ${error instanceof Error ? error.message : String(error)}` };
    return cachedRegistryCheck;
  }
}

/**
 * Pulls a 0x object id out of whatever the user pasted.
 *
 * People find the id on the memory.walrus.xyz dashboard or by right-clicking an
 * object in a Sui explorer, so the paste is frequently a URL. Taking the first
 * 0x-prefixed 64-hex run handles the bare id, `/object/<0x…>`, and a copied
 * transaction digest alike.
 */
export function extractObjectId(raw: string): string {
  const match = /0x[0-9a-fA-F]{64}/.exec(raw);
  return match ? normalize(match[0]) : "";
}

/**
 * Checks a user-supplied account id is a real Walrus Memory account.
 *
 * Needed because a shared object cannot be enumerated: `listOwnedObjects` does
 * not return shared objects, so a user who already has a MemWal account from
 * another app cannot have it looked up from their address, and `create_account`
 * aborts with code 3. They supply the id instead.
 *
 * This deliberately does NOT check that the user owns it. That would need a
 * dry-run for marginal benefit, because the actual enforcement is onchain and
 * unconditional: `add_delegate_key` is owner-only, so a pasted id belonging to
 * somebody else aborts with ENotOwner and no grant happens. Claiming otherwise
 * here would be security theatre -- a client-side check the user controls
 * proves nothing. This function only catches the cheap mistakes, so the user is
 * not asked to sign a doomed transaction.
 */
export async function verifyAccountShape(
  raw: string,
): Promise<{ ok: true; accountId: string } | { ok: false; reason: string }> {
  // Accept a pasted link as well as a bare id. Where a user finds the id is a
  // dashboard row or an explorer link, and asking them to reduce a URL to 0x…
  // by hand is a pointless way to lose them.
  const accountId = extractObjectId(raw);
  if (!isPlausibleAddress(accountId)) {
    return { ok: false, reason: "That is not a Sui object id. Paste the id itself or a link containing it." };
  }
  try {
    const type = (await suiClient().core.getObject({ objectId: normalize(accountId) })).object?.type ?? "";
    if (!type) return { ok: false, reason: "No object found at that id on mainnet." };
    if (!type.endsWith("::account::MemWalAccount")) {
      return { ok: false, reason: `That object is not a Walrus Memory account (it is a ${type.split("::").slice(-2).join("::")}).` };
    }
    return { ok: true, accountId };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Clears the cached deployment. Used by /health so a rotation is visible. */
export function resetDeploymentCache(): void {
  cachedConfig = null;
  cachedRegistryCheck = null;
}

/** Our delegate key is a 32-byte Ed25519 seed, stored as hex. */
const DELEGATE_KEY_BYTES = 32;

export class AccountConfigError extends Error {
  readonly code = "account_config_missing";
  constructor(message: string) {
    super(message);
    this.name = "AccountConfigError";
  }
}

export function suiClient(): SuiGrpcClient {
  const url = process.env.SUI_RPC_URL ?? "https://fullnode.mainnet.sui.io:443";
  return new SuiGrpcClient({ baseUrl: url, network: "mainnet" });
}

/**
 * The public half of our delegate key, derived from the private seed we store
 * server-side. Derived rather than stored twice so the two can never drift — a
 * mismatch would present a key the onchain account does not recognise, and every
 * write would fail with a confusing error.
 */
export async function ourDelegatePublicKey(): Promise<Uint8Array> {
  const hex = delegateSeedHex();
  return delegateKeyToPublicKey(hex);
}

function delegateSeedHex(): string {
  // MEMWAL_PRIVATE_KEY is the name the MemWal docs and most existing projects
  // use, so it is accepted as a fallback. It is the same value: a 32-byte
  // Ed25519 seed, here granted into a user's own account rather than minted for
  // a single shared one.
  const hex = process.env.MEMWAL_DELEGATE_KEY || process.env.MEMWAL_PRIVATE_KEY;
  if (!hex) {
    throw new AccountConfigError(
      "MEMWAL_DELEGATE_KEY is not set. Run `npm run keygen` and put the output in .env.",
    );
  }
  const trimmed = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (trimmed.length !== DELEGATE_KEY_BYTES * 2) {
    throw new AccountConfigError(
      `MEMWAL_DELEGATE_KEY must be ${DELEGATE_KEY_BYTES} bytes (${DELEGATE_KEY_BYTES * 2} hex chars). Run \`npm run keygen\`.`,
    );
  }
  return trimmed;
}

export type OwnershipStatus =
  /** The address has no MemWal account yet. */
  | { state: "no_account" }
  /** An account exists; our delegate key may or may not be on it. */
  | { state: "no_delegate"; accountId: string }
  /** Ready. `accountId` is what every memory operation must be scoped to. */
  | { state: "ready"; accountId: string }
  /** We hold the account but our key is not on it — the user must grant it. */
  | { state: "revoked"; accountId: string };

/**
 * Reports what state the user's account is in.
 *
 * Best-effort by design: if the RPC call fails we return null rather than
 * guessing, because telling a user their memory is "ready" when we cannot
 * confirm it would produce writes that silently fail.
 */
export async function inspectOwnership(address: string): Promise<OwnershipStatus | null> {
  try {
    const accountId = await findAccountId(address);
    if (!accountId) return { state: "no_account" };
    return { state: "no_delegate", accountId };
  } catch {
    return null;
  }
}

/**
 * Locates the MemWalAccount owned by an address.
 *
 * The registry enforces one account per address, so this should return at most
 * one. A miss means "no account", which is different from "the RPC is down" and
 * is why the caller keeps those two apart.
 */
export async function findAccountId(address: string): Promise<string | null> {
  const client = suiClient();

  const { packageId } = await deployment();
  const response = await client.core.listOwnedObjects({
    owner: normalize(address),
    type: `${packageId}::account::MemWalAccount`,
    limit: 10,
  });

  for (const object of response.objects ?? []) {
    if (object.objectId) return normalize(object.objectId);
  }
  return null;
}

/**
 * Whether this app's delegate key is registered on the given account.
 *
 * Probed with the cheapest authenticated call the relayer offers — a namespace
 * listing — rather than reading onchain state, because it is the same request the
 * app makes anyway and it fails closed with a clear auth error if the key is
 * absent. Cached per process: the answer only changes when the user acts, and
 * they cause that action from the setup screen.
 */
const delegateCache = new Map<string, boolean>();

export async function delegateIsRegistered(accountId: string): Promise<boolean> {
  const cached = delegateCache.get(accountId);
  if (cached !== undefined) return cached;

  let registered = false;
  try {
    const { getClient } = await import("./memwal.ts");
    const result = await getClient(accountId).listNamespaces({ limit: 1 });
    registered = Array.isArray(result?.namespaces);
  } catch {
    // Any failure means we cannot prove we hold access, and treating that as
    // "not registered" sends the user to a grant screen that is the right answer.
    registered = false;
  }

  delegateCache.set(accountId, registered);
  return registered;
}

/** Called after a successful grant, so the next status check does not say no. */
export function markDelegateRegistered(accountId: string): void {
  delegateCache.set(accountId, true);
}

export interface GrantResult {
  accountId: string;
  delegateSuiAddress: string;
  digest: string;
}

/**
 * Adds our delegate key to the user's account, signed by THEIR wallet.
 *
 * `walletSigner` must come from the user's connected wallet in the browser. We
 * never hold a key that could authorise this, because the entire ownership claim
 * rests on the grant being something only the user could do.
 */
export async function grantDelegateKey(
  walletSigner: WalletSigner,
  label = "People Book",
): Promise<GrantResult> {
  const accountId = await findAccountId(walletSigner.address);
  if (!accountId) {
    throw new Error(
      "No MemWal account found for this address yet. Create the account first, then grant access.",
    );
  }

  const { packageId, registryId } = await deployment();
  const result: AddDelegateKeyResult = await addDelegateKey({
    packageId,
    registryId,
    accountId,
    publicKey: await ourDelegatePublicKey(),
    label,
    walletSigner,
  });

  return {
    accountId,
    delegateSuiAddress: result.suiAddress,
    digest: result.digest,
  };
}

/** Creates the user's own account, signed by their wallet. */
export async function createUserAccount(walletSigner: WalletSigner): Promise<CreateAccountResult> {
  const { packageId, registryId } = await deployment();
  return createAccount({
    packageId,
    registryId,
    walletSigner,
  });
}

/**
 * True when a write failure looks like a revoked delegate rather than a
 * relayer problem. Used to tell the user the actionable thing.
 */
export function looksLikeRevoked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /delegate|unauthorized|not authorized|EDelegateKeyNotFound|401|403/i.test(message);
}

/** Sui addresses are 0x-prefixed 64-char hex. Normalising avoids casing mismatches. */
export function normalize(address: string): string {
  const trimmed = address.trim().toLowerCase();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

export function isPlausibleAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value.trim());
}
