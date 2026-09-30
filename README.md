# People Book

**A private assistant that remembers everyone in your life, you included, and comes to you instead of waiting to be asked.**

It opens with what is actually due — approaching dates, promises you have not
kept, people who have gone quiet, and your own follow-through record. It never
asserts anything it cannot show you. And the memory is yours: you own the onchain
account, and you can revoke this app in one transaction.

Built for [Walrus Sessions 8: Chatbots That Remember](https://thewalrussessions.wal.app/chatbots/index.html).

| | |
|---|---|
| **Memory is load-bearing** | Every nudge is a recall. Turn memory off and there is no product left — that is the before/after, in one toggle. |
| **It cannot make a claim it can't prove** | Unconfirmed extractions are structurally incapable of reaching you as a statement about your life. |
| **It tells you when it holds something back** | Suppressed topics are announced with the date the rule was set, not silently dropped. |
| **You own the account** | You sign the transactions. The app holds a scoped, onchain-revocable delegate key and nothing else. |
| **Cannot touch your other memory** | One forced namespace. No route can name another, and the store throws if asked to. |
| **Verified on mainnet** | 72 blobs written, recalled, ranked and forgotten against the production relayer. |

---

## Verified against production, not mocked

`npm run live:check` runs the whole path against the real relayer on Sui mainnet:
it writes the demo cast, reads it back through vector search, runs the ranking
engine over what came back, forgets a memory, and confirms it stops surfacing.

```
$ npm run live:check
relayer reachable                       ok
wrote all 25 memories                   ok      72 blobs on the account
recalled 70 live memories               ok      coverage: complete
every memory kept its claim text        ok
typed fields survived the round trip    ok
the real book produces nudges           ok
nudges never source from unconfirmed    ok
Ravi's taboo is announced               ok
the divorce never appears in a nudge    ok
the forgotten memory is gone            ok
and it no longer produces a nudge       ok
```

It is also how two numbers in this README were found rather than guessed: a
mainnet write takes **~45s** (seal, embed, upload), not the 25s the timeout
originally assumed, and the first `recall` after a write takes **22.6s** against
a 3.5s warm baseline while the index catches up. Both were measured, and both had
been quietly breaking the read path until they were.

The live check is also what caught three bugs the unit tests could not — the
follow-through nudge being crowded out of the display set, a fully suppressed
nudge rendering as a blank card, and elisions being announced only for people who
survived into the result, which silenced the announcement precisely when it
mattered most. Details in the commit history.

---

## The two ideas this is actually about

Most memory demos add a database and call it memory. The two things that make
this different are both refusals.

### 1. It cites, it never claims

Every memory carries a confidence level, and the difference is structural rather
than cosmetic:

```
model output  →  candidate  →  you confirm  →  confirmed  →  can nudge
                            └─ left alone ─→  inferred   →  never nudges
```

An `inferred` memory is fully visible in the ledger and **incapable of reaching
you as a claim**. It is not a warning label; the initiation engine filters on it
before anything is phrased. So the worst case of a bad extraction is a card you
can delete, rather than a false statement about your sister.

Every nudge is a pointer, not a claim. It links to the memory it came from, shows
that memory's text and date, and you can forget it from the nudge itself.

### 2. It tells you when it is holding something back

Give the book a rule — *"never mention the divorce to Ravi"* — and it will not
bring that up, and it will say so:

> ◑ Not mentioning the thing you told me not to mention about Ravi, set on 2026-04-02.

The alternative is silent omission, which reads as the assistant ignoring you and
gives you no way to tell an honoured rule from a forgotten one. Naming the person,
the rule and the date turns a quiet gap into a checkable claim about the
assistant's own restraint.

The same honesty applies to the follow-through nudge — *"you have told Sam you
would do something 4 times and confirmed it never"* — which is deliberately
scored **below every practical reminder**, so the most uncomfortable thing the
product says is never the loudest thing it says.

---

## How it works

```
Sui wallet  →  sign a single-use challenge  →  httpOnly session (address verified)
                    ↓
        create_account          ← owner-signed
        add_delegate_key        ← owner-signed, scoped to that one account
                    ↓
   Walrus Memory, namespace `book`, inside the USER's own account
                    ↓
   typed memories: person · type · status · confidence · dates · rev
                    ↓
   deterministic ranking → dates · promises · absence · open loops · follow-through
                    ↓
   taboo filter last → elide, then announce
                    ↓
   Groq gpt-oss-120b rephrases — optional, see "The LLM does not decide anything"
```

### The LLM does not decide anything

`api/lib/ranking.ts` has no model import. It decides *what* surfaces, using rules
that are inspectable and fully covered by assertions you can run with no network,
no key and no wallet — 70 for the codec, 59 for the ranking, 129 in total:

```bash
npm run verify
```

The model only rewrites the wording of a sentence that was already determined. If
Groq is unreachable, `phraseNudges()` falls back to the deterministic phrasing.
Losing the API key costs you the prose, not the product — which matters, because
a memory feature that dies when a vendor has a bad afternoon is decorative.

Capture is likewise extract-only: the model proposes, a person disposes. Nothing
it produces is written without someone confirming it, and a candidate naming
anyone not already in the book is dropped before it can be shown.

### Memory is the user's, provably

MemWal scopes every read and write to `owner + namespace + app id`. Rather than
holding one key and namespacing per user — which would make this app the
custodian of every book it holds — the user runs the setup:

**This app cannot read memory that is not its own.** A Walrus account can hold
many namespaces, and a user connecting their wallet may already have memories
there from other apps or their own use. So every read and write is confined to
one forced namespace, `book`, and that name is the boundary:

- no route accepts a namespace from the request — the store is constructed in
  exactly one place, from a constant
- the store throws on any namespace other than `book` or `book-*`, at
  construction, so a bad refactor fails loudly instead of quietly reading the
  wrong data. `bookshop` and `notebook` are refused too
- verified against the real foreign namespace names that exist in the account
  this was developed against, plus near-misses like `bookshop` and
  `x-book`, in `npm run verify:isolation`

```bash
$ npm run verify:isolation
refuses "nue-memory"                    ok
refuses "thesaintszn@gmail.com"         ok
refuses "bookshop"                      ok
refuses "notebook"                       ok
store refuses "nue-memory" at construction   ok
the store is constructed in exactly one place  ok
all checks passed — this app cannot read memory that is not its own
```

1. `create_account` — the account is owned by **their** address
2. `add_delegate_key` — **they** register this app's public key, owner-only
3. The app can act only inside that account
4. They can `remove_delegate_key` at any time and the app loses access
   immediately, without our cooperation

Step 4 is the demo. **Revoke us and watch** — remove the key on Sui and the
writes start failing, because the enforcement is on chain and not in our
codebase. The app never holds a key capable of creating an account or granting
itself access to one.

Identity comes from a signed challenge, verified offline against the exact
address. `ConnectButton` alone is a claim, not a proof — anyone can POST any
address — so the signature has to check out before a session exists.

---

## Running it

Requires Node 20+. No Vercel account needed for local development: the same Hono
app runs as a local Node server and as a serverless function.

```bash
npm install
cp .env.example .env

npm run keygen        # prints MEMWAL_DELEGATE_KEY — put it in .env
openssl rand -hex 32  # -> SESSION_SECRET
# add GROQ_API_KEY from https://console.groq.com

npm run verify         # codec + ranking assertions, no network needed
npm run dev            # api on :8787, ui on :5173
```

Then: connect a Sui wallet, sign the challenge, create your Walrus Memory
account, grant the delegate key. `/api/health` shows exactly what is missing and
verifies the live deployment.

```bash
npm run check:registry <accountRegistryId>   # confirm a registry matches the relayer
```

### Why the deployment is not hardcoded

The published MemWal docs list mainnet package and registry ids that the
production relayer does not serve
([MystenLabs/MemWal#1032](https://github.com/MystenLabs/MemWal/issues/1032)).
Accounts created against them 401 on every write. So `packageId` is read from the
relayer's `/config` at runtime, and the registry is verified **on chain** by
checking which package published it — string-comparing a package id against a
registry id would prove nothing, since they are different values by nature.

---

## Where the edges are

Each of these is a boundary we chose or inherited, stated precisely so you can
judge the thing on what it actually does.

**The account is yours; the model provider still sees the prompt.** Walrus stores
decentralized ciphertext and the account is revocable onchain — that part is
solid. But building a prompt means the server decrypts the memories in it, so
whatever reaches the LLM is visible to them. That boundary is inherent to hosted
inference, not a gap in the design, and it is the one part of this that is a
provider relationship rather than a design decision. Swapping `api/lib/capture.ts`
onto a local model is the whole fix — the prompt assembly, the ranking and the
storage are all provider-agnostic already.

**The ledger shows you its own coverage.** MemWal is a vector store with no
"list all memories" call, so the ledger is assembled by fanning out broad
queries and unioning the hits — which is a real ceiling that scales with book
size. Rather than present a partial view as a complete one, the UI shows the
relayer's own `memory_count` beside the list and says so when the two disagree.
The number is always checkable against the account.

**Forgetting is verifiable, not yet erasure.** MemWal ships no delete, so forget
writes a tombstone and reads filter it out — the memory is inert and unreachable
but the original blob remains on immutable storage. Client-side SEAL
(`MemWalManual`) makes forgetting real deletion, because destroying the key makes
every blob permanently undecryptable. It is the first item on the roadmap.

**The most sensitive entries are about people who never agreed to be in the
book.** No cryptography changes that, and most memory products do not mention
it. The position here is explicit: store only what a good friend would know,
never expose the book to anyone, make export and destruction real, and keep raw
utterances off by default because they are the most sensitive thing we hold. The
demo cast is fictional for the same reason — a submission you can open must not
publish real details about real people.

**Sign-in is a self-custodial transaction.** Creating your account and granting
this app access are both signed by your wallet, so a new user needs a little SUI
for gas. That friction is the cost of not being able to hold your memory for you.
Removing it means Google login and gasless transactions, which needs Enoki.

## What is next

Each item removes a limitation named in the section above, ordered by how much
it matters rather than by how easy it is.

1. **Client-side key derivation with a user-held salt.** Google login, no wallet,
   no gas — and revocation stays real, because the server never sees the salt and
   therefore cannot re-derive you. Explicitly *not* the pattern in Kibo
   (`zap/frontend/src/lib/wallet.ts`), which derives an Ed25519 keypair from
   `SHA-256(sub + server-held salt)` and so lets the server regenerate any user's
   private key, making revocation theatre. Needs Enoki for sponsored
   transactions.

2. **zkLogin.** A second login path that owns its own account. The account model
   is identical, so this is an addition rather than a rewrite. Requires Enoki
   mainnet proving ($120/mo, allowlisted) or a self-hosted Groth16 prover
   (~16 cores / 16 GB).

3. **`MemWalManual` + local SEAL.** The client encrypts before upload, so the
   relayer only ever sees ciphertext, and destroying the key makes every blob
   permanently undecryptable — which turns verifiable forgetting into real
   erasure. Enoki gates Seal too.

4. **Contradiction surfacing.** Today a newer fact wins by recency at ranking
   time. The better behaviour is to notice two memories that conflict and ask
   which is current, rather than quietly picking one.

---

## Credits

Built on [Walrus Memory](https://memory.walrus.xyz) by Mysten Labs, Sui, and Groq
for the LLM. Groq is deliberately not a Claude or GPT model, which also makes it
eligible for the session's "Beyond the Big Two" prize.

Embeddings are the relayer's job: MemWal's default client hands text to the
relayer, which embeds it before storing. So there is no second model provider to
configure, no embedding key to leak, and one fewer party that ever sees your
memory. If you ever want embeddings computed client-side instead,
`MemWalManual` supports it — but the default needs nothing from you.
