# People Book

**A private assistant that remembers everyone in your life, you included, and comes to you instead of waiting to be asked.**

It opens with what is actually due — approaching dates, promises you have not
kept, people who have gone quiet, and your own follow-through record. It never
asserts anything it cannot show you. And the memory is yours: you own the onchain
account, and you can revoke this app in one transaction.

Built for [Walrus Sessions 8: Chatbots That Remember](https://thewalrussessions.wal.app/chatbots/index.html).

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
gives you no way to tell a honoured rule from a forgotten one. Naming the person,
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
   Walrus Memory, namespace `peoplebook`, inside the USER's own account
                    ↓
   typed memories: person · type · status · confidence · dates · rev
                    ↓
   deterministic ranking → dates · promises · absence · open loops · follow-through
                    ↓
   taboo filter last → elide, then announce
                    ↓
   Groq gpt-oss-120b rephrases (optional — see "No LLM in the decision path")
```

### The LLM does not decide anything

`api/lib/ranking.ts` has no model import. It decides *what* surfaces, using rules
that are inspectable, and it is covered by 55 assertions you can run with no
network, no key and no wallet:

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

## Honest limitations

This is a small app built in four days. These are the real edges, not a
decoration of modesty.

**Storage is private; inference is not.** Walrus is decentralized ciphertext and
the account is yours, but the server must decrypt memories to build a prompt for
Groq. So the LLM provider sees the memories that reach the prompt. In four days
on no budget, there is no way around that short of running the model client-side,
and pretending otherwise would be the exact kind of claim this project is trying
to avoid. A local model would fix it and is a config change, not a rewrite.

**The ledger is a partial view.** MemWal has no "list all memories" call — it is
a vector store, so `recall` is top-K semantic search only. The ledger is
assembled by fanning out several broad queries and unioning the results, deduped
by blob id. At a few hundred memories that is fine; at tens of thousands it is a
real coverage gap. The relayer's own `memory_count` is shown next to the list so
you can see when the view is partial instead of being told it is complete.

**Deleting a memory is a tombstone, not an erasure.** MemWal ships no delete, so
forget writes a new blob with the same id and `deleted: true`, and reads filter
it out. That makes it invisible and unusable, but the original blob is still on
immutable storage. True erasure needs the client-side SEAL path below.

**Third parties did not consent.** The most sensitive entries in this book are
about people who never agreed to be in it. No cryptography changes that. The
position taken here is: store only what a good friend would know, never expose
the book to anyone else, make export and destruction real, and say so out loud.
The demo cast is fictional for the same reason — a submission someone can open
must not publish real details about real people.

**Sign-in costs a little gas.** Creating the account is a Sui transaction, so a
new user needs SUI. See the roadmap below.

---

## Roadmap after the hackathon

Ordered by what actually removes a limitation above, not by what is easiest.

1. **Client-side key derivation with a user-held salt.** Google login, no wallet,
   no gas, and revocation stays real because the server never sees the salt.
   Explicitly *not* the pattern in Kibo (`zap/frontend/src/lib/wallet.ts`): that
   derives an Ed25519 keypair from `SHA-256(sub + server-held salt)`, so the
   server can re-derive any user's private key and revocation becomes theatre.
   Deriving client-side from a salt the user holds keeps the guarantee. Needs
   Enoki for sponsored transactions.

2. **zkLogin.** A second login path that owns its own account. The account model
   is identical, so this is an addition rather than a rewrite. Requires Enoki
   mainnet proving ($120/mo, allowlisted) or a self-hosted Groth16 prover
   (~16 cores / 16 GB).

3. **`MemWalManual` + local SEAL.** The client encrypts before upload, so the
   relayer only ever sees ciphertext, and destroying the key makes every blob
   permanently undecryptable. That turns "deletion is a tombstone" above into
   real erasure. Enoki gates Seal too.

4. **Contradiction surfacing.** Today a newer fact wins by recency at ranking
   time. The better behaviour is to notice two memories that conflict and ask
   which is current, rather than quietly picking one.

---

## Layout

```
api/[[...route]].ts      Hono routes (all take identity from the session only)
api/lib/account.ts       deployment resolution + onchain registry verification
api/lib/memwal.ts        client per account, honest write retry
api/lib/session.ts       single-use challenge, HMAC httpOnly cookie
api/lib/store.ts         typed CRUD, tombstone forget, fan-out enumeration
api/lib/ranking.ts       the initiation engine. no model. the whole thesis.
api/lib/capture.ts       extract-only capture, optional rephrasing
shared/types.ts          the contract both sides agree on
shared/memory-codec.ts   claim-text-first serialisation, rev-based collapse
shared/demo-cast.ts      25 memories about six invented people
scripts/verify-*.ts      the assertions. runnable with no network.
```

---

## Credits

Built on [Walrus Memory](https://memory.walrus.xyz) by Mysten Labs, Sui, Groq and
Google Gemini for embeddings. Groq is deliberately not a Claude or GPT model,
which also makes it eligible for the session's "Beyond the Big Two" prize.
