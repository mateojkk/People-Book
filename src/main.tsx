/**
 * App bootstrap.
 *
 * dApp Kit v2 (the `dapp-kit-react` line) is the one that matches Sui SDK v2,
 * which is what Walrus Memory's account SDK requires. The two are versioned
 * together: `@mysten/dapp-kit@1.x` still targets the Sui v1 client and cannot be
 * mixed with memwal, whose peer range is `>=2.5.0`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createDAppKit } from "@mysten/dapp-kit-core";
import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { BrowserRouter } from "react-router-dom";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import App from "./App.tsx";
import "./index.css";

const network = (import.meta.env.VITE_SUI_NETWORK as "mainnet" | "testnet" | "devnet") || "mainnet";
const rpcUrl = (import.meta.env.VITE_SUI_RPC_URL as string) || "https://fullnode.mainnet.sui.io:443";

const dAppKit = createDAppKit({
  // Network entries are plain id strings in Sui SDK v2; the RPC URL is supplied
  // by the client factory below, not alongside the id.
  networks: [network],
  defaultNetwork: network,
  createClient: (net: string) => new SuiGrpcClient({ baseUrl: rpcUrl, network: net as "mainnet" | "testnet" | "devnet" | "localnet" }),
  storageKey: "people-book-dappkit",
  // Named explicitly rather than read off document.title: the Slush web wallet
  // sends this as `appName` in its connect request (a required field), and the
  // default lookup races the title. An empty or drifting name is one way a
  // well-formed connect becomes an "invalid request" on the wallet side.
  slushWalletConfig: { appName: "People Book" },
});

const root = document.getElementById("root");
if (!root) throw new Error("No #root element. index.html looks wrong.");

createRoot(root).render(
  <StrictMode>
    <DAppKitProvider dAppKit={dAppKit}>
      {/* Inside the provider: the router reads nothing from it, but the sign-in
          flow does, and a router outside the app would remount the tree above
          dApp Kit on every navigation. */}
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </DAppKitProvider>
  </StrictMode>,
);
