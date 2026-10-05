/**
 * The enumeration cache has to know about writes.
 *
 * The bug: every write path forgot to drop the cached enumeration. The cache has
 * a 15 second TTL, so after writing, the next read returned a book that did not
 * contain what was just written. Saving your name wrote it correctly and then
 * read back the old value, so the field appeared not to save and you pressed Save
 * again.
 *
 * Nothing throws when this breaks. It looks like latency, which is why it got
 * reported as "saving takes forever" rather than as a stale read.
 */
import { PeopleBookStore } from "../shared/store.js";

let failures = 0;
let checks = 0;
function section(n: string) { console.log(`\n${n}`); }
function check(label: string, ok: boolean, detail = "") {
  checks++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

/**
 * A relayer that echoes what it was given back on recall, which is what makes
 * this test worth anything. A fake that returns nothing would make every
 * assertion below pass or fail for the wrong reason.
 */
function fakeClient() {
  const blobs = new Map<string, string>();
  let next = 0;
  return {
    blobs,
    recalls: 0,
    async rememberAndWait(text: string) {
      blobs.set(`blob-${next++}`, text);
      return {};
    },
    async listNamespaces() {
      return { namespaces: [] };
    },
    async recall() {
      this.recalls += 1;
      // The relayer returns everything in the namespace for every query; the
      // store dedupes by blob id, which is exactly what it is there to do.
      return { results: [...blobs].map(([blob_id, text]) => ({ blob_id, text })) };
    },
  };
}

function buildStore(client: any) {
  // createClient is the supported seam. This used to overwrite the store's private
  // get() accessor, which worked only because the test was willing to reach into
  // privates -- and it is the same coupling that let the store build its own client
  // from an env key in the first place.
  return new PeopleBookStore({
    accountId: "acct_test",
    namespace: "book",
    createClient: () => client,
  });
}

section("a write is visible to the very next read");
{
  const client = fakeClient();
  const store = buildStore(client) as any;

  const before = await store.listLive();
  check("the book starts empty", before.memories.length === 0, String(before.memories.length));

  await store.remember({ person: "you", type: "trait", text: "Prefers to be called Mateo.", confidence: "confirmed" });

  const after = await store.listLive();
  check("and contains it immediately after the write", after.memories.length === 1, `${after.memories.length} memories`);
  check("with the text that was written", after.memories[0]?.text === "Prefers to be called Mateo.", after.memories[0]?.text);
}

section("a revision is visible too");
{
  const client = fakeClient();
  const store = buildStore(client) as any;

  const written = await store.remember({ person: "you", type: "trait", text: "Uses he/him pronouns.", confidence: "confirmed" });
  check("first read shows rev 1", (await store.getById(written.id))?.rev === 1);

  await store.revise(written, { text: "Uses they/them pronouns." });

  const seen = await store.getById(written.id);
  check("and the next read shows the revision", seen?.text === "Uses they/them pronouns.", seen?.text);
  check("at rev 2", seen?.rev === 2, String(seen?.rev));
  // One id, two blobs. collapseById is what keeps the old one from also appearing.
  check("still exactly one live memory", (await store.listLive()).memories.length === 1);
}

section("a forget is visible");
{
  const client = fakeClient();
  const store = buildStore(client) as any;
  const written = await store.remember({ person: "Maya", type: "trait", text: "vegetarian", confidence: "confirmed" });
  check("present", (await store.listLive()).memories.length === 1);
  await store.forget(written.id);
  check("gone after forgetting", (await store.listLive()).memories.length === 0, String((await store.listLive()).memories.length));
}

section("forgetting twice is success, not an error");
// getById used to read through listLive(), which filters tombstones. So a
// forgotten memory was unfindable, this guard was unreachable, and forgetting
// twice threw -- which is what a double-clicked Undo does.
{
  const client = fakeClient();
  const store = buildStore(client) as any;
  const written = await store.remember({ person: "Maya", type: "trait", text: "vegetarian", confidence: "confirmed" });

  await store.forget(written.id);
  check("gone from the ledger", (await store.listLive()).memories.length === 0);

  let threw = false;
  try {
    await store.forget(written.id);
  } catch (error: any) {
    threw = true;
    if (!/already gone/.test(String(error.message))) throw error;
  }
  check("forgetting again does not throw", !threw);
  check("and the tombstone is still readable by id", (await store.getById(written.id))?.deleted === true);
  check("while still hidden from the ledger", (await store.listLive()).memories.length === 0);
}

section("history shares the ledger's enumeration");
// listHistory used to call enumerate() directly, bypassing the in-flight dedupe
// that lives in listLive -- so a history request ran a second full enumeration
// alongside a ledger read instead of joining it.
{
  const client = fakeClient();
  const store = buildStore(client) as any;
  const written = await store.remember({ person: "Maya", type: "trait", text: "vegetarian", confidence: "confirmed" });
  await store.listLive();               // warm
  const before = client.recalls;
  await Promise.all([store.listLive(), store.listHistory(written.id), store.listLive()]);
  check("three concurrent reads cost one enumeration", client.recalls === before, `${client.recalls} vs ${before}`);
}

section("getById is cached, and still sees tombstones");
// Both matter, and taking one without the other was the bug. Reading through the
// cache hides tombstones; reading the raw worker to avoid that bypasses the cache
// and turns every lookup into a full relayer enumeration -- a task settle went to
// 9.4 seconds that way.
{
  const client = fakeClient();
  const store = buildStore(client) as any;
  const written = await store.remember({ person: "Maya", type: "trait", text: "vegetarian", confidence: "confirmed" });
  await store.listLive();               // warm the cache
  const before = client.recalls;
  await store.getById(written.id);
  await store.getById(written.id);
  await store.getById(written.id);
  check("three lookups cost no extra enumeration", client.recalls === before, `${client.recalls} vs ${before}`);

  await store.forget(written.id);
  check("and a tombstone is still findable afterwards", (await store.getById(written.id))?.deleted === true);
}

section("profile wrap and unwrap round-trip");
// The write wraps ("Is in the UTC timezone.") and the read must unwrap to the
// value ("UTC"). When these disagreed, the client received a sentence where it
// expected an IANA name: the dropdown matched nothing and saves round-tripped
// prose as if it were the zone. "Timezone never sticks" was this.
{
  const { profileClaim, profileUnwrap } = await import("../server/app.js");
  const cases = [
    ["name", "Ada"],
    ["pronouns", "she/her"],
    ["timezone", "UTC"],
    ["timezone", "America/New_York"],
  ] as const;
  for (const [slot, value] of cases) {
    const wrapped = profileClaim[slot](value);
    check(`${slot} unwraps to what was written`, profileUnwrap[slot](wrapped) === value, `${wrapped}`);
  }
  check("a non-matching sentence unwraps to undefined", profileUnwrap.timezone("UTC") === undefined);
  check("an empty string unwraps to undefined", profileUnwrap.name("") === undefined);
}

section("the cache is still a cache");
{
  // Invalidating on write must not mean re-enumerating on every read, or the fix
  // trades a correctness bug for a latency one.
  const client = fakeClient();
  const store = buildStore(client) as any;
  await store.remember({ person: "Maya", type: "trait", text: "vegetarian", confidence: "confirmed" });
  await store.listLive();
  const recallsAfterFirst = client.recalls;
  await store.listLive();
  await store.listLive();
  check("consecutive reads do not each hit the relayer", client.recalls === recallsAfterFirst, `${client.recalls} vs ${recallsAfterFirst}`);
}

console.log("");
if (failures > 0) { console.log(`${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`all ${checks} checks passed`);
