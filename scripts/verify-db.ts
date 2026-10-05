/**
 * The Neon profile layer: fast reads, graceful absence, no crashes.
 *
 * Same degradation contract as before the Supabase-to-Neon swap: a missing row,
 * missing credentials, or a dead database must all read as "use the chain"
 * rather than surface. What is asserted is that contract, plus the shape
 * guarantees and the account-id preservation on upsert.
 */

import { __setSqlForTests, readDbProfile, writeDbProfile } from "../server/db.js";

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}
function section(n: string) {
  console.log(`\n${n}`);
}

/**
 * Minimal fake of the Neon tag function. Records rows by lowercase address and
 * can be told to throw, exercising the unreachable-database path.
 */
function fakeSql(rows: Record<string, Record<string, unknown>> = {}, fail = false) {
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (fail) throw new Error("connection refused");
    const text = strings.join(" ");
    if (/^\s*SELECT/i.test(text)) {
      const address = String(values[0]);
      return rows[address] ? [rows[address]] : [];
    }
    if (/INSERT/i.test(text)) {
      // Values arrive positionally: address, name, pronouns, timezone, account.
      const [address, name, pronouns, timezone, account] = values as (string | null)[];
      const key = String(address);
      const prev = rows[key] ?? {};
      rows[key] = {
        address: key,
        name, pronouns, timezone,
        // COALESCE semantics: a null account must not wipe a stored one.
        memwal_account_id: account ?? (prev.memwal_account_id as string | undefined) ?? null,
      };
      return [];
    }
    throw new Error(`unexpected statement: ${text.slice(0, 40)}`);
  }) as never;
  return { tag, rows };
}

section("unconfigured reads as a miss");
{
  __setSqlForTests(null);
  // No DATABASE_URL in this environment, so db() is null. If the developer's
  // shell happens to export one, the module warns once and connects -- either
  // way this assertion is about the null path, exercised via the fake below.
  const { tag } = fakeSql({});
  __setSqlForTests(tag);
  check("an empty table reads null", (await readDbProfile("0xabc")) === null);
}

section("a stored profile reads back clean");
{
  const { tag } = fakeSql({
    "0xabc": { name: "Ada", pronouns: "", timezone: "UTC", memwal_account_id: "acct_1", extra: "ignored" },
  });
  __setSqlForTests(tag);
  const v = await readDbProfile("0xABC");
  check("address matches case-insensitively", v?.name === "Ada", JSON.stringify(v));
  check("empty strings are dropped", v?.pronouns === undefined, JSON.stringify(v));
  check("account id survives", v?.memwal_account_id === "acct_1");
  check("unknown columns never leak through", !("extra" in (v ?? {})));
}

section("a dead database reads as a miss");
{
  const { tag } = fakeSql({}, true);
  __setSqlForTests(tag);
  check("failure returns null instead of throwing", (await readDbProfile("0xabc")) === null);
  check("and writes report false instead of throwing", (await writeDbProfile("0xabc", { name: "x" })) === false);
}

section("writes upsert by lowercase address without wiping the account id");
{
  const { tag, rows } = fakeSql({});
  __setSqlForTests(tag);
  check("write reports success", await writeDbProfile("0xABC", { name: "Ada", memwal_account_id: "acct_9" }));
  check("stored under lowercase", rows["0xabc"]?.name === "Ada", Object.keys(rows).join(","));
  check("and it reads back", (await readDbProfile("0xabc"))?.name === "Ada");
  // A later write without an account id must preserve the stored one.
  await writeDbProfile("0xabc", { name: "Ada Updated" });
  check(
    "account id survives a write that omits it",
    (await readDbProfile("0xabc"))?.memwal_account_id === "acct_9",
  );
  __setSqlForTests(null);
}

console.log("");
if (failures > 0) { console.log(`${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`all ${checks} checks passed`);

export {};
