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

import { PeopleBookStore } from "../api/lib/store.ts";
import { NAMESPACE, NAMESPACE_PREFIX, assertAppNamespace } from "../api/lib/memwal.ts";

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
section("the namespace is book-prefixed");

check("the prefix is 'book'", NAMESPACE_PREFIX === "book", NAMESPACE_PREFIX);
check("the app namespace is prefixed", NAMESPACE.startsWith("book-"), NAMESPACE);
check("the app namespace passes its own guard", assertAppNamespace(NAMESPACE) === NAMESPACE);

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
  // Near-misses. A prefix check that only matched the start would let these
  // through, which is why the trailing hyphen is part of the prefix.
  "books",
  "bookshop",
  "notebook",
  "mybook",
  "book",
  // A prefix check without anchoring would be fooled by these.
  "x-book-people",
  "../book-people",
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

for (const namespace of ["nue-memory", "thesaintszn@gmail.com", "default"]) {
  let refused = false;
  try {
    // Constructing is enough: the client is created eagerly, and every read and
    // write the store performs inherits that namespace.
    const store = new PeopleBookStore({ accountId: "0x0", namespace });
    void store;
  } catch {
    refused = true;
  }
  check(`store refuses "${namespace}"`, refused);
}

let appStoreOk = true;
try {
  const store = new PeopleBookStore({ accountId: "0x0", namespace: NAMESPACE });
  void store;
} catch (error) {
  appStoreOk = false;
  console.log("   ", error);
}
check("store accepts its own namespace", appStoreOk);

// ─── No route takes a namespace from the request ─────────────────────────────
section("no route accepts a namespace from the request");

const routeSource = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../api/[[...route]].ts", import.meta.url), "utf8"),
);

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
