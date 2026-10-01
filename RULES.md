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

## 12. Do not describe work you cannot see

Not one visual change in this project has been looked at by the person who wrote
it. Saying a design "looks right" is a claim about something unobserved.

- Say what was changed and what was verified. Let the other pair of eyes judge.
- Build and typecheck before claiming, every time, including for a one-line edit.

## 13. Never overlap the chrome

The "Jump to latest" button was pulled up with a negative margin so it would sit
over the composer. Two bordered boxes on top of each other, which looks exactly
like an input inside an input — and it was reported as a rendering bug, because to
the person looking at it that is what it was.

- Chrome goes in flow. A negative margin that saves twelve pixels is not worth
  the ambiguity.
- If a layout can be read as broken, it is broken, whatever the CSS intends.

## 14. The dependency list is a claim

Unused dependencies were removed once and the list still drifted. Every package
added has to be used by something in `src/` or it comes out.

---

## The one above the others

Everything here is a variation of it: **the gap between what was verified and
what was said.** A 404 described as working. A palette described as matching. A
copy line described as right. A model described as deterministic.

Say what was checked. Say plainly what was not.