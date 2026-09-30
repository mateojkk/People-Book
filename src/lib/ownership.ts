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

export type SetupStep = "idle" | "creating" | "granting" | "done" | "error";

export interface OwnershipState {
  step: SetupStep;
  message: string;
  delegatePublicKey: string | null;
  canStart: boolean;
  start: () => Promise<void>;
}

export function useOwnership(onDone: () => void): OwnershipState {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const [step, setStep] = useState<SetupStep>("idle");
  const [message, setMessage] = useState("");
  const [delegatePublicKey, setDelegatePublicKey] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (!account?.address) {
      setStep("error");
      setMessage("Connect a wallet first.");
      return;
    }
    setMessage("");

    try {
      const address = account.address;
      const client = new SuiGrpcClient({ baseUrl: rpcUrl, network });

      // The account SDK wants { address, signAndExecuteTransaction }. dApp Kit v2
      // puts both of those on the kit instance, so the adapter is two lines —
      // which is deliberate, because a thicker adapter would be a place where a
      // transaction could quietly get signed by something other than the wallet.
      const walletSigner = {
        address,
        signAndExecuteTransaction: async (input: { transaction: unknown }) => {
          const result = await dAppKit.signAndExecuteTransaction({
            transaction: input.transaction as never,
          });
          // The result union carries the digest either on the success branch or
          // nested under $kind, depending on whether effects were requested.
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
      const { packageId, registryId } = await api.get<{ packageId: string; registryId: string }>(
        "/api/account/deployment",
      );

      setStep("creating");
      const created = await createAccount({
        packageId,
        registryId,
        walletSigner: walletSigner as never,
        suiClient: client as never,
        suiNetwork: network,
      });

      setStep("granting");

      // The key is fetched from the server rather than derived here, so the bytes
      // the user is shown on screen are provably the bytes being granted.
      const { publicKey } = await api.get<{ publicKey: string }>("/api/account/delegate-key");
      setDelegatePublicKey(publicKey);

      await addDelegateKey({
        packageId,
        registryId,
        accountId: created.accountId,
        publicKey: fromHex(publicKey),
        label: "People Book",
        walletSigner: walletSigner as never,
        suiClient: client as never,
        suiNetwork: network,
      });

      setStep("done");
      onDone();
    } catch (error) {
      setStep("error");
      setMessage(error instanceof Error ? error.message : "Could not set up the account.");
    }
  }, [account?.address, dAppKit, onDone]);

  return { step, message, delegatePublicKey, canStart: Boolean(account?.address), start };
}
