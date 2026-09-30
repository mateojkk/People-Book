/**
 * The address → Walrus Memory account mapping.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A MemWalAccount is a SHARED object, so it cannot be enumerated from its owner:
 * `listOwnedObjects` does not return shared objects, confirmed against a real
 * address with 50 owned objects and zero accounts. So once a user's account id is
 * known it has to be stored somewhere, or every session asks for it again — and a
 * hard refresh, a new browser, or a new device all lose it.
 *
 * This is the same model vela uses (a `memwal_account_id` column on the user).
 *
 * ── What is deliberately NOT stored here ─────────────────────────────────────
 * No memory content, no people, no claims, no keys. One row: an address and the
 * id of an account that address already owns. The book itself lives in the
 * user's own Walrus Memory account, encrypted, revocable, and readable by nobody
 * else. Deleting every row here loses nothing but the convenience of finding an
 * account the user can always re-supply.
 *
 * ── Degradation ──────────────────────────────────────────────────────────────
 * If Supabase is not configured, everything still works: the session cookie
 * carries the account id, which covers one browser. This is an improvement, not
 * a dependency, so a missing key must never take the app down.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null | undefined;

export function db(): SupabaseClient | null {
  if (cached !== undefined) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) {
    cached = null;
    return cached;
  }
  try {
    cached = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-application-name": "people-book" } },
    });
  } catch {
    cached = null;
  }
  return cached;
}

export function dbConfigured(): boolean {
  return db() !== null;
}

const TABLE = "people_book_accounts";

/** The account id recorded for an address, or null. */
export async function lookupAccountId(address: string): Promise<string | null> {
  const client = db();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from(TABLE)
      .select("account_id")
      .eq("address", address.toLowerCase())
      .maybeSingle();
    if (error) throw new Error(error.message);
    const value = (data as { account_id?: string } | null)?.account_id;
    return typeof value === "string" && value ? value : null;
  } catch {
    // A database problem must never block a sign-in; the cookie is the fallback.
    return null;
  }
}

/**
 * Records (or corrects) the mapping for an address.
 *
 * Upserted on the address, so re-claiming the same account is idempotent and a
 * user who somehow ends up with a new account can update it.
 */
export async function recordAccountId(address: string, accountId: string): Promise<boolean> {
  const client = db();
  if (!client) return false;
  try {
    const { error } = await client.from(TABLE).upsert(
      {
        address: address.toLowerCase(),
        account_id: accountId.toLowerCase(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "address" },
    );
    if (error) throw new Error(error.message);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops a user's mapping, which is what "sign out everywhere" would do.
 *
 * Exposed because it is the thing that makes this table harmless to hold: the
 * user can erase their row without touching a single memory, and their memories
 * are unaffected either way.
 */
export async function forgetAccountId(address: string): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    await client.from(TABLE).delete().eq("address", address.toLowerCase());
  } catch {
    // Best effort.
  }
}