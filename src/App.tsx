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

  // ── Not set up yet ─────────────────────────────────────────────────────────
  // Two distinct states, and conflating them broke it: an address that already
  // has a Walrus Memory account from another app does NOT need one created, only
  // the grant. The old gate keyed on accountId alone, so anyone with an existing
  // account was sent past setup and then had every write fail as unauthorized.
  if (!who.accountId || !who.hasDelegate) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-5 px-4">
        <h1 className="text-xl font-semibold">One step left</h1>
        <p className="text-sm leading-relaxed text-quiet">
          {who.accountId
            ? "This address already has a Walrus Memory account, so there is nothing to create. It only needs permission to read and write inside it."
            : "This address has no Walrus Memory account yet, so it needs one, then permission to read and write inside it."}{" "}
          {who.accountId ? "That" : "Both"} step{who.accountId ? "" : "s"} {who.accountId ? "is" : "are"} signed by
          your wallet, and {who.accountId ? "it" : "they are"} yours to undo — remove the delegate key on
          chain at any time and this app stops working immediately, without our cooperation. That is
          the whole point of doing it this way.
        </p>

        <ol className="space-y-2 text-xs text-quiet">
          {who.accountId ? (
            <li>
              <strong className="text-bright">1.</strong> Add a delegate key so this app can read
              and write inside your existing account. You will see the exact key you are granting.
            </li>
          ) : (
            <>
              <li>
                <strong className="text-bright">1.</strong> Create a Walrus Memory account. The
                account is owned by your address, not by us.
              </li>
              <li>
                <strong className="text-bright">2.</strong> Add a delegate key so this app can read
                and write inside it. You will see the exact key you are granting.
              </li>
            </>
          )}
        </ol>

        {ownership.step !== "idle" && (
          <p className="rounded border border-line bg-surface px-3 py-2 text-xs text-quiet">
            {ownership.step === "creating" && "Creating your account… approve in your wallet."}
            {ownership.step === "granting" && who.accountId && "Adding the access grant… approve in your wallet."}
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

        {ownership.step === "needs_account_id" && (
          <div className="rounded border border-warn/30 bg-warn/5 p-3">
            <p className="text-xs leading-relaxed text-warn">
              {ownership.message}
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-quiet">
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
                className="mono min-w-0 flex-1 rounded border border-line bg-ink/60 px-2 py-1.5 text-xs text-bright outline-none placeholder:text-quiet/60 focus:border-accent/50"
              />
              <button
                onClick={() => void ownership.claimAccountId(accountIdDraft)}
                disabled={!accountIdDraft.trim()}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-40"
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
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-40"
          >
            {ownership.step === "idle" || ownership.step === "error"
              ? who.accountId
                ? "Grant access to my account"
                : "Create my account and grant access"
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
  //
  // A left rail and one centred column. The conversation is the product, so the
  // column belongs to it; the other views are the same data from another angle
  // and live in the rail instead of competing for the space.
  return (
    <div className="flex h-screen overflow-hidden bg-ink">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex items-center gap-2 px-4 py-3.5">
          <Mark />
          <span className="text-[15px] font-semibold tracking-tight">People Book</span>
        </div>

        <div className="px-3 pb-2">
          <button
            onClick={() => setTab("talk")}
            className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-ink px-3 py-2 text-left text-[13.5px] text-quiet transition-colors hover:bg-surface-2"
          >
            <Icon name="new" />
            New conversation
          </button>
        </div>

        <nav className="px-2">
          {(
            [
              ["talk", "Talk"],
              ["nudges", "What came to you"],
              ["book", "Your book"],
              ["add", "Add by hand"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-current={tab === key}
              className="rail-item mb-0.5 flex w-full items-center gap-2.5 px-2.5 py-2 text-left text-[13.5px] text-quiet"
            >
              <Icon name={key} />
              {label}
            </button>
          ))}
        </nav>

        <div className="mt-5 px-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-faint">Your memory</p>
        </div>
        <StorageNote />

        <div className="mt-auto border-t border-line px-3 py-3">
          <p className="mono truncate px-1 text-[11px] text-faint">
            {who.address?.slice(0, 6)}…{who.address?.slice(-4)}
          </p>
          <div className="mt-1.5 flex items-center justify-between px-1">
            <span className="text-[11px] text-faint">Owned by you, on Sui</span>
            <a
              href="/api/export"
              className="text-[11px] text-quiet underline decoration-dotted underline-offset-2 hover:text-bright"
            >
              export
            </a>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line-soft px-5 py-3 lg:hidden">
          <div className="flex items-center gap-2">
            <Mark />
            <span className="text-[14px] font-semibold">People Book</span>
          </div>
          <a href="/api/export" className="text-[12px] text-quiet">
            export
          </a>
        </header>

        {modelReady === false && (
          <div className="border-b border-line bg-warn/10 px-5 py-2.5">
            <p className="text-[13px] leading-5 text-warn">
              <strong className="font-medium">No model configured.</strong> GROQ_API_KEY is not set,
              so nothing said here is remembered and replies are placeholders. Set it and restart.
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
              <div className="thread">
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

/**
 * The honest version of a storage meter.
 *
 * Every chat interface has one of these, and most of them are decorative. This one
 * reads the real blob count from the relayer and says "reading…" rather than
 * inventing a number, because the alternative is a lie about the user's own data.
 */
function StorageNote() {
  const [count, setCount] = useState<number | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unknown">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/memories", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { blobCount?: number; count?: number }) => {
        if (cancelled) return;
        const value = body.blobCount ?? body.count;
        if (typeof value === "number") {
          setCount(value);
          setState("ok");
        } else {
          setState("unknown");
        }
      })
      .catch(() => !cancelled && setState("unknown"));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="px-4 py-2.5">
      <p className="text-[11.5px] leading-4 text-quiet">
        {state === "loading" && "Reading your book…"}
        {state === "ok" && count !== null && (
          <>
            <span className="tabular font-medium text-bright">{count}</span> encrypted blobs in
            Walrus Memory
          </>
        )}
        {state === "unknown" && "Your book lives in your own Walrus Memory account."}
      </p>
    </div>
  );
}

function Mark() {
  return (
    <span className="grid h-5 w-5 place-items-center rounded-md bg-accent text-[11px] font-bold text-ink">
      P
    </span>
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
