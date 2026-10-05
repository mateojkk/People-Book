/**
 * Profile reads and writes against Supabase, with MemWal as the fallback.
 *
 * ── Why two stores ────────────────────────────────────────────────────────────
 *
 * Reading three profile fields from MemWal costs a full eight-recall enumerate:
 * embedding search, download, decrypt, for data that changes rarely and is read
 * on nearly every screen. This table answers in milliseconds.
 *
 * MemWal keeps a mirrored copy (the profile_* memories) as the on-chain record.
 * That is not redundancy for its own sake: if this database is unreachable, reads
 * fall back to MemWal and the profile still loads, slowly rather than never.
 * And if this database is ever lost, every profile can be rebuilt from the
 * chain. Either store alone is sufficient; together they are fast *and*
 * user-owned.
 *
 * ── Consistency ───────────────────────────────────────────────────────────────
 *
 * Writes go to Supabase first, then MemWal. Reads come from Supabase, falling
 * back to MemWal on miss or failure and populating Supabase on the way back, so
 * the first read after this ships self-migrates every existing profile with no
 * backfill script and no user action.
 *
 * A missing row is "never set", not an error. An unreachable database is
 * "read from the chain instead", not an outage.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface DbProfile {
  name?: string;
  pronouns?: string;
  timezone?: string;
  memwal_account_id?: string;
}

const TABLE = "profiles";

let client: SupabaseClient | null = null;

/** Null when unconfigured: every caller must handle that by using MemWal alone. */
export function db(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

/** For tests: inject a fake. */
export function __setClientForTests(c: SupabaseClient | null): void {
  client = c;
}

function clean(row: Record<string, unknown>): DbProfile {
  const out: DbProfile = {};
  if (typeof row.name === "string" && row.name) out.name = row.name;
  if (typeof row.pronouns === "string" && row.pronouns) out.pronouns = row.pronouns;
  if (typeof row.timezone === "string" && row.timezone) out.timezone = row.timezone;
  if (typeof row.memwal_account_id === "string" && row.memwal_account_id) {
    out.memwal_account_id = row.memwal_account_id;
  }
  return out;
}

export async function readDbProfile(address: string): Promise<DbProfile | null> {
  const c = db();
  if (!c) return null;
  try {
    const { data, error } = await c
      .from(TABLE)
      .select("name, pronouns, timezone, memwal_account_id")
      .eq("address", address.toLowerCase())
      .maybeSingle();
    if (error || !data) return null;
    return clean(data as Record<string, unknown>);
  } catch {
    // Unreachable database reads as a miss: the caller falls back to MemWal.
    return null;
  }
}

export async function writeDbProfile(
  address: string,
  profile: DbProfile,
): Promise<boolean> {
  const c = db();
  if (!c) return false;
  try {
    const { error } = await c.from(TABLE).upsert(
      {
        address: address.toLowerCase(),
        ...profile,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "address" },
    );
    return !error;
  } catch {
    return false;
  }
}
