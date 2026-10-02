/**
 * The landing page.
 *
 * A normal landing page: nav, hero, sections, one CTA, footer. It used to be a
 * single 768px column with everything vertically centred, which read as a poster
 * with a sentence on it — cramped into the middle of a tall empty page, with
 * nothing to scroll and no reason to.
 *
 * Separate from signing in, on purpose. The old gate did both at once, which
 * meant the first thing a visitor saw was a paragraph explaining self-custody
 * next to a button asking them to sign a message -- an explanation of the
 * mechanism standing in for an explanation of the thing.
 *
 * So the hero says what it is and offers one action. Everything about keys,
 * accounts and revocation lives further down, where there is room for it.
 */
import { Link } from "react-router-dom";
import { LandingBackdrop } from "../components/LandingBackdrop";

const CTA = "inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-5 py-3 text-[13px] font-bold text-base transition-colors hover:bg-accent/85";

export function Landing({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div data-screen="landing" className="min-h-screen">
      <LandingBackdrop />

      <Nav />

      <main className="mx-auto w-full max-w-6xl px-5 sm:px-8">
        <Hero onSignIn={onSignIn} />
        <WhatItHolds />
        <ItTalks />
        <TheBook />
        <TheNudge />
        <Yours />
        <ClosingCta onSignIn={onSignIn} />
      </main>

      <Footer />
    </div>
  );
}

/**
 * Nav.
 *
 * Minimal on purpose: a brand and the one action. A nav full of links to pages
 * that do not exist yet is the most common way a landing page wastes the only
 * thing it has -- attention.
 */
function Nav() {
  return (
    <nav className="mx-auto w-full max-w-6xl px-5 py-5 sm:px-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Mark />
          <span className="text-sm font-bold tracking-tight">People Book</span>
        </div>
        <Link
          to="/signin"
          className="-mr-2 inline-flex min-h-11 items-center rounded px-2 text-[13px] text-muted transition-colors hover:text-text"
        >
          Sign in
        </Link>
      </div>
    </nav>
  );
}

/**
 * Hero.
 *
 * Full width, not a 768px column. Mono is a wide face, and the measure that suits
 * a single sentence in the middle of a screen is not the measure that suits a
 * headline with a paragraph under it.
 */
function Hero({ onSignIn }: { onSignIn: () => void }) {
  return (
    <header className="pb-24 pt-16 sm:pb-32 sm:pt-24">
      <h1
        tabIndex={-1}
        data-route-heading
        className="max-w-[22ch] text-[2.4rem] leading-[1.05] font-bold tracking-tight text-text outline-none sm:text-[3.6rem]"
      >
        It remembers the people in your life.
      </h1>
      <p className="mt-6 max-w-[58ch] text-[15px] leading-7 text-muted">
        Birthdays, promises you have not kept, people who have gone quiet, the way
        someone takes a call. You talk, it works out what is worth keeping — and it
        says so when it is time.
      </p>
      <div className="mt-9">
        <button type="button" onClick={onSignIn} className={CTA}>
          Sign in with a Sui wallet
        </button>
      </div>
      <p className="mt-4 text-[12px] text-faint">
        No email. Nothing stored anywhere but your own account.
      </p>
    </header>
  );
}

/** A section label. The small caps are the only place colour is used for structure. */
function Label({ children }: { children: string }) {
  return <p className="text-[11.5px] font-bold tracking-wider text-accent uppercase">{children}</p>;
}

function Section({
  label,
  title,
  lead,
  children,
}: {
  label: string;
  title: string;
  lead?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="py-20 sm:py-24">
      <Label>{label}</Label>
      <h2 className="mt-4 max-w-[24ch] text-[1.6rem] leading-[1.15] font-bold tracking-tight text-text sm:text-[2rem]">
        {title}
      </h2>
      {lead && <p className="mt-4 max-w-[62ch] text-[14.5px] leading-7 text-muted">{lead}</p>}
      {children && <div className="mt-10">{children}</div>}
    </section>
  );
}

/**
 * What it holds.
 *
 * Three cards, tonal rather than outlined. These are the only three claims the
 * product actually makes about content, so the section is exactly three.
 */
function WhatItHolds() {
  const items = [
    {
      title: "The people",
      body: "Who matters, and the details you would otherwise have to ask about: how they take a call, who they are to you, what you are supposed to have heard back about.",
    },
    {
      title: "The promises",
      body: "What you said you would do, and whether you did. It brings one back at the moment it stops being a promise and starts being an omission.",
    },
    {
      title: "The plans",
      body: "Birthdays, anniversaries, the thing next Tuesday. Say a date once and it carries forward, instead of needing re-telling every year.",
    },
  ];
  return (
    <Section
      label="What it holds"
      title="Three things worth remembering, and nothing else."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {items.map((i) => (
          <div key={i.title} className="rounded-xl bg-panel p-5">
            <h3 className="text-[13.5px] font-bold text-text">{i.title}</h3>
            <p className="mt-2.5 text-[13px] leading-6 text-muted">{i.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** How it works. The point is that there is no form. */
function ItTalks() {
  return (
    <Section
      label="How it works"
      title="You talk to it. There is nothing to fill in."
      lead="Most memory tools make you maintain them. A box for a birthday, a field for a note, a list that only ever gets longer, and nobody has ever filled one in. So you talk, and it works out what is worth keeping as it goes — quietly, in the conversation, without interrupting you to ask."
    />
  );
}

/** Provenance. This is the section that justifies the product being different. */
function TheBook() {
  return (
    <Section
      label="The book"
      title="Every line shows where it came from."
      lead="Each memory carries its origin — who wrote it, when, from which conversation. The reply cites them, so a claim can be checked against the moment that produced it. And any of it can be taken back with one button: it stops being served, and the removal is written down rather than quietly done."
    />
  );
}

/**
 * Notifications.
 *
 * The example here is real output, not a mockup. It is the thing the product
 * actually says, and showing the output is a faster explanation of the product
 * than any paragraph about the product.
 */
function TheNudge() {
  return (
    <Section
      label="It nudges"
      title="It speaks in sentences, not badges."
      lead="No red dots. It tells you the thing, in a sentence, at a moment when it is still useful."
    >
      <div className="max-w-[34rem] rounded-xl bg-panel p-5">
        <p className="text-[11px] tracking-wider text-faint uppercase">Today</p>
        <p className="mt-3 text-[14.5px] leading-7 text-text">
          Maya&rsquo;s birthday is on the 14th — tomorrow. You have not sent anything.
        </p>
        <p className="mt-3 text-[11.5px] text-faint">Kept since March, from a conversation on the 2nd.</p>
      </div>
    </Section>
  );
}

/** Ownership. Honest about what leaving means. */
function Yours() {
  return (
    <Section
      label="Ownership"
      title="It lives in your account, and you can take it back."
      lead="The account is yours on Sui, not an account you have an account in. Signing in gives this app a scoped key to it, and that key can be removed in one transaction — after which the account goes quiet, immediately, with nothing left here to switch off."
    />
  );
}

/** The CTA again, below the fold. Same action, same weight. */
function ClosingCta({ onSignIn }: { onSignIn: () => void }) {
  return (
    <section className="py-24 text-center sm:py-32">
      <h2 className="mx-auto max-w-[20ch] text-[1.7rem] leading-[1.15] font-bold tracking-tight text-text sm:text-[2.2rem]">
        Start talking to it.
      </h2>
      <p className="mx-auto mt-4 max-w-[44ch] text-[14.5px] leading-7 text-muted">
        It takes a wallet and about a minute. Everything it holds stays yours, and
        the key it uses can be pulled back the moment you want it gone.
      </p>
      <div className="mt-8 flex justify-center">
        <button type="button" onClick={onSignIn} className={CTA}>
          Sign in with a Sui wallet
        </button>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mt-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div className="flex items-center gap-2.5">
          <Mark className="h-4 w-4 text-accent" />
          <span className="text-[12.5px] text-muted">People Book</span>
        </div>
        <p className="text-[11.5px] text-faint">
          Memories on Sui and Walrus. Keys with you.
        </p>
      </div>
    </footer>
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
