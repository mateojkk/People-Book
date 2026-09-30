/**
 * The app shell.
 *
 * The gate is the wallet + signed challenge. Beyond that the app is deliberately
 * plain, because the things it has to prove are not visual.
 */

import { useCallback, useEffect, useState } from "react";
import { ConnectButton, useSignIn } from "./lib/auth.ts";
import { useOwnership } from "./lib/ownership.ts";
import { api } from "./lib/api.ts";
import { NudgeView } from "./components/NudgeView.tsx";
import { LedgerView } from "./components/LedgerView.tsx";
import { AddView } from "./components/AddView.tsx";
import { ErrorNote } from "./components/bits.tsx";
import type { PersonMemory } from "./types.ts";

type Tab = "nudges" | "book" | "add";

interface Whoami {
  signedIn: boolean;
  address?: string;
  accountId?: string | null;
}

export default function App() {
  const { account, state, signIn } = useSignIn();
  const [tab, setTab] = useState<Tab>("nudges");
  const [who, setWho] = useState<Whoami | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const ownership = useOwnership(() => void refreshWho());

  const refreshWho = useCallback(async () => {
    try {
      setWho(await api.get<Whoami>("/api/auth/whoami"));
    } catch {
      setWho(null);
    }
  }, []);

  useEffect(() => {
    void refreshWho();
  }, [refreshWho, state]);

  const forget = useCallback(
    async (id: string) => {
      try {
        await api.del(`/api/memories/${id}`);
        setVersion((v) => v + 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not forget that.");
      }
    },
    [],
  );

  // ── Gate ───────────────────────────────────────────────────────────────────
  if (!who?.signedIn) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-4">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">People Book</h1>
          <p className="mt-2 text-sm leading-relaxed text-quiet">
            A private assistant that remembers everyone in your life, you included, and comes to you
            instead of waiting to be asked.
          </p>
        </header>

        <div className="space-y-3 rounded border border-line bg-surface p-4">
          <p className="text-xs text-quiet">
            Sign in with a Sui wallet. You will sign a one-time message so we can prove the address
            is yours — and then you create a Walrus Memory account that{" "}
            <strong className="text-bright">you</strong> own, and grant this app scoped access to it.
            You can take that access away on chain at any time, and we will not be able to stop you.
          </p>

          {state.phase === "error" && <ErrorNote message={state.message} />}

          <div className="flex flex-wrap items-center gap-2">
            <ConnectButton />
            {account?.address && state.phase !== "signed_in" && (
              <button
                onClick={() => void signIn()}
                disabled={state.phase === "connecting" || state.phase === "signing"}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-50"
              >
                {state.phase === "signing"
                  ? "check your wallet…"
                  : state.phase === "connecting"
                    ? "preparing…"
                    : "Sign in"}
              </button>
            )}
          </div>

          {state.phase === "signing" && (
            <pre className="mono max-h-24 overflow-auto whitespace-pre-wrap rounded bg-ink/60 p-2 text-[10px] text-quiet">
              {state.message}
            </pre>
          )}
        </div>
      </main>
    );
  }

  // ── No account yet ─────────────────────────────────────────────────────────
  if (who.accountId === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-5 px-4">
        <h1 className="text-xl font-semibold">One step left</h1>
        <p className="text-sm leading-relaxed text-quiet">
          This address has no Walrus Memory account yet. Create one, then grant People Book a
          delegate key on it. Both are signed by your wallet, and both are yours to undo — remove
          the delegate key on chain at any time and this app stops working immediately, without our
          cooperation. That is the whole point of doing it this way.
        </p>

        <ol className="space-y-2 text-xs text-quiet">
          <li>
            <strong className="text-bright">1.</strong> Create a Walrus Memory account. The account
            is owned by your address, not by us.
          </li>
          <li>
            <strong className="text-bright">2.</strong> Add a delegate key so this app can read and
            write inside it. You will see the exact key you are granting.
          </li>
        </ol>

        {ownership.step !== "idle" && (
          <p className="rounded border border-line bg-surface px-3 py-2 text-xs text-quiet">
            {ownership.step === "creating" && "Creating your account… approve in your wallet."}
            {ownership.step === "granting" && "Now adding the delegate key… approve in your wallet."}
            {ownership.step === "error" && <span className="text-stop">{ownership.message}</span>}
          </p>
        )}

        {ownership.step === "error" && (
          <p className="text-xs text-quiet">
            This needs a small amount of SUI for gas. The frictionless version of this step — sign in
            with Google, no wallet, no gas — is on the roadmap and depends on Enoki, which is paid
            and gated. See the README.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <ConnectButton />
          <button
            onClick={() => void ownership.start()}
            disabled={!ownership.canStart || ownership.step === "creating" || ownership.step === "granting"}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-40"
          >
            {ownership.step === "idle" || ownership.step === "error"
              ? "Create my account and grant access"
              : "Working…"}
          </button>
        </div>

        <a href="/api/health" className="text-xs text-quiet underline decoration-dotted underline-offset-2">
          check the server config
        </a>
      </main>
    );
  }

  // ── The app ────────────────────────────────────────────────────────────────
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">People Book</h1>
          <p className="mono mt-0.5 text-[11px] text-quiet">
            {who.address?.slice(0, 6)}…{who.address?.slice(-4)}
          </p>
        </div>
        <a
          href="/api/export"
          className="rounded border border-line px-2.5 py-1 text-[11px] text-quiet hover:text-bright"
        >
          export everything
        </a>
      </header>

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      <nav className="mb-5 flex gap-1 border-b border-line">
        {(
          [
            ["nudges", "What came to you"],
            ["book", "Your book"],
            ["add", "Add"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-xs transition-colors ${
              tab === key
                ? "border-accent text-bright"
                : "border-transparent text-quiet hover:text-bright"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "nudges" && <NudgeView key={version} onForget={forget} />}
      {tab === "book" && <LedgerView key={version} onForget={forget} />}
      {tab === "add" && <AddView onSaved={() => setVersion((v) => v + 1)} />}

      <footer className="mt-8 border-t border-line pt-4 text-[11px] leading-relaxed text-quiet">
        Memory lives in a Walrus Memory account that <strong className="text-bright">you</strong> own
        on Sui mainnet, encrypted on Walrus. This app holds a scoped delegate key you granted, and
        nothing else.{" "}
        <a href="/api/health" className="underline decoration-dotted underline-offset-2">
          server status
        </a>
      </footer>
    </main>
  );
}

export type { PersonMemory };
