/**
 * Chat history persistence: what survives a reload, and in what state.
 *
 * The cases that matter are the unhappy ones. A clean history round-trips
 * trivially; what must not happen is a reload resurrecting a stream that no
 * longer exists (hanging forever on `pending: true`), silently dropping what
 * was said, mixing two wallets' histories, or growing without bound in a 5MB
 * store.
 */

// Minimal localStorage stub. The module under test touches getItem/setItem only
// through loadHistory, which takes no storage argument -- so the stub must sit
// on the global.
const storage = new Map<string, string>();
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
};

const { loadHistory, HISTORY_LIMIT } = await import("../src/components/ChatView.js");

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

const ADDR = "0xABCDEF";
const turn = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  role: "you",
  text: "hello",
  ...over,
});

section("a pending turn does not come back pending");
{
  storage.clear();
  storage.set(`peoplebook:chat:${ADDR.toLowerCase()}`, JSON.stringify([turn({ pending: true, status: "Thinking" })]));
  const [t] = loadHistory(ADDR);
  check("it is not pending", t?.pending === false, String(t?.pending));
  check("it says why instead of hanging", /[Ii]nterrupted/.test(String(t?.failed)), String(t?.failed));
  check("the message text survives", t?.text === "hello");
}

section("histories never cross wallets");
{
  storage.clear();
  storage.set("peoplebook:chat:0xaaa", JSON.stringify([turn({ text: "aaa" })]));
  storage.set("peoplebook:chat:0xbbb", JSON.stringify([turn({ text: "bbb" })]));
  check("aaa reads aaa", loadHistory("0xAAA")[0]?.text === "aaa");
  check("bbb reads bbb", loadHistory("0xbbb")[0]?.text === "bbb");
  check("mixed case finds the same entry", loadHistory("0xAaA")[0]?.text === "aaa");
}

section("corrupt or absent storage loads empty, never throws");
{
  storage.clear();
  check("no entry loads empty", loadHistory(ADDR).length === 0);
  check("no address loads empty", loadHistory(undefined).length === 0);
  storage.set(`peoplebook:chat:${ADDR.toLowerCase()}`, "{not json");
  check("unparseable loads empty", loadHistory(ADDR).length === 0);
  storage.set(`peoplebook:chat:${ADDR.toLowerCase()}`, '"just a string"');
  check("non-array loads empty", loadHistory(ADDR).length === 0);
}

section("history is capped");
{
  storage.clear();
  const many = Array.from({ length: HISTORY_LIMIT + 20 }, (_, i) => turn({ id: `t${i}`, text: `m${i}` }));
  storage.set(`peoplebook:chat:${ADDR.toLowerCase()}`, JSON.stringify(many));
  const loaded = loadHistory(ADDR);
  check(`capped at ${HISTORY_LIMIT}`, loaded.length === HISTORY_LIMIT, `${loaded.length}`);
  check("keeps the newest, drops the oldest", loaded[0]?.id === "t20" && loaded[loaded.length - 1]?.id === `t${HISTORY_LIMIT + 19}`);
}

section("finished turns round-trip untouched");
{
  storage.clear();
  const done = turn({ pending: false, cited: [{ id: "m1", person: "Pat", text: "x" }] });
  storage.set(`peoplebook:chat:${ADDR.toLowerCase()}`, JSON.stringify([done]));
  const [t] = loadHistory(ADDR);
  check("citations survive", (t?.cited as unknown[])?.length === 1);
  check("no failure invented", t?.failed === undefined, String(t?.failed));
}

console.log("");
if (failures > 0) { console.log(`${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`all ${checks} checks passed`);

export {};
