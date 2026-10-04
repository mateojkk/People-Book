# Move the delegate key out of the server

## Why

The server currently signs every memory write with one shared key read from
`MEMWAL_DELEGATE_KEY` (`api/_lib/memwal.ts:105`). That key is registered into
*every* account that connects, so it holds standing authority over all of them
simultaneously. If the server is ever compromised, one key reaches every account.

That is also the shape a wallet security scanner reads as a drainer: a key that
outlives the session and keeps acting for you afterwards, held by a server. Slush
flagged the deployed site as "malicious behavior" and it has to be clicked past
before a wallet will connect. That warning is a demo-killer on Oct 9.

**Constraint, stated by Mateo: servers do not hold keys. Writes go from the user's
browser to MemWal.**

## The decision

Option A — the model already built in `vela/frontend/src/hooks/useMemWal.ts:83`.

A delegate key is still worth having, for one reason only: a single chat turn can
produce a memory write, and asking the wallet to sign each one would make the app
unusable. So the user grants *once*, and writes are signed silently after that.

The difference from Vela's shape is only **where the key lives and who signs**:

| | Vela (correct) | People Book now (wrong) |
|---|---|---|
| Keypair generated | browser, per user | once, by `npm run keygen` |
| Key stored | user's `localStorage` | server `.env` |
| Who signs writes | the browser | the server |
| Server role | reads only | reads **and writes** |
| Blast radius if server compromised | none — no key to abuse | every account, forever |

## Why not the Sui primitives

Sui's documented mechanism for delegated signing is address aliases
(`0x2::address_alias`). Mysten's own warning rules it out here:

> All aliases for a given address have the ability to unilaterally control or take
> all coins, balances, and other resources owned by the address.

That grants full control of the user's Sui assets. A delegate key scoped to
MemWal writes in one account is strictly narrower. Aliases would be a downgrade in
security and would read worse to a scanner, not better.

## The change

1. Port `getOrCreateDelegate` into `src/lib/` — generate an Ed25519 keypair in the
   browser, key it by address, persist to `localStorage` under a namespaced key.
2. Register it once as a delegate on the user's `MemWalAccount`, wallet-signed.
   This is the only wallet prompt, and it is the one Slush will look at.
3. Move the write path to the client, signed with that browser-held key.
4. Server keeps reads only. Delete `api/_lib/memwal.ts`'s write client.
5. Delete `MEMWAL_DELEGATE_KEY` / `MEMWAL_PRIVATE_KEY` from `.env`, `.env.example`,
   `api/_lib/memwal.ts:105`, `api/_lib/account.ts:214-228`, and the `delegate`
   flag at `api/[[...route]].ts:158`.
6. Retire `npm run keygen`.
7. `/api/health` drops `config.delegate`; `scripts/verify-deploy.mjs` drops its
   matching check.

## Before starting: find the writes that have no wallet

Do this first, because it decides the scope. Anything the server writes on a timer
with no wallet connected has to become read-only or client-queued, and finding that
list before touching anything is cheaper than finding it afterwards.

Audit for server-side writes with no user session:

- proactive opening messages
- notification / nudge generation
- anything scheduled rather than user-triggered

Reads are fine and stay put. The relayer is only queried; no key is involved.

## Known uncertainty

It is not guaranteed this clears the Slush warning. The wallet still signs the
one-time on-chain `add_delegate_key`, so the transaction itself looks similar. What
differs is that the key belongs to the user's browser instead of to a server. Vela
ran this shape without being flagged, which is decent evidence but not proof — Vela
also had an established domain.

If it still warns after this, the remaining lever is the appeal ("Flag for review"),
not the architecture. Do not re-add a server key to quiet a scanner.

## Local dev note

Both dev servers were left running: web on `:5173`, api on `:8787`. The API is
`tsx`, which does not hot-reload server routes — restart it after any change under
`api/`.
