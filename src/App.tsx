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
import { ChatView } from "./components/ChatView.tsx";
import { ErrorNote } from "./components/bits.tsx";
import type { PersonMemory } from "./types.ts";

type Tab = "talk" | "nudges" | "book" | "add";

interface Whoami {
  signedIn: boolean;
  address?: string;
  /** null when the address has no Walrus Memory account at all. */
  accountId?: string | null;
  /** Whether this app's delegate key is registered on that account. */
  hasDelegate?: boolean;
}

export default function App() {
  const { account, state, signIn } = useSignIn();
  const [tab, setTab] = useState<Tab>("talk");
  const [who, setWho] = useState<Whoami | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const ownership = useOwnership(() => void refreshWho());
  const [accountIdDraft, setAccountIdDraft] = useState("");
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  // Is there actually a model behind this?
  //
  // Without GROQ_API_KEY nothing is extracted and every reply falls back to "I'm
  // listening" -- which looks exactly like a chatbot that simply had nothing to
  // say. Someone deploying this without the key would demo a stub and not know.
  // So it is checked once and said out loud.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { config?: { groq?: boolean } } | null) => {
        if (!cancelled) setModelReady(Boolean(body?.config?.groq));
      })
      .catch(() => !cancelled && setModelReady(null));
    return () => {
      cancelled = true;
    };
  }, []);

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
          <p className="mt-2 text-sm leading-relaxed text-muted">
            A private assistant that remembers everyone in your life, you included, and comes to you
            instead of waiting to be asked.
          </p>
        </header>

        <div className="space-y-3 rounded border border-rule bg-base p-4">
          <p className="text-xs text-muted">
            Sign in with a Sui wallet. You will sign a one-time message so we can prove the address
            is yours — and then you create a Walrus Memory account that{" "}
            <strong className="text-text">you</strong> own, and grant this app scoped access to it.
            You can take that access away on chain at any time, and we will not be able to stop you.
          </p>

          {state.phase === "error" && <ErrorNote message={state.message} />}

          <div className="flex flex-wrap items-center gap-2">
            <ConnectButton />
            {account?.address && state.phase !== "signed_in" && (
              <button
                onClick={() => void signIn()}
                disabled={state.phase === "connecting" || state.phase === "signing"}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-base disabled:opacity-50"
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
            <pre className="mono max-h-24 overflow-auto whitespace-pre-wrap rounded bg-base/60 p-2 text-[10px] text-muted">
              {state.message}
            </pre>
          )}
        </div>
      </main>
    );
  }

  // ── Not set up yet ─────────────────────────────────────────────────────────
  // Two distinct states, and conflating them broke it: an address that already
  // has a Walrus Memory account from another app does NOT need one created, only
  // the grant. The old gate keyed on accountId alone, so anyone with an existing
  // account was sent past setup and then had every write fail as unauthorized.
  if (!who.accountId || !who.hasDelegate) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-5 px-4">
        <h1 className="text-xl font-semibold">One step left</h1>
        <p className="text-sm leading-relaxed text-muted">
          {who.accountId
            ? "This address already has a Walrus Memory account, so there is nothing to create. It only needs permission to read and write inside it."
            : "This address has no Walrus Memory account yet, so it needs one, then permission to read and write inside it."}{" "}
          {who.accountId ? "That" : "Both"} step{who.accountId ? "" : "s"} {who.accountId ? "is" : "are"} signed by
          your wallet, and {who.accountId ? "it" : "they are"} yours to undo — remove the delegate key on
          chain at any time and this app stops working immediately, without our cooperation. That is
          the whole point of doing it this way.
        </p>

        <ol className="space-y-2 text-xs text-muted">
          {who.accountId ? (
            <li>
              <strong className="text-text">1.</strong> Add a delegate key so this app can read
              and write inside your existing account. You will see the exact key you are granting.
            </li>
          ) : (
            <>
              <li>
                <strong className="text-text">1.</strong> Create a Walrus Memory account. The
                account is owned by your address, not by us.
              </li>
              <li>
                <strong className="text-text">2.</strong> Add a delegate key so this app can read
                and write inside it. You will see the exact key you are granting.
              </li>
            </>
          )}
        </ol>

        {ownership.step !== "idle" && (
          <p className="rounded border border-rule bg-base px-3 py-2 text-xs text-muted">
            {ownership.step === "creating" && "Creating your account… approve in your wallet."}
            {ownership.step === "granting" && who.accountId && "Adding the access grant… approve in your wallet."}
            {ownership.step === "granting" && "Now adding the delegate key… approve in your wallet."}
            {ownership.step === "error" && <span className="text-stop">{ownership.message}</span>}
          </p>
        )}

        {ownership.step === "error" && (
          <p className="text-xs text-muted">
            This needs a small amount of SUI for gas. The frictionless version of this step — sign in
            with Google, no wallet, no gas — is on the roadmap and depends on Enoki, which is paid
            and gated. See the README.
          </p>
        )}

        {ownership.step === "needs_account_id" && (
          <div className="rounded border border-warn/30 bg-warn/5 p-3">
            <p className="text-xs leading-relaxed text-warn">
              {ownership.message}
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              Paste the id, or a link containing it. Find it at{" "}
              <a
                href="https://memory.walrus.xyz"
                target="_blank"
                rel="noreferrer"
                className="text-link underline decoration-dotted underline-offset-2"
              >
                memory.walrus.xyz
              </a>{" "}
              — your account row shows it — or in the transaction that created it, on a Sui
              explorer. If you grant access to an account that is not yours, the transaction is
              rejected by the contract and nothing happens.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                value={accountIdDraft}
                onChange={(e) => setAccountIdDraft(e.target.value)}
                placeholder="0x… or paste a link"
                className="mono min-w-0 flex-1 rounded border border-rule bg-base/60 px-2 py-1.5 text-xs text-text outline-none placeholder:text-muted/60 focus:border-accent/50"
              />
              <button
                onClick={() => void ownership.claimAccountId(accountIdDraft)}
                disabled={!accountIdDraft.trim()}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-base disabled:opacity-40"
              >
                Use this account
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <ConnectButton />
          <button
            onClick={() => void ownership.start()}
            disabled={!ownership.canStart || ownership.step === "creating" || ownership.step === "granting"}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-base disabled:opacity-40"
          >
            {ownership.step === "idle" || ownership.step === "error"
              ? who.accountId
                ? "Grant access to my account"
                : "Create my account and grant access"
              : "Working…"}
          </button>
        </div>

        <a href="/api/health" className="text-xs text-muted underline decoration-dotted underline-offset-2">
          check the server config
        </a>
      </main>
    );
  }

  // ── The app ────────────────────────────────────────────────────────────────
  //
  // A left rail and one centred column. The conversation is the product, so the
  // column belongs to it; the other views are the same data from another angle
  // and live in the rail instead of competing for the space.
  return (
    <div className="flex h-screen overflow-hidden bg-base">
      <aside
        className={`hidden shrink-0 flex-col border-r border-rule bg-base transition-all duration-200 lg:flex ${
          sidebarCollapsed ? "w-14 items-center" : "w-60"
        }`}
      >
        <div className={`flex items-center gap-2 py-3.5 ${sidebarCollapsed ? "justify-center px-2" : "px-4"}`}>
          <Mark />
          {!sidebarCollapsed && <span className="text-[15px] font-semibold tracking-tight">People Book</span>}
        </div>

        <div className={`pb-2 ${sidebarCollapsed ? "w-full px-2" : "px-3"}`}>
          <button
            onClick={() => setTab("talk")}
            title="Start over"
            className={`flex items-center gap-2.5 rounded-xl border border-rule bg-base text-left text-[13.5px] text-muted transition-colors hover:bg-panel ${
              sidebarCollapsed ? "h-9 w-9 justify-center p-0" : "w-full px-3 py-2"
            }`}
          >
            <Icon name="new" />
            {!sidebarCollapsed && <span>Start over</span>}
          </button>
        </div>

        <nav className={`space-y-0.5 ${sidebarCollapsed ? "w-full px-2" : "px-2"}`}>
          {(
            [
              ["talk", "Talk to it"],
              ["nudges", "What came to you"],
              ["book", "Your book"],
              ["add", "Write one in"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-current={tab === key}
              title={sidebarCollapsed ? label : undefined}
              className={`rail-item flex items-center text-muted transition-colors ${
                sidebarCollapsed
                  ? "h-9 w-9 justify-center rounded-lg p-0"
                  : "w-full gap-2.5 px-2.5 py-2 text-left text-[13.5px]"
              }`}
            >
              <Icon name={key} />
              {!sidebarCollapsed && <span>{label}</span>}
            </button>
          ))}
        </nav>

        <div className="mt-auto flex w-full flex-col border-t border-rule">
          {!sidebarCollapsed && (
            <div className="px-4 py-3">
              <p className="mono truncate text-[11px] text-faint">
                {who.address?.slice(0, 6)}…{who.address?.slice(-4)}
              </p>
              <p className="mt-1 text-[11px] text-faint">Yours, on Sui</p>
            </div>
          )}

          {/* Sidebar collapse/expand toggle button matching inspiration */}
          <div className={`p-2 flex ${sidebarCollapsed ? "justify-center" : "justify-between items-center px-3"}`}>
            {sidebarCollapsed ? (
              <button
                type="button"
                onClick={() => setSidebarCollapsed(false)}
                className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-panel hover:text-text"
                title="Expand sidebar"
              >
                <SidebarToggleIcon className="h-4 w-4" />
              </button>
            ) : (
              <>
                <span className="text-[11px] text-faint">Collapse</span>
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed(true)}
                  className="grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-panel hover:text-text"
                  title="Collapse sidebar"
                >
                  <SidebarToggleIcon className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-rule-soft px-5 py-3 lg:hidden">
          <div className="flex items-center gap-2">
            <Mark />
            <span className="text-[14px] font-semibold">People Book</span>
          </div>
        </header>

        {modelReady === false && (
          <div className="border-b border-rule bg-warn/10 px-5 py-2.5">
            <p className="text-[13px] leading-5 text-warn">
              <strong className="font-medium">Nothing will be remembered.</strong> GROQ_API_KEY is
              not set, so it has no model to think with and replies are placeholders. Set it, restart.
            </p>
          </div>
        )}

        {error && (
          <div className="px-5 pt-4">
            <ErrorNote message={error} />
          </div>
        )}

        <main className="min-h-0 flex-1">
          {tab === "talk" && <ChatView />}
          {tab !== "talk" && (
            <div className="h-full overflow-y-auto px-5 py-8">
              <div className="mx-auto w-full max-w-thread">
                {tab === "nudges" && <NudgeView key={version} onForget={forget} />}
                {tab === "book" && <LedgerView key={version} onForget={forget} />}
                {tab === "add" && <AddView onSaved={() => setVersion((v) => v + 1)} />}
              </div>
            </div>
          )}
        </main>

      </div>
    </div>
  );
}


function Mark({ className = "h-5 w-5 text-accent" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path
        d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07l14.14-14.14"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" />
    </svg>
  );
}

function SidebarToggleIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <rect x="2" y="2.5" width="12" height="11" rx="2" strokeWidth="1.3" />
      <path d="M6 2.5v11" strokeWidth="1.3" />
    </svg>
  );
}

type IconName = Tab | "new";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    new: "M8 3.5v9M3.5 8h9",
    talk: "M3 5.5A1.5 1.5 0 0 1 4.5 4h7A1.5 1.5 0 0 1 13 5.5v4a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5h-.5A1.5 1.5 0 0 1 3 9.5v-4Z",
    nudges: "M8 2v3M8 11v3M2 8h3M11 8h3M4.2 4.2l2.1 2.1M9.7 9.7l2.1 2.1M11.8 4.2l-2.1 2.1M6.3 9.7l-2.1 2.1",
    book: "M3 3.5h10v9H3v-9Zm0 2.5h10M6 9h4",
    add: "M8 3.5v9M3.5 8h9",
  };
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0 opacity-80" aria-hidden="true">
      <path
        d={paths[name]}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export type { PersonMemory };
