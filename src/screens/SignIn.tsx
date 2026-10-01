import { ConnectButton } from "../lib/auth.ts";
import { useState } from "react";
import { Mark } from "./Landing.tsx";
import type { SignInState } from "../lib/auth.ts";

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
  walletConnected,
  address,
  hasAccount,
  step,
  onCreateAndGrant,
  onClaim,
  busy,
  error,
}: {
  state: SignInState;
  onSignIn: () => void;
  /** Whether a wallet is plugged in, which is a different step from signing. */
  walletConnected: boolean;
  address?: string;
  hasAccount: boolean;
  step: string;
  onCreateAndGrant: () => void;
  onClaim: (id: string) => void;
  busy: boolean;
  error?: string;
}) {
  const working = busy;
  const [accountDraft, setAccountDraft] = useState("");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-5 py-10">
      <a href="/" className="flex w-fit items-center gap-2.5 text-faint transition-colors hover:text-muted">
        <Mark />
        <span className="text-[13px] font-bold">People Book</span>
      </a>

      {!address ? (
        <section className="mt-5">
          <h1 className="text-xl font-bold tracking-tight text-text">Sign in</h1>
          <p className="mt-2.5 text-[13.5px] leading-6 text-muted">
            You will sign one message so we can prove the address is yours. Nothing
            is sent anywhere and nothing costs gas.
          </p>

          {/* Connect, then sign -- one at a time. They used to sit side by side,
              which asked the visitor to choose between two buttons doing
              different halves of the same job, and gave no way to tell which was
              which. */}
          <div className="mt-5">
            {!walletConnected ? (
              <ConnectButton />
            ) : (
              <button
                onClick={onSignIn}
                className="rounded-lg bg-accent px-4 py-2.5 text-[13px] font-bold text-base transition-opacity hover:opacity-90"
              >
                Sign the message
              </button>
            )}
          </div>

          {state.phase !== "disconnected" && state.phase !== "error" && (
            <pre className="mono mt-5 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-rule bg-panel p-3 text-[11px] leading-5 text-faint">
              {state.phase === "signing" ? state.message : "preparing…"}
            </pre>
          )}
          {state.phase === "error" && (
            <p className="mt-5 text-[13px] leading-6 text-stop">{state.message}</p>
          )}
          {error && <p className="mt-5 text-[13px] text-stop">{error}</p>}
        </section>
      ) : (
        <section className="mt-5">
          <h1 className="text-xl font-bold tracking-tight text-text">One step left</h1>
          <p className="mt-2.5 text-[13.5px] leading-6 text-muted">
            Signed in as{" "}
            <span className="mono text-[13px] text-text">
              {address.slice(0, 6)}…{address.slice(-4)}
            </span>
            .{" "}
            {hasAccount
              ? "This address already has a Walrus Memory account, so it just needs permission."
              : "This address has no Walrus Memory account yet, so it needs one, then permission."}
          </p>

          <ol className="mt-4 space-y-2 text-[12.5px] leading-6 text-muted">
            {hasAccount ? (
              <li>
                <span className="text-text">1.</span> Approve a delegate key, so this app
                can read and write inside your account. You will see the exact key you
                are granting.
              </li>
            ) : (
              <>
                <li>
                  <span className="text-text">1.</span> Create a Walrus Memory account. It
                  is owned by your address, not by us.
                </li>
                <li>
                  <span className="text-text">2.</span> Approve a delegate key, so this app
                  can read and write inside it.
                </li>
              </>
            )}
            <li>
              <span className="text-text">{hasAccount ? "2" : "3"}.</span> That is it. These
              are wallet transactions, so they need a little SUI for gas.
            </li>
          </ol>

          <button
            onClick={onCreateAndGrant}
            disabled={working}
            className="mt-6 rounded-lg bg-accent px-4 py-2.5 text-[13px] font-bold text-base transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {working ? "working — approve in your wallet…" : hasAccount ? "Grant access" : "Create account and grant access"}
          </button>

          {step !== "idle" && (
            <p className="mono mt-4 text-[12px] leading-5 text-faint">
              {step === "creating" && "Creating your account…"}
              {step === "granting" && "Adding the delegate key…"}
            </p>
          )}

          {/* The escape hatch, and it earns its place. This screen says "you have
              no account" because the registry had no entry -- but a failed lookup
              and a genuinely new address look identical from here. Without this,
              the app would confidently offer to create an account that already
              exists and fail onchain. */}
          <details className="mt-6 border-t border-rule pt-5">
            <summary className="cursor-pointer text-[12px] text-faint transition-colors hover:text-muted">
              I already have a Walrus Memory account
            </summary>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                value={accountDraft}
                onChange={(e) => setAccountDraft(e.target.value)}
                placeholder="0x... or an explorer link"
                aria-label="Your Walrus Memory account id"
                className="mono min-w-0 flex-1 rounded border border-rule bg-panel px-2.5 py-2 text-[12px] text-text outline-none placeholder:text-faint focus:border-accent/50"
              />
              <button
                onClick={() => onClaim(accountDraft.trim())}
                disabled={!accountDraft.trim() || busy}
                className="rounded border border-rule px-3 py-2 text-[12px] text-muted transition-colors hover:bg-raised hover:text-text disabled:opacity-40"
              >
                Use it
              </button>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-faint">
              Checked against the registry, so this cannot be pointed at somebody
              else's account.
            </p>
          </details>

          <p className="mt-6 text-[12px] leading-6 text-faint">
            Granting gives this app a scoped key to your account. It can be removed
            in one transaction on Sui, and the account goes quiet immediately —
            that is the whole revocation story, and there is no other way to take
            it away.
          </p>
        </section>
      )}
    </main>
  );
}