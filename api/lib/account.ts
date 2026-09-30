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

/** Public mainnet deployment IDs, from the MemWal contract docs. */
export const MAINNET_PACKAGE_ID = "0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6";
export const MAINNET_REGISTRY_ID = "0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd";

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

function packageId(): string {
  return process.env.MEMWAL_PACKAGE_ID || MAINNET_PACKAGE_ID;
}

function registryId(): string {
  return process.env.MEMWAL_REGISTRY_ID || MAINNET_REGISTRY_ID;
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
  const hex = process.env.MEMWAL_DELEGATE_KEY;
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

  const response = await client.core.listOwnedObjects({
    owner: normalize(address),
    type: `${packageId()}::account::MemWalAccount`,
    limit: 10,
  });

  for (const object of response.objects ?? []) {
    if (object.objectId) return normalize(object.objectId);
  }
  return null;
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

  const result: AddDelegateKeyResult = await addDelegateKey({
    packageId: packageId(),
    registryId: registryId(),
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
  return createAccount({
    packageId: packageId(),
    registryId: registryId(),
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
