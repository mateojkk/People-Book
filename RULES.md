# RULES

Not a style guide. These are the rules this project has actually broken, written
down because they cost real time and will cost it again. Each one says what went
wrong, so the rule can be argued with rather than obeyed blindly.

---

## 1. Never claim it works before running it

A commit message described two endpoints as working. Neither was registered: the
edits meant to add them had silently not matched, every setup finished by POSTing
into a 404, and nothing failed loudly. The lie survived review because it was in
prose, and prose is not executed.

- Verify by running the thing, in the same session as the claim.
- If a test asserts a route exists, name it in the test. "The setup screen calls
  these" is the kind of claim that needs an assertion behind it.

## 2. Never build UI that pretends to be a control

There were three of them: a "Search" mode pill, a "Computer" pill, and a "Model"
selector. None did anything. They were props lifted from a screenshot of another
product, and their only function was to make the page look like that product.

- If a control does not control something, it does not belong on the page.
- A decorative affordance is a lie about what the app can do.

## 3. Never put words in the user's mouth

Suggested prompts, starter cards, and a "quick templates" menu that typed
half-finished sentences into the input. All removed.

The user knows what they came here to type. The app's job is to listen, not to
suggest. Any affordance that writes into the input or sends on the user's behalf
is out — including the version that only fills the box and waits.

## 4. Never copy another product's trade dress

The brief was to match a reference interface. What came back was that product
with different hex values, down to the eyebrow label and the card grid, and it
read unmistakably as a clone of a search engine.

- Copy the *structure* people already understand. Do not copy the *identity*.
- If the page reads as another product, the design is wrong, not the palette.
- Do not claim to have replicated something whose source cannot be inspected.

## 5. The empty state is the input, and nothing else

Three headings were written and three were rejected. The rule that survived:
**no headline, no explanation, no examples.** A centred composer.

Copy in the empty state reads as a landing page trying to sell the product. The
user already knows what they came for.

## 6. One accent, on grey-black

Near-black with a blue cast, not pure black. Depth from layering panels, not from
borders and shadows. Exactly one chromatic colour in the whole interface — a
light blue — reserved for what is live and for keyboard focus. Two accents means
neither one means anything.

## 7. Tokens are theme-neutral, and named for what they are

`ink` was the page background and `bright` was the text, which is backwards in
English and cost a rename. Names now read `base`, `panel`, `raised`, `rule`,
`text`, `muted`, `faint`, `accent`.

- Every colour is a token. No raw palette classes (`teal-500`), which is how a
  second theme escaped and left teal on a grey-black page.
- A palette change is a value swap in one block, never a sweep through components.

## 8. Never let a failure be silent

Without `GROQ_API_KEY` nothing is extracted and every reply falls back to "I'm
listening" — which looks exactly like a chatbot with nothing to say. A deployment
missing the key would have demoed a dead app and nobody would have known until a
judge typed into it.

- Missing configuration is stated on screen, not swallowed.
- A degraded path that *looks* like the healthy path is a bug, not a fallback.

## 9. Never claim determinism you do not have

Extraction is not reproducible. At temperature 0 the same sentence returned two
candidates on one call and one on the next. A code comment claimed otherwise.

- State precisely what is deterministic (ranking, eligibility, revision collapse)
  and what is not (anything a language model produced).
- Where it is not, the mitigation is undo. Undo is a real path, not a nicety.

## 10. Tests must not depend on someone else's good mood

Assertions of the form "the model returned something" fail whenever the provider
is slow, rate-limited, or briefly unreachable. Several did, here, from
rate-limiting caused by our own test runs.

- Test the *rule*, not whether a third party felt like participating.
- If a test needs the network, that is a fact to write down, not a surprise.

## 11. One key per project

This project's Groq key is shared with Nue. Same rate limit, so both get flaky
together, and rotating it in one silently breaks the other — which lands on rule 8.

- A secret is per-project. Document it in `.env` when it is borrowed.
- Never commit one. `.env` is ignored, and it stays that way.

## 12. Do not describe what you have not checked

Saying a design "looks right" without rendering it is a claim about something
unobserved, and it was made repeatedly here before it became possible to observe
anything at all. See rule 13 for the correction.

- Say what was changed and what was verified. Distinguish the two.
- Build and typecheck before claiming, every time, including for a one-line edit.

## 13. Look at it

I asserted for an entire session that I could not see the UI. I could: Chromium
via Playwright installs in about a minute, and every layout bug in this project
was then obvious in one screenshot -- an input nested inside an input, a rail
collapsed to unreadable glyphs, an empty composer 102px tall for a one-line input.

Build green, typecheck green, 300 assertions passing, and the page was still
wrong in three visible ways. None of those could be caught by reading the code,
because in the code they are correct.

- Anything visual gets looked at before it is described as finished.
- `npm run verify:ui` drives a real browser and asserts on what comes out.

## 14. Never overlap the chrome

The "Jump to latest" button was pulled up with a negative margin so it would sit
over the composer. Two bordered boxes on top of each other, which looks exactly
like an input inside an input — and it was reported as a rendering bug, because to
the person looking at it that is what it was.

- Chrome goes in flow. A negative margin that saves twelve pixels is not worth
  the ambiguity.
- If a layout can be read as broken, it is broken, whatever the CSS intends.

## 15. A destination is not a receipt

Three peer tabs — talk, today, the book — is a to-do app with a chat window, and
a manual "add a memory" form next to a conversation that already learns from what
you say is scaffolding for a product that no longer needs it.

- The conversation is where you live. Everything else is a receipt behind it.
- Reach an audit surface from the claim it backs up, not from the same row as the
  main thing. A citation you can follow is the point; a database tab is not.
- If a feature only makes sense while the product is worse, delete it.

## 16. Verify the artifact that deploys, not the one you are used to

`npm run build` runs vite, which builds the client. Vercel then deploys a second
artifact the build never touches: the API as a Node serverless function. So a
green build said nothing about half of what ships, and it did not typecheck
either -- a type error would have gone straight out.

- `build` now typechecks first, so a type error fails the deploy.
- `verify:build` bundles the function the way Vercel does, loads the bundle, and
  calls it. A dependency that only resolves in development fails there.
- A check that cannot fail is worse than no check. One was in the first draft of
  that script -- it read `&& false` and asserted nothing.

## 17. Never measure a third party through a broken request

I measured the model's recurring-date output as 0 out of 4 and concluded it never
emits the field. Some of those runs were HTTP 429s — the model was never asked.
The conclusion happened to be right, but the evidence was not, and I nearly shipped
a fix on the strength of a number that partly counted nothing.

- A measurement of someone else's behaviour must establish that they were
  actually reached. Check the status code before believing the result.
- Anything a prompt is supposed to change gets one deterministic implementation as
  well. Month arithmetic has to be exactly right eleven months before anyone finds
  out it is not, and a model that ignores an optional field is not a bug report,
  it is a fact about the model.

## 18. Borderless, and say so in the tokens

Forty-six elements were separated by a line. Surfaces step through the greys,
spacing does the grouping, and one accent marks whatever is live. Depth is
material, not outline. The only outlines left are focus rings, which are not
decoration.

- If it needs a border to be legible, the surface tint is wrong, not the border.
- Write the rule down where the palette is defined. A design language that lives
  only in someone's head gets re-litigated every session.

## 19. The dependency list is a claim

Unused dependencies were removed once and the list still drifted. Every package
added has to be used by something in `src/` or it comes out.

---

## 20. Never commit a binary asset. Link the URL.

Asked once directly, and worth writing down because the instinct is wrong. A
landing background video arrived as a 33MB CloudFront mp4 and the reflex was to
download it into `public/`, compress it, and commit it. Do not.

A 33MB video in the repository is bad for the clone, bad for the deploy bundle,
and bad for every future `git` operation, and none of that buys anything: the
file is already on a CDN with a stable URL. Reference the URL directly in the
markup. Compression is the CDN's job, not the repository's.

The general rule: **anything that is not source goes in `src/` as text. Fonts,
video, images, fixtures — link them, do not carry them.** The only binaries that
belong in the repo are the ones this project generates and must test against.

---

## 21. Decorative motion must never cost the reader their text

A background video behind the landing headline is allowed, with three conditions:
it is decorative, so it is `aria-hidden`; it is muted and `playsInline`, because
browsers refuse to autoplay otherwise; and it sits under an overlay strong enough
that the headline keeps its contrast against whatever the brightest frame is.

And honour `prefers-reduced-motion`. Someone who has asked their operating system
for less movement gets the static gradient, not the video.

---

## 22. Serve the dev server over TLS, and mark the cookie Secure

The session cookie was `Secure` only in production, purely so it would work over
plain http on localhost. That is a small convenience bought with two real
problems: the signed challenge and the cookie went out unencrypted on every dev
machine, and Sui wallets refused the origin with a "your connection is not secure"
warning. The warning reads like an attack, and it is not one -- but it trains
people to click past exactly that kind of prompt, which is the worst possible
outcome for a wallet app.

Localhost traffic never leaves the machine, so this was never exploitable in dev.
It was still wrong, because "harmless on my machine" is how the same shortcut
ends up on a staging host. The dev server now runs on TLS via
@vitejs/plugin-basic-ssl and `Secure` is unconditional. The browser asks once
about the self-signed cert; that is a fair price for an origin that is genuinely
secure afterwards.

---

## The one above the others

Everything here is a variation of it: **the gap between what was verified and
what was said.** A 404 described as working. A palette described as matching. A
copy line described as right. A model described as deterministic.

Say what was checked. Say plainly what was not.