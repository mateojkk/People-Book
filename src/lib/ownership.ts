/**
 * Account creation and the delegate grant.
 *
 * These two transactions MUST be signed by the user's wallet, in the browser.
 * That is not an implementation detail, it is the property. The app never holds a
 * key capable of creating a memory account or granting itself access to one, so
 * "your memory is yours" is a statement about the cryptography rather than a
 * promise in a privacy policy — and "revoke us and watch" actually works.
 */

import { useCallback, useState } from "react";
import { useCurrentAccount, useDAppKit } from "@mysten/dapp-kit-react";
import { addDelegateKey, createAccount } from "@mysten-incubation/memwal/account";
import { fromHex } from "@mysten/sui/utils";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { api } from "./api.ts";

const network = (import.meta.env.VITE_SUI_NETWORK as "mainnet" | "testnet") || "mainnet";
const rpcUrl = (import.meta.env.VITE_SUI_RPC_URL as string) || "https://fullnode.mainnet.sui.io:443";

export type SetupStep =
  | "idle"
  | "creating"
  | "granting"
  | "done"
  | "error"
  /**
   * This address already has a Walrus Memory account, and the app cannot find
   * it: MemWalAccount is a shared object, shared objects are not returned by
   * listOwnedObjects, and `create_account` aborts with EAccountAlreadyExists.
   * The user reads the id off the dashboard or the creating transaction.
   */
  | "needs_account_id";

export interface OwnershipState {
  step: SetupStep;
  message: string;
  delegatePublicKey: string | null;
  canStart: boolean;
  start: () => Promise<void>;
  /** Present when step is needs_account_id. */
  claimAccountId: (id: string) => Promise<void>;
}

/**
 * Turns a Move abort into something a person can act on.
 *
 * A raw abort code is not an error message. "MoveAbort ... abort code: 3" says
 * nothing about which instruction failed or why; naming it saves a round trip
 * through the contract docs every single time.
 */
function describeSetupError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  if (/abort code:\s*3\b/.test(raw) || /already has an account|already exists/i.test(raw)) {
    return "This address already has a Walrus Memory account, so there is nothing to create — just the access grant. Reload the page and try again; it should skip straight to granting.";
  }
  if (/abort code:\s*0\b/.test(raw)) return "That delegate key is already registered on this account. Reload the page and you should be in.";
  if (/abort code:\s*1\b/.test(raw)) return "That delegate key is not registered on this account any more, so it has to be added again. Reload and try.";
  if (/abort code:\s*4\b/.test(raw)) return "Only the account owner can do this. Connect the wallet that owns the account.";
  if (/abort code:\s*6\b/.test(raw)) return "That account is frozen. Reactivate it on Sui before granting access.";
  if (/balance|insufficient|gas/i.test(raw)) {
    return "This address needs a small amount of SUI to sign for gas. Top it up and try again.";
  }
  // Falls through for anything unrecognised.
  //
  // Two wallet-side failures land here, and neither is visible from the app:
  // "Your connection is not secure" (Slush flags any http origin — dev only,
  // gone on https) and "invalid request" (the Slush web popup is region-gated
  // with a 451; use the browser extension instead). Both are documented in
  // auth.ts and on the sign-in screen, so this stays a passthrough.
  return raw;
}

export function useOwnership(onDone: () => void): OwnershipState {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const [step, setStep] = useState<SetupStep>("idle");
  const [message, setMessage] = useState("");
  const [delegatePublicKey, setDelegatePublicKey] = useState<string | null>(null);
  // Survives the remount that a page reload causes, so a half-finished setup
  // does not make the user go and find the id all over again.
  const [claimedAccountId, setClaimed] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem("pb_claimed_account");
    } catch {
      return null;
    }
  });
  const rememberClaim = useCallback((id: string) => {
    setClaimed(id);
    try {
      window.localStorage.setItem("pb_claimed_account", id);
    } catch {
      // Private mode: the id is simply asked for again. Not worth a modal.
    }
  }, []);

  const start = useCallback(async () => {
    // Which step, and everything the wallet actually said. Both were missing:
    // "invalid request" with no step and no detail is unactionable, and it is
    // exactly what left this stuck -- every attempt looked identical, so there
    // was nothing to distinguish "the wallet rejected it" from "the app built it
    // wrong", which are completely different bugs.
    let phase = "starting";
    console.info("[setup] start clicked", {
      hasAddress: Boolean(account?.address),
      address: account?.address ?? null,
      claimedAccountId,
      network,
      rpcUrl,
    });
    if (!account?.address) {
      // Logged as well as shown: this is the one branch that used to be
      // indistinguishable from a dead button, because a stale render can leave
      // the address empty while the screen still looks signed in.
      console.warn("[setup] no address on the account — the button did nothing");
      setStep("error");
      setMessage("Connect a wallet first.");
      return;
    }
    setMessage("");
    console.info("[setup] beginning setup, phase=starting");

    try {
      const address = account.address;
      const client = new SuiGrpcClient({ baseUrl: rpcUrl, network });

      // The adapter is two lines, deliberately. A thicker one would be a place
      // where a transaction could quietly get signed by something other than the
      // wallet, which is the whole basis of the ownership claim.
      const walletSigner = {
        address,
        signAndExecuteTransaction: async (input: { transaction: unknown }) => {
          console.info("[setup] wallet popup requested — check your wallet for an approval dialog");
          const result = await dAppKit.signAndExecuteTransaction({
            transaction: input.transaction as never,
          });
          console.info("[setup] wallet popup resolved", {
            digest:
              "digest" in result
                ? result.digest
                : ("Transaction" in result ? result.Transaction?.digest : undefined) ?? "",
          });
          const digest =
            "digest" in result
              ? result.digest
              : ("Transaction" in result ? result.Transaction?.digest : undefined) ?? "";
          return { digest };
        },
      };

      // Fetched from the server rather than hardcoded: the published docs list
      // mainnet ids the production relayer does not serve, so an account created
      // against them 401s. One source of truth, and a rotation is a one-file fix.
      console.info("[setup] fetching deployment + whoami");
      const [{ packageId, registryId }, status] = await Promise.all([
        api.get<{ packageId: string; registryId: string }>("/api/account/deployment"),
        api.get<{ accountId: string | null; hasDelegate: boolean }>("/api/auth/whoami"),
      ]);
      console.info("[setup] deployment + whoami resolved", {
        packageId,
        registryId,
        accountId: status.accountId,
        hasDelegate: status.hasDelegate,
      });

      let accountId = status.accountId;
      console.info("[setup] branch decision", { accountId, claimedAccountId, hasDelegate: status.hasDelegate });

      if (!accountId && !claimedAccountId) {
        // Only create when there is genuinely nothing. A user who has used any
        // other MemWal app already has an account, and calling create_account
        // again aborts with code 3 (EAccountAlreadyExists) — a wallet error that
        // looks like the app being broken.
        phase = "creating the account";
        setStep("creating");
        console.info("[setup] calling createAccount on chain");
        try {
          const created = await createAccount({
            packageId,
            registryId,
            walletSigner: walletSigner as never,
            suiClient: client as never,
            suiNetwork: network,
          });
          console.info("[setup] createAccount succeeded", { accountId: created.accountId, digest: created.digest });
          accountId = created.accountId;
        } catch (error) {
          // Code 3 is EAccountAlreadyExists. The account is a shared object, so
          // there is no way to look it up from the address — ask for the id
          // rather than leaving the user with a raw Move abort.
          if (/abort code:\s*3\b/.test(error instanceof Error ? error.message : String(error))) {
            setStep("needs_account_id");
            setMessage(
              "This address already has a Walrus Memory account. A memory account is a shared Sui object, so it cannot be looked up from your address — paste the account id to grant access to it.",
            );
            return;
          }
          throw error;
        }
      } else if (status.hasDelegate) {
        // Nothing to do: the grant already exists. This is the branch that made
        // the button look dead — it correctly skips two wallet popups, but it
        // left the screen on /signin with no visible change, so "already set up"
        // and "the click did nothing" were indistinguishable.
        console.info("[setup] already granted — nothing to do, this address is set up");
        setMessage("This address is already set up — the delegate key is on your account. Opening People Book…");
        setStep("done");
        onDone();
        return;
      }

      phase = "registering the delegate key";
      setStep("granting");
      console.info("[setup] reaching grant step", { accountId });

      // The key is fetched from the server rather than derived here, so the bytes
      // the user is shown on screen are provably the bytes being granted.
      console.info("[setup] fetching delegate public key from server");
      const { publicKey } = await api.get<{ publicKey: string }>("/api/account/delegate-key");
      console.info("[setup] delegate key received", { publicKey });
      phase = `asking your wallet to sign the ${network} transaction`;
      setDelegatePublicKey(publicKey);

      // Narrowed to a definite string: every branch above either sets accountId
      // or returns, so a null here would mean a new path was added without
      // handling it, and the grant below must never run against "any account".
      if (!accountId) {
        throw new Error("Setup finished without a resolvable account id.");
      }

      try {
        console.info("[setup] calling addDelegateKey on chain", { accountId, packageId, registryId });
        const grantResult = await addDelegateKey({
          packageId,
          registryId,
          accountId,
          publicKey: fromHex(publicKey),
          label: "People Book",
          walletSigner: walletSigner as never,
          suiClient: client as never,
          suiNetwork: network,
        });
        console.info("[setup] addDelegateKey succeeded", grantResult);
      } catch (error) {
        // Code 0 is EDelegateKeyAlreadyExists. That means the grant this app was
        // about to make is already there, which is SUCCESS, not a failure -- and
        // treating it as an error produced a loop where the only advice given
        // was to reload, and reloading changed nothing.
        if (!/abort code:\s*0\b/.test(error instanceof Error ? error.message : String(error))) {
          throw error;
        }
      }

      // Ask the server to record this session's account, so later requests skip
      // the registry read. It resolves the id from the registry itself rather
      // than trusting ours, and a failure here is not fatal: the registry will
      // still find the account on the next load.
      rememberClaim(accountId);
      console.info("[setup] adopting account server-side");
      await api.post("/api/account/adopt").catch(() => {});
      console.info("[setup] done — calling onDone");

      setStep("done");
      onDone();
    } catch (error) {
      // The full error, not the one-line version. Setup spans the deployment
      // fetch, account creation, and the delegate grant — without the phase and
      // the wallet's own detail, every failure looks identical.
      const detail = error instanceof Error ? error : new Error(String(error));
      console.error(`[setup] failed while ${phase}`, {
        message: detail.message,
        name: detail.name,
        stack: detail.stack,
        cause: (detail as { cause?: unknown }).cause,
        raw: detail,
      });
      console.error(
        `[setup] failed while ${phase}: ${detail.message}`,
      );
      setStep("error");
      setMessage(describeSetupError(error));
    }
  }, [account?.address, dAppKit, onDone, network, claimedAccountId]);

  /**
   * Verifies and stores a user-supplied account id, then grants access to it.
   *
   * The server only checks the id points at a real MemWal account. That a user
   * may not own is enforced onchain by add_delegate_key being owner-only, so a
   * pasted id belonging to someone else aborts with ENotOwner and grants nothing.
   */
  const claimAccountId = useCallback(
    async (id: string) => {
      console.info("[setup] claim clicked", { id });
      setMessage("");
      try {
        const claimed = await api.post<{ accountId: string }>("/api/account/claim", { accountId: id.trim() });
        console.info("[setup] claim accepted", claimed);
        // The server returns the normalised id, so what we remember is exactly
        // what it verified rather than whatever the user happened to paste.
        rememberClaim(claimed.accountId);
        await start();
      } catch (error) {
        console.warn("[setup] claim failed", error);
        setStep("needs_account_id");
        setMessage(error instanceof Error ? error.message : "That id did not work.");
      }
    },
    [start, rememberClaim],
  );

  return { step, message, delegatePublicKey, canStart: Boolean(account?.address), start, claimAccountId };
}
