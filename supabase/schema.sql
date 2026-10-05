-- People Book profile store — run in the Neon SQL Editor.
--
-- Why a table for three fields: reading them from MemWal costs a full
-- eight-recall enumerate every time, for data that changes rarely and is read
-- on nearly every screen. This table is the fast read path. MemWal keeps a
-- mirrored copy (the existing profile_* memories) as the on-chain record, so a
-- database failure degrades to slow reads rather than lost profiles.
--
-- Keyed by lowercase wallet address. One row per wallet, upserted on save.
-- A missing row is not an error: it means "never set", and reads fall back to
-- MemWal, then populate this table on the way back (self-migrating).

create table if not exists profiles (
  address text primary key,
  name text,
  pronouns text,
  timezone text,
  memwal_account_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep updated_at honest without application code remembering to.
create or replace function profiles_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists profiles_touch on profiles;
create trigger profiles_touch
  before update on profiles
  for each row execute function profiles_touch_updated_at();

-- Locked down: the server connects with full credentials and the browser never
-- sees them, so no application role needs access. RLS stays enabled as defense
-- in depth with no permissive policies.
alter table profiles enable row level security;
