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
import { PeopleBookStore } from "../api/lib/store.ts";

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
  // The store reaches its client through a private accessor; replacing it is the
  // only way to test this without a live relayer, and it is exactly the seam the
  // bug lived in.
  const store = new PeopleBookStore({ accountId: "acct_test", namespace: "book" });
  (store as unknown as { get: () => unknown }).get = () => client;
  return store;
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
