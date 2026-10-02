/**
 * The landing page.
 *
 * Separate from signing in, on purpose. The old gate did both at once, which
 * meant the first thing a visitor saw was a paragraph explaining self-custody
 * next to a button asking them to sign a message -- an explanation of the
 * mechanism standing in for an explanation of the thing.
 *
 * So this says what it is, in three lines, and offers one action. Everything
 * about keys, accounts and revocation lives on the sign-in screen, where the
 * person is about to do the thing and can be told what they are agreeing to.
 */
export function Landing({ onSignIn }: { onSignIn: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-6 py-12">
      <div className="flex items-center gap-2.5">
        <Mark />
        <span className="text-sm font-bold tracking-tight">People Book</span>
      </div>

      <h1 className="mt-8 text-[26px] leading-[1.15] font-bold tracking-tight text-text sm:text-[2.1rem]">
        It remembers the people
        <br />
        in your life.
      </h1>

      <p className="mt-4 max-w-[36rem] text-[14.5px] leading-7 text-muted">
        Birthdays, promises you have not kept, people who have gone quiet, the way
        someone takes a call. You talk, it works out what is worth keeping — and
        then it brings things up before you have to ask.
      </p>

      <p className="mt-3 max-w-[36rem] text-[13.5px] leading-7 text-faint">
        No account to sign up for. No server holding your life. Your memory lives
        in a Walrus Memory account that you own on Sui, and this app holds a
        delegate key you granted — which you can take away on chain, at any time,
        and it will not be able to stop you.
      </p>

      <div className="mt-7 flex flex-wrap items-center gap-3">
        <button
          onClick={onSignIn}
          className="rounded-lg bg-accent px-4 py-2.5 text-[13px] font-bold text-base transition-colors hover:bg-accent/85"
        >
          Sign in with a Sui wallet
        </button>
        <span className="text-[12px] text-faint">One signature. About a minute.</span>
      </div>

      <dl className="mt-10 grid gap-px overflow-hidden rounded-lg border border-rule bg-rule sm:grid-cols-3">
        {[
          ["Owned by you", "The account is a Sui object under your address."],
          ["Revocable", "One onchain transaction ends this app's access."],
          ["Cited", "Every claim it makes points at the memory behind it."],
        ].map(([term, detail]) => (
          <div key={term} className="bg-base px-3.5 py-3">
            <dt className="text-[12px] font-bold text-text">{term}</dt>
            <dd className="mt-1 text-[11.5px] leading-5 text-faint">{detail}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}

export function Mark({ className = "h-5 w-5 text-accent" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07l14.14-14.14" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" />
    </svg>
  );
}