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
import { Workspace } from "./screens/Workspace.tsx";
import { Landing } from "./screens/Landing.tsx";
import { SignIn } from "./screens/SignIn.tsx";
import { ErrorNote } from "./components/bits.tsx";
import type { PersonMemory } from "./types.ts";

type Tab = "talk" | "notifications" | "book";

interface Whoami {
  signedIn: boolean;
  address?: string;
  /** null when the address has no Walrus Memory account at all. */
  accountId?: string | null;
  /** Whether this app's delegate key is registered on that account. */
  hasDelegate?: boolean;
}

type Route = "landing" | "signin" | "app";

/**
 * Three routes, decided by hand. No router dependency for three paths.
 *
 * ── Auth never moves you ──────────────────────────────────────────────────────
 * There is no redirect anywhere in this file, and that is deliberate. There was:
 * signing in while sitting on the landing page threw you straight into the app,
 * which meant the page you chose was replaced by one you did not ask for the
 * moment a background refetch finished. It is disorienting in a browser and
 * baffling in a deep link.
 *
 * So authentication changes what a route *renders*, never where you are.
 * `/app` without a granted account renders the setup screen in place, at `/app`,
 * rather than bouncing you to `/signin`. Moving on is something you do, not
 * something the app does to you.
 */
function routeFor(pathname: string): Route {
  if (pathname.startsWith("/signin")) return "signin";
  if (pathname.startsWith("/app")) return "app";
  return "landing";
}

export default function App() {
  const { account, state, signIn, disconnect } = useSignIn();
  const [path, setPath] = useState(() => window.location.pathname);
  const go = useCallback((to: string) => {
    window.history.pushState({}, "", to);
    setPath(to);
  }, []);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [tab, setTab] = useState<Tab>("talk");
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

  const route = routeFor(path);
  const ready = Boolean(who?.signedIn && who.accountId && who.hasDelegate);

  if (route === "landing") {
    return <Landing onSignIn={() => go("/signin")} />;
  }

  // /signin always shows this, whatever the auth state. /app shows it too when
  // there is no granted account -- in place, at /app, with the URL left alone.
  // Nothing here redirects: signing in does not move you off the page you chose.
  if (route === "signin" || !ready) {
    return (
      <SignIn
        state={state}
        onSignIn={() => void signIn()}
        onDisconnect={() => void disconnect(() => go("/"))}
        walletConnected={Boolean(account?.address)}
        address={who?.signedIn ? who.address : undefined}
        hasAccount={Boolean(who?.accountId)}
        step={ownership.step}
        onCreateAndGrant={() => void ownership.start()}
        onClaim={(id) => void ownership.claimAccountId(id)}
        accountDraft={accountIdDraft}
        setAccountDraft={setAccountIdDraft}
        busy={ownership.step === "creating" || ownership.step === "granting"}
      />
    );
  }

  return (
    <Workspace
      tab={tab}
      setTab={setTab}
      address={who?.address}
      onDisconnect={() => void disconnect(() => go("/"))}
      version={version}
      onForget={forget}
      error={error}
      modelReady={modelReady}
    />
  );
}





export type { PersonMemory };
