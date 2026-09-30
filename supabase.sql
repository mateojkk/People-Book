-- People Book: the address → Walrus Memory account mapping.
--
-- One row per user. Nothing else is stored here: no memory content, no people,
-- no claims, no keys. The book itself lives in the user's own Walrus Memory
-- account on Sui, encrypted and revocable, and this table only remembers which
-- of their accounts to look in. Deleting every row loses no memories.
--
-- Run this in the Supabase SQL editor once.

create table if not exists public.people_book_accounts (
  -- The user's Sui address, lowercased. Sui addresses are case-insensitive and
  -- are normalised everywhere in this app, so the key is normalised here too.
  address      text primary key,

  -- Object id of the user's own MemWalAccount. Shared Sui object, so it cannot
  -- be looked up from the owner and therefore has to be remembered.
  account_id   text not null,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint people_book_accounts_address_is_object_id
    check (address ~ '^0x[0-9a-f]{64}$'),
  constraint people_book_accounts_account_id_is_object_id
    check (account_id ~ '^0x[0-9a-f]{64}$')
);

comment on table public.people_book_accounts is
  'Address to Walrus Memory account mapping. Contains no memory content.';

-- Row level security.
--
-- The API talks to this table with a service key and never exposes it to the
-- browser, so anon access is denied outright. If the table is ever read from a
-- client, the policy below still blocks it: a browser never has a business
-- reading someone else's account mapping.
alter table public.people_book_accounts enable row level security;

-- No policies are created on purpose. With RLS enabled and no policy, every
-- role is denied, which is the correct state for a service-key-only table.