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
        <Questions />
        <ItTalks />
        <TheEvidence />
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
        className="max-w-[24ch] text-[2.4rem] leading-[1.05] font-bold tracking-tight text-text outline-none sm:text-[3.6rem]"
      >
        Ask it what happened.
      </h1>
      <p className="mt-6 max-w-[58ch] text-[15px] leading-7 text-muted">
        Who you spoke to last month and what you said. Why it changed with someone.
        What you promised and never did. What you keep saying. Every answer comes
        from your own history, and shows you the exact conversation it came from.
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
 * The questions.
 *
 * This section used to be three cards describing categories of memory, which is
 * the mechanism wearing a product's clothes. The product is the five questions,
 * so those are what the page lists.
 */
function Questions() {
  const items = [
    ["What happened with her?", "The actual sequence, and the conversation each point came from."],
    ["Why did it change with him?", "The turn itself, and the message where it turned."],
    ["What did I promise?", "Everything outstanding, and when you said it."],
    ["What do I keep saying?", "The same thing, more than once. You cannot see this yourself — it is worked out from your book."],
    ["What did we decide last time?", "The decision, cited to the turn it was made in."],
  ];
  return (
    <Section label="What you can ask" title="Five questions about your own life.">
      <ul className="max-w-[44rem] space-y-3.5">
        {items.map(([q, a]) => (
          <li key={q}>
            <p className="text-[13.5px] font-bold text-text">{q}</p>
            <p className="mt-1 text-[13px] leading-6 text-muted">{a}</p>
          </li>
        ))}
      </ul>
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

/**
 * Evidence.
 *
 * The one claim on this page that a generic chatbot cannot make, so it gets its
 * own section rather than being a footnote. A model asked "what is her birthday"
 * answers "the 16th" and cannot tell you where it got that. This one can.
 */
function TheEvidence() {
  return (
    <Section
      label="Where the answers come from"
      title="It shows you the conversation it used."
    >
      <div className="max-w-[36rem] rounded-xl bg-panel p-5">
        <p className="text-[11px] tracking-wider text-faint uppercase">Ask</p>
        <p className="mt-2.5 text-[14px] leading-7 text-text">When is her birthday?</p>
        <p className="mt-5 text-[11px] tracking-wider text-faint uppercase">Answer</p>
        <p className="mt-2.5 text-[14px] leading-7 text-text">
          The 16th. You told me the 14th on the 2nd of March and the 16th on the 9th
          of June. I can show you both.
        </p>
        <p className="mt-4 text-[11.5px] leading-5 text-faint">
          Nothing is overwritten, so when you changed your mind the old answer is
          still there.
        </p>
      </div>
    </Section>
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
