/**
 * LIVE proof that the memory layer works against Walrus Memory on Sui mainnet.
 *
 * This is not a unit test. It writes real blobs to a real account on mainnet,
 * reads them back, runs the ranking engine over what came back, forgets one, and
 * checks it stops surfacing. It is the end-to-end check that the thing actually
 * stores and recalls, and it is also how the submission's "at least 10 blobs on
 * mainnet" evidence is produced.
 *
 *   npx tsx scripts/live-memory-check.ts
 *
 * Needs MEMWAL_PRIVATE_KEY / MEMWAL_ACCOUNT_ID for an account you own.
 */

import { PeopleBookStore } from "../shared/store.js";
import { getClient } from "../server/memwal.js";
import { computeNudges } from "../server/ranking.js";
import { demoCast } from "../shared/demo-cast.js";
import { SELF } from "../shared/types.js";

const accountId: string | undefined = process.env.MEMWAL_ACCOUNT_ID;
if (!accountId) {
  console.error("Set MEMWAL_ACCOUNT_ID (and MEMWAL_PRIVATE_KEY) to an account you own.");
  process.exit(1);
}
const account: string = accountId;

// A separate namespace so a live check never pollutes a real book, and so it can
// be re-run without accumulating duplicate demo entries every time. Still
// book-prefixed, because the store refuses anything else -- see assertAppNamespace.
const NS = "book-livecheck";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

async function main() {
  // Transitional: this script still runs server-side and still uses the env key.
  // It goes away with the key.
  const store = new PeopleBookStore({
    accountId: account,
    namespace: NS,
    createClient: (id, ns) => getClient(id, ns),
  });

  console.log(`\nrelayer: ${process.env.MEMWAL_SERVER_URL ?? "https://relayer.memory.walrus.xyz"}`);
  const health = await store.health();
  check("relayer reachable", health.ok, health.detail);
  if (!health.ok) process.exit(1);

  // ── Write ────────────────────────────────────────────────────────────────
  console.log("\nwriting the demo cast to mainnet…");
  const before = await store.memoryCount();
  console.log(`  blobs before: ${before}`);

  const cast = demoCast();
  console.log(`  seeding ${cast.length} memories in bulk…`);
  const t0 = Date.now();
  const { written, failed } = await store.seedBulk(cast);
  console.log(`  seed took ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const f of failed) console.log(`  not landed: ${f}`);
  check(`wrote all ${cast.length} memories`, failed.length === 0, { got: written.length, failed });
  check("every confirmed write has an id", written.every((m) => m.id.startsWith("mem_")));

  const after = await store.memoryCount();
  console.log(`  blobs after:  ${after}`);
  check(
    "blob count grew by the number written",
    after !== null && before !== null && after - before >= cast.length,
    { before, after, expected: cast.length },
  );
  check(
    "at least 10 blobs on mainnet (submission requirement)",
    after !== null && after >= 10,
    { after },
  );

  // ── Read back ────────────────────────────────────────────────────────────
  console.log("\nreading back…");
  const { memories, coverage } = await store.listLive();
  console.log(`  recalled ${memories.length} live memories (coverage: ${coverage})`);
  check("recalled at least the cast", memories.length >= cast.length - 2, { got: memories.length });
  check("nothing is a tombstone", memories.every((m) => m.deleted !== true));
  check("every memory kept its claim text", memories.every((m) => m.text.length > 10));
  check(
    "typed fields survived the round trip",
    memories.every((m) => m.confidence === "confirmed" && typeof m.rev === "number"),
  );

  // ── Ranking over real recalled data ──────────────────────────────────────
  console.log("\nranking over what the relayer actually returned…");
  const result = computeNudges({ memories, now: new Date() });
  for (const nudge of result.nudges) {
    console.log(`  [${nudge.kind}] ${nudge.text}`);
  }
  check("the real book produces nudges", result.nudges.length > 0, { got: result.nudges.length });
  check("nudges cite a source memory", result.nudges.every((n) => n.sourceMemoryId.length > 0));
  check(
    "nudges never source from an unconfirmed memory",
    result.nudges.every((n) => {
      const src = memories.find((m) => m.id === n.sourceMemoryId);
      return !src || src.confidence === "confirmed";
    }),
  );
  check(
    "Ravi's taboo is announced rather than silently applied",
    result.elisions.some((e) => e.person === "Ravi"),
    result.elisions,
  );
  check(
    "the divorce never appears in any nudge",
    !result.nudges.some((n) => /divorce/i.test(n.text)),
    result.nudges.map((n) => n.text),
  );
  check(
    "the follow-through pattern is found in real data",
    result.nudges.some((n) => n.kind === "followthrough"),
    result.nudges.map((n) => n.kind),
  );
  check(
    "follow-through is not the loudest nudge",
    result.nudges[0]?.kind !== "followthrough",
    result.nudges.map((n) => n.kind),
  );

  const off = computeNudges({ memories, memoryDisabled: true, now: new Date() });
  check("memory off produces nothing", off.nudges.length === 0);

  // ── Forget ───────────────────────────────────────────────────────────────
  console.log("\nforgetting one memory (tombstone, since MemWal has no delete)…");
  const target = memories.find((m) => m.person === "Ravi" && m.type === "promise");
  check("found a promise to forget", Boolean(target));

  if (target) {
    await store.forget(target!.id);
    const { memories: afterForget } = await store.listLive();
    check(
      "the forgotten memory is gone from the live view",
      !afterForget.some((m) => m.id === target!.id),
      { id: target!.id },
    );
    const reranked = computeNudges({ memories: afterForget, now: new Date() });
    check(
      "and it no longer produces a nudge",
      !reranked.nudges.some((n) => n.sourceMemoryId === target!.id),
    );
  }

  const finalCount = await store.memoryCount();
  console.log(`\nblobs in ${NS}: ${finalCount}`);

  console.log("");
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("live check passed — memory is being stored and recalled on mainnet");
}

void main();
