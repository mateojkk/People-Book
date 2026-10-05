/**
 * The app shell.
 *
 * The gate is the wallet + signed challenge. Beyond that the app is deliberately
 * plain, because the things it has to prove are not visual.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectButton, useSignIn } from "./lib/auth.js";
import { useOwnership } from "./lib/ownership.js";
import { api } from "./lib/api.js";
import { NudgeView } from "./components/NudgeView.js";
import { LedgerView } from "./components/LedgerView.js";
import { Workspace } from "./screens/Workspace.js";
import { Landing } from "./screens/Landing.js";
import { SignIn } from "./screens/SignIn.js";
import { ErrorNote } from "./components/bits.js";
import { Routes, Route, Link, useLocation, useNavigate } from "react-router-dom";
import { Mark } from "./screens/Landing.js";
import { ToastStack, useToasts } from "./components/Toast.js";
import type { PersonMemory } from "./types.js";

type Tab = "talk" | "notifications" | "book" | "profile";

interface Whoami {
  signedIn: boolean;
  address?: string;
  /** null when the address has no Walrus Memory account at all. */
  accountId?: string | null;
  /** Whether this app's delegate key is registered on that account. */
  hasDelegate?: boolean;
}

/**
 * Routing.
 *
 * ── What the hand-rolled version got wrong ────────────────────────────────────
 * It matched with `pathname.startsWith("/app")`, so `/application` and `/appx`
 * were the app, and `/signin-help` was the sign-in screen. Anything it did not
 * recognise fell through to the landing page, so a typo looked like a working
 * site rather than a missing one. And the tabs were `useState`, which meant the
 * back button walked you out of the app entirely instead of from Notifications
 * back to the chat -- the URL never said where you were, so it could not be
 * shared, bookmarked or reloaded into the same place.
 *
 * The tabs are routes now: `/app`, `/app/notifications`, `/app/book`. The rail
 * navigates, the back button works, and a reload lands where you were.
 *
 * ── Auth still never moves you ────────────────────────────────────────────────
 * There is deliberately no redirect and no guard element here. There was one:
 * signing in while sitting on the landing page threw you into the app, replacing
 * the page you chose with one you did not ask for, the moment a background
 * refetch finished. In a deep link it was worse, because the address bar lied.
 *
 * So authentication changes what a route *renders*, never where you are.
 * `/app` without a granted account renders the setup screen at `/app`, not at
 * `/signin`. If that feels like a missing guard, it is a feature: a guard here
 * is a redirect, and a redirect is what you asked me to remove.
 */

export default function App() {
  const { account, state, signIn, disconnect } = useSignIn();
  const nav = useNavigate();
  const { toasts, push, dismiss } = useToasts();

  const [who, setWho] = useState<Whoami | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const ownership = useOwnership(() => void refreshWho());
  const [accountIdDraft, setAccountIdDraft] = useState("");
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
      // Cleared on the way in, not just on success. This flag was only ever set,
      // never reset, so a single failed delete left a permanent red banner over
      // the conversation for the rest of the session -- including after the thing
      // that caused it had been dealt with.
      setError(null);
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

  // ── Not set up yet ─────────────────────────────────────────────────────────
  // Two distinct states, and conflating them broke it: an address that already
  // has a Walrus Memory account from another app does NOT need one created, only
  // the grant. The old gate keyed on accountId alone, so anyone with an existing
  // account was sent past setup and then had every write fail as unauthorized.

  const ready = Boolean(who?.signedIn && who.accountId && who.hasDelegate);

  // Announce the moment you get in, once. Keyed on the address so a reconnect
  // mid-session does not repeat it, and guarded so React's double-invoke in
  // development cannot fire it twice either.
  const greeted = useRef<string | null>(null);
  useEffect(() => {
    const address = who?.signedIn ? who.address : undefined;
    if (!ready || !address || greeted.current === address) return;
    greeted.current = address;
    push({
      tone: "info",
      title: `Signed in as ${address.slice(0, 6)}…${address.slice(-4)}`,
      detail: "Your book is open. Ask it what happened.",
    });
    // Warm every tab's data now, while the user is still reading the greeting.
    // Each tab fetches on mount; without this the first visit to each one pays
    // a full ledger read. With the GET cache, these land in it, and the tab
    // mounts share the in-flight request or read it back instead of fetching.
    //
    // Fire and forget, failures silent: a prefetch that errors must not surface
    // anywhere, because the tab will fetch on mount exactly as before. This only
    // ever makes things faster, never different.
    // Sequential, not concurrent. Five full reads at once from a cold start fan
    // out across isolates with no shared cache -- five enumerates, forty recalls
    // in the same second, which is the throttle pattern. One after another costs
    // seconds once and never stampedes.
    void (async () => {
      for (const path of ["/api/today", "/api/memories", "/api/profile", "/api/corrections", "/api/patterns"]) {
        try {
          await api.get(path);
        } catch {
          // Silent by design (see above): the tab fetches on mount as before.
        }
      }
    })();
  }, [ready, who?.signedIn, who?.address, push]);

  /**
   * Moving forward after the setup click, and only then.
   *
   * There is deliberately no route guard and no background redirect — signing in
   * must never move you off the page you chose (see the note above). But there is
   * one case where movement is the *point*: you pressed a button whose whole job
   * is to get you into the app. Without this, a completed setup left you on
   * /signin with a button that had correctly done nothing, which read as broken.
   *
   * Keyed on the `done` step rather than on `ready`, so an address that was
   * already set up when you arrived is not teleported anywhere — only an action
   * you took causes this.
   */
  const enteredApp = useRef(false);
  useEffect(() => {
    if (ownership.step !== "done" || enteredApp.current) return;
    enteredApp.current = true;
    nav("/app");
  }, [ownership.step, nav]);

  const signInScreen = (
    <SignIn
      state={state}
      onSignIn={() => void signIn()}
      onDisconnect={() => void disconnect(() => nav("/", { replace: true }))}
      walletConnected={Boolean(account?.address)}
      address={who?.signedIn ? who.address : undefined}
      hasAccount={Boolean(who?.accountId)}
      step={ownership.step}
      onCreateAndGrant={() => void ownership.start()}
      onClaim={(id) => void ownership.claimAccountId(id)}
      accountDraft={accountIdDraft}
      setAccountDraft={setAccountIdDraft}
      busy={ownership.step === "creating" || ownership.step === "granting"}
      setupMessage={ownership.message}
    />
  );

  return (
    <>
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      <OnNavigate />
      <Routes>
        <Route path="/" element={<Landing onSignIn={() => nav("/signin")} />} />

        {/* Always the setup screen, whatever the auth state. */}
        <Route path="/signin" element={signInScreen} />

        {/* No guard. Without a granted account the setup screen renders here, at
            /app, and the URL is left alone. A guard here would be a redirect. */}
        <Route
          path="/app/*"
          element={
            ready ? (
              <Workspace
                address={who?.address}
                onDisconnect={() => void disconnect(() => nav("/", { replace: true }))}
                version={version}
                onForget={forget}
                error={error}
                modelReady={modelReady}
              />
            ) : (
              signInScreen
            )
          }
        />

        {/* Previously anything unrecognised fell through to the landing page, so a
            typo looked like a working site instead of a missing one. */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}

/**
 * Two things a route change has to do that a plain re-render does not.
 *
 * Scroll: without this, going from a scrolled chat back to the landing page keeps
 * the scroll position, and you land halfway down a page you have not read.
 *
 * Focus: without this, keyboard and screen-reader users stay wherever they were.
 * A single-page app changes the page without the browser knowing, so focus is
 * left on a link that no longer exists and the next Tab jumps somewhere
 * unrelated. The heading of the new page is the correct place to be.
 */
function OnNavigate() {
  const { pathname } = useLocation();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      // A reload is not a navigation. Leave a deep link's scroll position alone,
      // because the browser restored it deliberately.
      first.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    const target = document.querySelector<HTMLElement>("[data-route-heading]") ?? document.querySelector("h1");
    target?.focus({ preventScroll: true });
  }, [pathname]);

  return null;
}

/**
 * A missing page, said plainly.
 *
 * It offers one way out rather than a menu, and it does not pretend the address
 * was nearly right -- guessing is how you end up shipping a broken link with a
 * cheerful 404 on top of it.
 */
function NotFound() {
  return (
    <div data-screen="notfound" className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-6 py-12">
      <div className="flex items-center gap-2.5">
        <Mark />
        <span className="text-sm font-bold tracking-tight">People Book</span>
      </div>
      <h1 tabIndex={-1} data-route-heading className="mt-8 text-[26px] leading-[1.15] font-bold tracking-tight text-text outline-none sm:text-[2.1rem]">
        There is nothing at this address.
      </h1>
      <p className="mt-4 max-w-[36rem] text-[14.5px] leading-7 text-muted">
        If you followed a link here, it is out of date.
      </p>
      <div className="mt-9">
        <Link
          to="/"
          className="inline-flex min-h-11 items-center rounded-lg bg-accent px-5 py-3 text-[13px] font-bold text-base transition-colors hover:bg-accent/85"
        >
          Back to the start
        </Link>
      </div>
    </div>
  );
}





export type { PersonMemory };
