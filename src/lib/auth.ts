/**
 * Wallet connection and the sign-in challenge.
 *
 * The flow is three steps and each exists for a reason:
 *
 *   1. ConnectButton  — the user picks a wallet. This tells us an address but
 *                       proves nothing.
 *   2. Challenge       — the server issues a single-use nonce bound to that
 *                       address. Without it, a captured "signed in" state could
 *                       be replayed for someone else.
 *   3. Sign            — the wallet signs it. The server verifies the signature
 *                       recovers to that exact address before minting a session.
 *
 * dApp Kit v2 exposes signing on the kit instance rather than through a hook, so
 * these go through `useDAppKit()`.
 *
 * ── Two wallet errors, two different causes ──────────────────────────────────
 * "Your connection is not secure" is Slush's own check: `isSecureURL` is
 * literally `protocol === "https:"`, so ANY plain-http origin (including
 * localhost) gets the banner. It is a warning, not a refusal — connecting
 * anyway works. It goes away on any https origin, i.e. in production.
 *
 * "invalid request" (lowercase, no code) comes from the wallet side declining
 * the connect popup: the Slush web wallet opens my.slush.app in a popup, and
 * from some regions that page serves a 451 ("not available in your region")
 * instead of the approval screen. A region-blocked popup can never approve, so
 * the connect fails opaquely. The fix is a wallet with a local path: the Slush
 * / Sui browser extension talks to the page directly, needs no popup, and has
 * no region gate — install it and connect through it instead.
 */

import { useCallback, useEffect, useState } from "react";
import { useCurrentAccount, useDAppKit, useWallets } from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { api } from "./api.ts";

export type SignInState =
  | { phase: "disconnected" }
  | { phase: "connecting" }
  | { phase: "signing"; message: string }
  | { phase: "signed_in"; address: string }
  | { phase: "error"; message: string };

interface ChallengeResponse {
  token: string;
  message: string;
  bytes: number[];
}

export function useSignIn() {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const wallets = useWallets();
  const [state, setState] = useState<SignInState>({ phase: "disconnected" });

  // The one diagnostic the connect modal swallows. dApp Kit's modal shows
  // "Connection failed / Something went wrong" with no error text, and the
  // extension popup shows its own message — so when the two disagree there is
  // nothing tying them together. This logs every registered wallet (extension
  // vs web popup look like two entries both called "Slush") and every connect
  // attempt's raw result, so "invalid request" can be traced to which wallet
  // object actually failed.
  useEffect(() => {
    console.info(
      "[wallets]",
      wallets.map((w) => ({ name: w.name, id: (w as { id?: string }).id ?? null })),
    );
  }, [wallets]);

  const signIn = useCallback(async () => {
    if (!account?.address) {
      setState({ phase: "error", message: "Connect a wallet first." });
      return;
    }
    setState({ phase: "connecting" });
    try {
      const challenge = await api.post<ChallengeResponse>("/api/auth/challenge", {
        address: account.address,
      });
      setState({ phase: "signing", message: challenge.message });

      // The server verifies against these exact bytes, so the message is encoded
      // here rather than sent as a string. A different encoding on either side
      // yields a signature that cannot be checked.
      const signed = await dAppKit.signPersonalMessage({
        message: new TextEncoder().encode(challenge.message),
      });

      // `signed.bytes` is what the wallet says it actually signed. Sending it
      // lets the server distinguish a genuinely bad signature from a wallet that
      // quietly altered the message — otherwise both look identical from here.
      await api.post<{ address: string }>("/api/auth/session", {
        token: challenge.token,
        signature: signed.signature,
        signedBytes: signed.bytes,
      });
      setState({ phase: "signed_in", address: account.address });
    } catch (error) {
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : "Sign-in failed.",
      });
    }
  }, [account?.address, dAppKit]);

  /**
   * Disconnects the wallet AND ends the session.
   *
   * Both halves, because leaving either one behind is a worse state than either:
   * clearing only the cookie leaves the wallet connected and dapp-kit still
   * believes it is signed in, so the app looks ready while the session is gone;
   * clearing only the wallet leaves a valid session cookie for an address the
   * person can no longer see. `onDone` runs once both are done.
   */
  const disconnect = useCallback(
    async (onDone?: () => void) => {
      try {
        await api.post("/api/auth/logout");
      } catch {
        // A failed logout must not strand the wallet connected. Carry on.
      }
      try {
        await dAppKit.disconnectWallet();
      } catch {
        // dApp Kit throws WalletNotConnectedError when there is nothing to
        // disconnect (e.g. session alive, wallet already unplugged). That is
        // the desired end state, not a failure — swallow it so disconnect never
        // rejects and the `finally` below always runs.
      } finally {
        setState({ phase: "disconnected" });
        onDone?.();
      }
    },
    [dAppKit],
  );

  return { account, state, signIn, disconnect };
}

export { ConnectButton };
