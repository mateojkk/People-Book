/**
 * The browser delegate keypair: generation, persistence, and the relay URL.
 *
 * The storage rules matter more than they look. This key is the app's entire
 * authority over a user's memories, and it lives in localStorage, so the cases
 * that matter are the awkward ones: a corrupt entry, two accounts in one browser,
 * and a browser that has quietly lost it.
 *
 * The relay-URL assertion is a direct regression guard. Vela shipped a bug where
 * an env var pointed the client straight at the relayer, bypassing the proxy and
 * re-introducing the CORS failure the proxy exists to solve — every write died with
 * "Failed to fetch". Nothing about that failure points at its cause.
 */

// ── Browser globals ──────────────────────────────────────────────────────────
// Must exist before the module under test is imported: RELAY_URL reads
// window.location at module scope, which is correct for the app and awkward here.
//
// Hand-rolled rather than jsdom, which is not a dependency. The module under test
// touches exactly three localStorage methods and one origin, and stubbing those is
// less code than the import would be — plus a real Storage would hide the
// corrupt-value behaviour this file exists to check.

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
  key: (i: number) => [...storage.keys()][i] ?? null,
  get length() {
    return storage.size;
  },
};

// The module reaches for window.localStorage specifically, not the bare global, so
// the stub has to sit on `window` too. Getting this wrong was instructive: the
// module's try/catch swallowed the resulting TypeError and reported success, so a
// broken store looks exactly like a first visit. Hence the durability check below.
const g = globalThis as unknown as Record<string, unknown>;
const windowStub = { location: { origin: "https://people-book.example" }, localStorage: localStorageStub };
g.window = windowStub;
g.localStorage = localStorageStub;

const {
  getOrCreateDelegate,
  loadDelegate,
  saveDelegate,
  forgetDelegate,
  createBrowserMemWal,
  bytesToHex,
  hexToBytes,
  RELAY_URL,
} = await import("../src/lib/memwal.ts");

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

const ALICE = "0x1111111111111111111111111111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222222222222222222222222222";

section("the client cannot bypass the relay");
// This is the assertion that would have caught Vela's bug.
check("talks to our own origin, not the relayer", RELAY_URL.startsWith("https://people-book.example/"), RELAY_URL);
check("and the path is the relay path", RELAY_URL.endsWith("/api/memwal"), RELAY_URL);
check("no direct relayer origin anywhere", !RELAY_URL.includes("relayer.memory.walrus.xyz"), RELAY_URL);

section("hex round trips");
{
  const bytes = new Uint8Array([0x00, 0x0f, 0xff, 0xa5]);
  const hex = bytesToHex(bytes);
  check("encodes with zero padding", hex === "000fffa5", hex);
  check("decodes back to the same bytes", Array.from(hexToBytes(hex)).join(",") === "0,15,255,165");
  check("handles a 0x prefix", bytesToHex(hexToBytes("0x" + hex)) === hex);
}

section("a delegate is generated once, then reused");
{
  const first = await getOrCreateDelegate(ALICE);
  check("the first call is new", first.isNew === true);
  check("it has a private key", typeof first.delegate.privateKey === "string" && first.delegate.privateKey.length > 0);
  check("and a public key", first.delegate.publicKey.length === 64, first.delegate.publicKey);

  const second = await getOrCreateDelegate(ALICE);
  check("the second call is not new", second.isNew === false);
  check(
    "and it is the same key, not a fresh one",
    second.delegate.privateKey === first.delegate.privateKey,
  );
}

section("two accounts in one browser get two keys");
{
  const bob = await getOrCreateDelegate(BOB);
  check("Bob's key is new to him", bob.isNew === true);
  const alice = await loadDelegate(ALICE);
  check("Bob's key is not Alice's", bob.delegate.privateKey !== alice?.privateKey);
  check("Alice is untouched", loadDelegate(ALICE)?.privateKey === alice?.privateKey);
  // A shared key would be the bug: one user's memories reachable from another's login.
}

section("a corrupt entry is treated as absent, not trusted");
{
  saveDelegate(ALICE, {
    privateKey: "garbage",
    publicKey: "",
    suiAddress: "",
  } as never);
  check("an entry missing its public key does not load", loadDelegate(ALICE) === null);

  localStorageStub.setItem(`peoplebook_delegate_${ALICE.toLowerCase()}`, "{not json");
  check("unparseable JSON does not load", loadDelegate(ALICE) === null);

  const recovered = await getOrCreateDelegate(ALICE);
  check("and regenerating works", recovered.isNew === true && recovered.delegate.publicKey.length === 64);
}

section("keys are namespaced per address and case-insensitive");
{
  saveDelegate("0xAbCd", { privateKey: "k", publicKey: "p", suiAddress: "s" });
  check("stored under a lowercase key", loadDelegate("0xabcd")?.privateKey === "k");
  check("mixed-case input finds the same entry", loadDelegate("0xABCD")?.privateKey === "k");
  forgetDelegate("0xAbCd");
  check("forget removes it", loadDelegate("0xabcd") === null);
}

section("a store that refuses to persist does not pretend it worked");
{
  // If localStorage throws, saveDelegate swallows it and the next call regenerates.
  // That is the correct fallback -- the app still works for this session -- but it
  // means a new on-chain grant per visit, so the caller must be able to notice.
  // `isNew` is how it notices, and this asserts that stays true.
  const realSetItem = localStorageStub.setItem;
  localStorageStub.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  const ADAM = "0x3333333333333333333333333333333333333333333333333333333333333333";
  const attempt = await getOrCreateDelegate(ADAM);
  check("generation still succeeds", attempt.delegate.publicKey.length === 64);
  check("and it reports isNew, so the caller re-authorises", attempt.isNew === true);
  localStorageStub.setItem = realSetItem;
}

section("the client is constructed from the browser key");
{
  const { delegate } = await getOrCreateDelegate(ALICE);
  const client = createBrowserMemWal(delegate, "0xabc");
  check("it builds", typeof client === "object" && client !== null);
  // The real assertion is that it can sign: a client holding no key throws or
  // produces an unauthenticated request, which the proxy relays as a 401.
  check("and exposes recall", typeof client.recall === "function");
  check("and remember", typeof client.remember === "function");
}

console.log("");
if (failures > 0) { console.log(`${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`all ${checks} checks passed`);
// Makes this a module, so the top-level awaits above are legal. The dynamic
// import is deliberate: window has to exist before RELAY_URL is evaluated.
export {};
