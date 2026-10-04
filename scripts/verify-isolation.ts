/**
 * Isolation verification. `npm run verify:isolation`
 *
 * A Walrus account can hold many namespaces. A user connecting their wallet may
 * already have memories there from other apps, or their own. So the guarantee
 * this project needs is narrow and absolute: **People Book only ever touches
 * namespaces it owns.**
 *
 * That is a claim a reader should be able to check rather than take on faith, so
 * it is checked here — including against the real namespace names that happen to
 * exist in the account this project was developed against, because "we would not
 * have used those" is worth less than "we refuse those".
 *
 * Runs with no network, no key and no wallet.
 */

import { PeopleBookStore } from "../shared/store.ts";
import { NAMESPACE, NAMESPACE_PREFIX, assertAppNamespace } from "../api/_lib/memwal.ts";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

// ─── The prefix is a boundary ────────────────────────────────────────────────
section("the namespace is forced to 'book'");

check("the prefix is 'book'", NAMESPACE_PREFIX === "book", NAMESPACE_PREFIX);
check("the namespace is exactly 'book'", NAMESPACE === "book", NAMESPACE);
check("the namespace passes its own guard", assertAppNamespace(NAMESPACE) === NAMESPACE);
check("a book-* variant is allowed, for the live-check script", assertAppNamespace("book-livecheck") === "book-livecheck");

// ─── Foreign namespaces are refused ──────────────────────────────────────────
section("foreign namespaces are refused");

// These are real namespace names present in the account this project was built
// against, belonging to other projects. None of them may ever be touched.
const FOREIGN = [
  "default",
  "personal",
  "work",
  "research",
  "peoplebook",
  "peoplebook-livecheck",
  "test@example.com",
  "test2@example.com",
  "nue-memory",
  "nue-test",
  "nue-test@example.com",
  "thesaintszn@gmail.com",
  "nue-thesaintszn@gmail.com",
  "health-check",
  "kumo-global-registry",
  "agent-123",
  // Near-misses. The guard matches "book" exactly or "book-*", so anything that
  // merely starts with the same letters is still refused.
  "books",
  "bookshop",
  "notebook",
  "mybook",
  "books-v2",
  // A prefix check without anchoring would be fooled by these.
  "x-book",
  "../book",
  " book",
  "",
];

for (const namespace of FOREIGN) {
  let refused = false;
  let message = "";
  try {
    assertAppNamespace(namespace);
  } catch (error) {
    refused = true;
    message = error instanceof Error ? error.message : String(error);
  }
  check(`refuses "${namespace || "(empty)"}"`, refused);
  if (refused && !message.includes("cannot read or overwrite memory that is not its own")) {
    check(`  ...and explains why`, false, message);
  }
}

// ─── The store cannot be pointed at someone else's memory ───────────────────
section("the store refuses a foreign namespace at construction");

// Never called. These assertions are about construction, and a namespace refusal has
// to happen before any client would be built — so a factory that threw on call
// would make the assertion pass for entirely the wrong reason.
const explodingClient = () => {
  throw new Error("the client factory should not be reached in this test");
};

for (const namespace of ["nue-memory", "thesaintszn@gmail.com", "default"]) {
  let refused = false;
  try {
    // Constructing is enough: the namespace is validated in the constructor, and
    // every read and write the store performs inherits it.
    const store = new PeopleBookStore({ accountId: "0x0", namespace, createClient: explodingClient });
    void store;
  } catch {
    refused = true;
  }
  check(`store refuses "${namespace}"`, refused);
}

let appStoreOk = true;
try {
  const store = new PeopleBookStore({ accountId: "0x0", namespace: NAMESPACE, createClient: explodingClient });
  void store;
} catch (error) {
  appStoreOk = false;
  console.log("   ", error);
}
check("store accepts its own namespace", appStoreOk);

// ─── No route takes a namespace from the request ─────────────────────────────
section("no route accepts a namespace from the request");

// Every file under api/, not one hardcoded path. The route file moved to
// api/_lib/app.ts when the entry point became a fetch wrapper, and this assertion
// silently started reporting "found: 0" — which read as a pass-adjacent curiosity
// rather than "I am looking in the wrong place". Scanning the tree means the next
// move cannot quietly void the check.
const fs = await import("node:fs");
const path = await import("node:path");
function readApiTree(dir: string): string {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return readApiTree(full);
      return entry.name.endsWith(".ts") ? fs.readFileSync(full, "utf8") : "";
    })
    .join("\n");
}
const routeSource = readApiTree(new URL("../api", import.meta.url).pathname);

// Any of these would mean a caller could choose what to read.
const FORBIDDEN_PATTERNS: [string, RegExp][] = [
  ["reading a namespace from query params", /query\(\s*["'`]namespace/],
  ["reading a namespace from a route param", /param\(\s*["'`]namespace/],
  ["reading a namespace out of a request body", /(body|req\.json\(\))[^\n]*\bnamespace\b\s*[:=]/],
  ["passing a body value as a namespace", /namespace:\s*(body|input|payload|req)\b/],
];

for (const [label, pattern] of FORBIDDEN_PATTERNS) {
  check(`no route is ${label}`, !pattern.test(routeSource));
}

// Every store must come from the one guarded construction point.
const constructions = routeSource.match(/new PeopleBookStore\(/g) ?? [];
check("the store is constructed in exactly one place", constructions.length === 1, {
  found: constructions.length,
});
check(
  "and that place passes the forced constant",
  /new PeopleBookStore\(\{[^}]*namespace:\s*NAMESPACE[^}]*\}\)/s.test(routeSource),
);
check("and never a bare identifier as the namespace", !/namespace:\s*[a-z][A-Za-z]*\s*[,}]/s.test(routeSource.replace(/namespace:\s*NAMESPACE/g, "")));

console.log("");
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("all checks passed — this app cannot read memory that is not its own");
