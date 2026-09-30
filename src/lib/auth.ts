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
 */

import { useCallback, useState } from "react";
import { useCurrentAccount, useDAppKit } from "@mysten/dapp-kit-react";
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
  const [state, setState] = useState<SignInState>({ phase: "disconnected" });

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

  return { account, state, signIn };
}

export { ConnectButton };
