/**
 * Profile reads and writes against Neon Postgres, with MemWal as the fallback.
 *
 * ── Why two stores ────────────────────────────────────────────────────────────
 *
 * Reading three profile fields from MemWal costs a full eight-recall enumerate:
 * embedding search, download, decrypt, for data that changes rarely and is read
 * on nearly every screen. This table answers in milliseconds.
 *
 * MemWal keeps a mirrored copy (the profile_* memories) as the on-chain record.
 * That is not redundancy for its own sake: if the database is unreachable, reads
 * fall back to MemWal and the profile still loads, slowly rather than never.
 * And if the table is ever lost, every profile can be rebuilt from the chain.
 * Either store alone is sufficient; together they are fast *and* user-owned.
 *
 * ── Consistency ───────────────────────────────────────────────────────────────
 *
 * Writes go to Neon first, then MemWal. Reads come from Neon, falling back to
 * MemWal on miss or failure and populating Neon on the way back, so the first
 * read after this ships self-migrates every existing profile with no backfill
 * script and no user action.
 *
 * A missing row is "never set", not an error. An unreachable database is
 * "read from the chain instead", not an outage.
 *
 * ── Driver ────────────────────────────────────────────────────────────────────
 *
 * @neondatabase/serverless over HTTP, not a pg Pool. Serverless functions have
 * no persistent connections to pool, so a stateful client buys nothing and
 * costs cold-start time. Each call is one HTTPS round trip.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export interface DbProfile {
  name?: string;
  pronouns?: string;
  timezone?: string;
  memwal_account_id?: string;
}

type Sql = NeonQueryFunction<false, false>;

let sql: Sql | null = null;
let warnedMissing = false;

/** Null when DATABASE_URL is unset: every caller must handle that via MemWal. */
export function db(): Sql | null {
  if (sql) return sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn("[db] DATABASE_URL is not set; profile reads come from MemWal alone.");
    }
    return null;
  }
  sql = neon(url);
  return sql;
}

/** For tests: inject a fake. */
export function __setSqlForTests(s: Sql | null): void {
  sql = s;
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
  const q = db();
  if (!q) return null;
  try {
    const rows = (await q`
      SELECT name, pronouns, timezone, memwal_account_id
      FROM profiles WHERE address = ${address.toLowerCase()}
    `) as Record<string, unknown>[];
    if (!rows.length) return null;
    return clean(rows[0]!);
  } catch {
    // Unreachable database reads as a miss: the caller falls back to MemWal.
    return null;
  }
}

export async function writeDbProfile(address: string, profile: DbProfile): Promise<boolean> {
  const q = db();
  if (!q) return false;
  try {
    await q`
      INSERT INTO profiles (address, name, pronouns, timezone, memwal_account_id, updated_at)
      VALUES (
        ${address.toLowerCase()},
        ${profile.name ?? null},
        ${profile.pronouns ?? null},
        ${profile.timezone ?? null},
        ${profile.memwal_account_id ?? null},
        NOW()
      )
      ON CONFLICT (address) DO UPDATE SET
        name = EXCLUDED.name,
        pronouns = EXCLUDED.pronouns,
        timezone = EXCLUDED.timezone,
        memwal_account_id = COALESCE(EXCLUDED.memwal_account_id, profiles.memwal_account_id),
        updated_at = NOW()
    `;
    return true;
  } catch {
    return false;
  }
}
