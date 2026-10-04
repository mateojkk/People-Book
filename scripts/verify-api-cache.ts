/**
 * The client GET cache: dedupe, TTL, and mutation invalidation.
 *
 * Every tab fetches on mount and every endpoint reads the full ledger, so
 * without this a tab switch is a relayer round trip each time. The behaviours
 * that matter are the ones that go wrong silently: serving a failure as if it
 * were data, caching across a mutation, or firing two identical requests because
 * two components mounted in the same tick.
 */

// Stub fetch before the module under test loads.
let fetchCalls = 0;
const responders = new Map<string, () => { ok: boolean; status: number; body: unknown }>();
// A holder, not a bare variable: TS narrows a `let` across the async
// boundary to what it can see in straight-line flow (null), and then the
// optional call below reads as calling `never`.
const gate: { resolve: ((v: unknown) => void) | null } = { resolve: null };

const g = globalThis as unknown as Record<string, unknown>;
g.fetch = async (url: unknown) => {
  fetchCalls++;
  const path = String(url);
  const respond = responders.get(path);
  if (!respond) throw new Error(`unexpected fetch to ${path}`);
  // A gated path lets a test hold a request open while a mutation lands.
  if (path === "/gated") await new Promise((r) => { gate.resolve = r as (v: unknown) => void; });
  const { ok, status, body } = respond();
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  };
};

const { api } = await import("../src/lib/api.js");

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
function reset() {
  fetchCalls = 0;
  responders.clear();
  gate.resolve = null;
  api._resetForTests();
  // Mutations used only to bust the cache.
  responders.set("/api/tasks/x/settle", () => ({ ok: true, status: 200, body: {} }));
  responders.set("/api/memories/y", () => ({ ok: true, status: 200, body: {} }));
  responders.set("/api/other", () => ({ ok: true, status: 200, body: {} }));
}

section("concurrent identical GETs share one request");
{
  reset();
  responders.set("/api/today", () => ({ ok: true, status: 200, body: { tasks: [] } }));
  const [a, b] = await Promise.all([api.get("/api/today"), api.get("/api/today")]);
  check("one fetch for two callers", fetchCalls === 1, `${fetchCalls} fetches`);
  check("both callers get the data", JSON.stringify(a) === JSON.stringify(b));
}

section("a fresh GET is served from cache");
{
  reset();
  responders.set("/api/memories", () => ({ ok: true, status: 200, body: { memories: [1] } }));
  await api.get("/api/memories");
  await api.get("/api/memories");
  check("the second call does not fetch", fetchCalls === 1, `${fetchCalls} fetches`);
  check("and the entry is cached", api._cacheSizeForTests() >= 1);
}

section("different URLs are cached separately");
{
  reset();
  responders.set("/api/a", () => ({ ok: true, status: 200, body: { v: "a" } }));
  responders.set("/api/b", () => ({ ok: true, status: 200, body: { v: "b" } }));
  const a = await api.get<{ v: string }>("/api/a");
  const b = await api.get<{ v: string }>("/api/b");
  check("two fetches for two URLs", fetchCalls === 2, `${fetchCalls} fetches`);
  check("and neither is the other", a.v === "a" && b.v === "b");
}

section("any mutation busts the whole cache");
{
  reset();
  responders.set("/api/today", () => ({ ok: true, status: 200, body: { n: fetchCalls } }));
  await api.get("/api/today");
  check("cached after first read", fetchCalls === 1);
  await api.post("/api/tasks/x/settle", {});
  const afterPost = fetchCalls; // the POST itself fetched; the bust is what matters
  await api.get("/api/today");
  check("a POST forces the next GET to refetch", fetchCalls === afterPost + 1, `${fetchCalls} fetches`);
  await api.del("/api/memories/y");
  const afterDel = fetchCalls;
  await api.get("/api/today");
  check("and so does a DELETE", fetchCalls === afterDel + 1, `${fetchCalls} fetches`);
}

section("a failure is never cached");
{
  reset();
  let fail = true;
  responders.set("/api/flaky", () =>
    fail ? { ok: false, status: 500, body: { error: "x", message: "boom" } } : { ok: true, status: 200, body: { fine: true } },
  );
  await api.get("/api/flaky").catch(() => {});
  check("the failure fetched once", fetchCalls === 1);
  fail = false;
  const retry = await api.get<{ fine: boolean }>("/api/flaky");
  check("and the retry fetches again instead of serving the error", fetchCalls === 2 && retry.fine === true);
}

section("a response that lands after a mutation is not stored");
{
  reset();
  responders.set("/gated", () => ({ ok: true, status: 200, body: { stale: true } }));
  const pending = api.get("/gated");
  // Let the gated request start, then mutate, then release it. Its data predates
  // the mutation, so storing it would serve pre-write state as current.
  await new Promise((r) => setTimeout(r, 10));
  await api.post("/api/other", {});
  gate.resolve?.(null);
  await pending;
  check("the fetch happened", fetchCalls >= 1, `${fetchCalls} fetches`);
  check("but nothing was cached from the stale response", api._cacheSizeForTests() === 0);
}

console.log("");
if (failures > 0) { console.log(`${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`all ${checks} checks passed`);

export {};
