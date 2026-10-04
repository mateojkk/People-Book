import { ConnectButton } from "../lib/auth.js";
import { Mark } from "./Landing.js";
import type { SignInState } from "../lib/auth.js";

/**
 * Signing in, and setting the account up.
 *
 * Kept apart from the landing page because this is where someone is about to sign
 * something and grant something. They are entitled to be told exactly what, in
 * advance, rather than discovering it in a wallet confirmation dialog.
 *
 * Two states that are genuinely different and used to be conflated: an address
 * that already has a Walrus Memory account from another app does not need one
 * created, only the grant. Keying on the account alone sent those people past
 * setup and then failed every write as unauthorized.
 */
export function SignIn({
  state,
  onSignIn,
  onDisconnect,
  walletConnected,
  address,
  hasAccount,
  step,
  onCreateAndGrant,
  onClaim,
  accountDraft,
  setAccountDraft,
  busy,
  error,
  setupMessage,
}: {
  state: SignInState;
  onSignIn: () => void;
  onDisconnect: () => void;
  accountDraft: string;
  setAccountDraft: (v: string) => void;
  /** Whether a wallet is plugged in, which is a different step from signing. */
  walletConnected: boolean;
  address?: string;
  hasAccount: boolean;
  step: string;
  onCreateAndGrant: () => void;
  onClaim: (id: string) => void;
  busy: boolean;
  error?: string;
  /** The setup flow's own message, shown next to the button that produced it. */
  setupMessage?: string;
}) {
  const working = busy;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6 py-12">
      <a
        href="/"
        className="-mx-2 flex min-h-11 w-fit items-center gap-2.5 rounded px-2 text-faint transition-colors hover:text-muted"
      >
        <Mark />
        <span className="text-[13px] font-bold">People Book</span>
      </a>

      {!address ? (
        <section className="mt-5">
          <h1 className="text-xl font-bold tracking-tight text-text">Sign in</h1>
          <p className="mt-2 text-[13px] leading-6 text-muted">
            One signature proves the address is yours. Free.
          </p>

          <div className="mt-5">
            {!walletConnected ? (
              <>
                <ConnectButton />
                <details className="mt-3">
                  <summary className="cursor-pointer text-[11.5px] text-faint hover:text-muted">
                    Connecting fails or loops?
                  </summary>
                  <p className="mt-1.5 text-[11.5px] leading-5 text-faint">
                    Install the Slush browser extension and connect through that
                    instead of the web popup.
                  </p>
                </details>
              </>
            ) : (
              <button
                onClick={onSignIn}
                className="min-h-11 rounded-lg bg-accent px-5 py-3 text-[13px] font-bold text-base transition-opacity hover:opacity-90"
              >
                Sign the message
              </button>
            )}
          </div>

          {/* Phases log to the console, not the page. A <pre> of internal state
              used to sit here; it answered a debugging question no visitor asked. */}
          {state.phase === "error" && (
            <p className="mt-5 text-[13px] leading-6 text-stop">{state.message}</p>
          )}
          {error && <p className="mt-5 text-[13px] text-stop">{error}</p>}
        </section>
      ) : (
        <section className="mt-5">
          <h1 className="text-xl font-bold tracking-tight text-text">One step left</h1>
          <p className="mt-2 text-[13px] leading-6 text-muted">
            <span className="mono text-text">
              {address.slice(0, 6)}…{address.slice(-4)}
            </span>
            {" — "}
            {hasAccount
              ? "grant this browser access to your account."
              : "create your account, then grant this browser access."}{" "}
            Needs a little SUI for gas.
          </p>

          <button
            onClick={onCreateAndGrant}
            disabled={working}
            className="mt-5 rounded-lg bg-accent px-4 py-2.5 text-[13px] font-bold text-base transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {working ? "Approve in your wallet…" : hasAccount ? "Grant access" : "Create account and grant access"}
          </button>

          {step !== "idle" && step !== "done" && (
            <p className="mono mt-3 text-[12px] text-faint">
              {step === "creating" && "Creating your account…"}
              {step === "granting" && "Adding the key…"}
              {step === "error" && "That did not go through — see below."}
              {step === "needs_account_id" && "This address already has an account — paste its id below."}
            </p>
          )}

          {(step === "error" || step === "needs_account_id") && setupMessage && (
            <p className={`mt-3 rounded-lg bg-panel px-4 py-3 text-[12.5px] leading-6 ${step === "error" ? "text-stop" : "text-muted"}`}>
              {setupMessage}
            </p>
          )}

          <details className="mt-5 bg-panel px-4 py-3 rounded-lg">
            <summary className="cursor-pointer text-[12px] text-faint transition-colors hover:text-muted">
              I already have a Walrus Memory account
            </summary>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                value={accountDraft}
                onChange={(e) => setAccountDraft(e.target.value)}
                placeholder="0x... or an explorer link"
                aria-label="Your Walrus Memory account id"
                className="mono min-w-0 flex-1 rounded bg-raised px-2.5 py-2 text-[12px] text-text outline-none placeholder:text-faint focus-visible:outline-2 focus-visible:outline-accent"
              />
              <button
                onClick={() => onClaim(accountDraft.trim())}
                disabled={!accountDraft.trim() || busy}
                className="rounded bg-raised px-3 py-2 text-[12px] text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:opacity-40"
              >
                Use it
              </button>
            </div>
          </details>

          <p className="mt-4 text-[11.5px] leading-5 text-faint">
            Revocable in one Sui transaction.{" "}
            <button
              onClick={onDisconnect}
              className="underline decoration-dotted underline-offset-2 transition-colors hover:text-muted"
              title="Ends this session and unplugs the wallet. Access granted on chain stays until removed there."
            >
              Disconnect wallet
            </button>
          </p>
        </section>
      )}
    </main>
  );
}