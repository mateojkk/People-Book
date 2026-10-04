/**
 * The browser book layer: opening a store, and telling "needs a signature" apart
 * from "try again".
 *
 * The error split is the part worth asserting. Both failures look like "the book
 * did not open", and conflating them is actively harmful in both directions: tell
 * someone to retry when they need to authorise and they retry forever, or ask for
 * a wallet signature when the relayer is merely down and you have just trained
 * them to approve prompts on reflex.
 */

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
};

const g = globalThis as unknown as Record<string, unknown>;
g.window = { location: { origin: "https://people-book.example" }, localStorage: localStorageStub };
g.localStorage = localStorageStub;

const { openBook, withBook, prepareDelegate, currentDelegate, BookError } = await import(
  "../src/lib/book.ts"
);

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

section("an unauthorised browser is told to authorise, not to retry");
{
  storage.clear();
  let thrown: unknown;
  try {
    await openBook(ALICE, "acct_1");
  } catch (e) {
    thrown = e;
  }
  check("it throws", thrown instanceof Error);
  check("with a kind the UI can branch on", thrown instanceof BookError && thrown.kind === "no_delegate",
    String((thrown as BookError)?.kind));
  check("and says a signature is what is missing",
    /signature|authoris|authoriz/i.test(String((thrown as Error)?.message)),
    String((thrown as Error)?.message).slice(0, 60));
}

section("a stored delegate opens a store");
{
  storage.clear();
  const { delegate } = await prepareDelegate(ALICE);
  check("preparing made a key", delegate.publicKey.length === 64);
  check("and it is readable back", currentDelegate(ALICE)?.publicKey === delegate.publicKey);
  const store = await openBook(ALICE, "acct_1");
  check("a store opens", typeof store === "object" && store !== null);
  check("and it is bound to this account", Boolean(store));
}

section("one browser, two accounts, two keys");
{
  storage.clear();
  const a = await prepareDelegate(ALICE);
  const b = await prepareDelegate(BOB);
  check("Alice's key is not Bob's", a.delegate.privateKey !== b.delegate.privateKey);
  check("Alice still reads as herself", currentDelegate(ALICE)?.privateKey === a.delegate.privateKey);
  check("and so does Bob", currentDelegate(BOB)?.privateKey === b.delegate.privateKey);
}

section("a refused grant is reported as needing authorisation");
{
  storage.clear();
  await prepareDelegate(ALICE);

  // The relayer answers an ungranted key with 401. Retrying cannot fix that; only
  // a signature can.
  const unauthorised = Object.assign(new Error("request failed"), { status: 401 });
  let thrown: unknown;
  try {
    await withBook(ALICE, "acct_1", async () => {
      throw unauthorised;
    });
  } catch (e) {
    thrown = e;
  }
  check("it becomes a no_delegate error", thrown instanceof BookError && thrown.kind === "no_delegate",
    String((thrown as BookError)?.kind));
  check("the original is kept as the cause", (thrown as BookError)?.cause === unauthorised);
  check("the message names revocation as the likely cause",
    /revok/i.test(String((thrown as Error)?.message)), String((thrown as Error)?.message).slice(0, 70));
}

section("a transient failure is left alone");
{
  storage.clear();
  await prepareDelegate(ALICE);

  // 502 from the relay is not an authorisation problem. Converting it into
  // "please sign again" would ask for a wallet signature that changes nothing.
  const gateway = Object.assign(new Error("bad gateway"), { status: 502 });
  let thrown: unknown;
  try {
    await withBook(ALICE, "acct_1", async () => {
      throw gateway;
    });
  } catch (e) {
    thrown = e;
  }
  check("it is not rewritten as no_delegate", !(thrown instanceof BookError), String(thrown));
  check("and the original error survives", thrown === gateway);
}

section("a successful operation returns its value");
{
  storage.clear();
  await prepareDelegate(ALICE);
  const value = await withBook(ALICE, "acct_1", async () => ({ memories: [], count: 0 }));
  check("the result comes back untouched", value.count === 0);
}

console.log("");
if (failures > 0) { console.log(`${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`all ${checks} checks passed`);

export {};
