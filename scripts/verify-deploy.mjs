#!/usr/bin/env node
/**
 * Checks a deployed URL, so a bad deploy is diagnosable.
 *
 *   npm run verify:deploy https://people-book.vercel.app
 *
 * Why this exists: the failure mode of a serverless deploy is not an exception
 * with a stack trace, it is a 500, or an app that loads and then silently fails
 * every request because SESSION_SECRET is missing. Both read as "the deploy is
 * broken" and neither says why. This asks the deployed thing the same questions
 * the local suite asks the local thing.
 *
 * Deliberately unauthenticated. Everything here must answer before a wallet is
 * connected, because that is the state a judge will see first.
 */

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base || !/^https?:\/\//.test(base)) {
  console.error("usage: npm run verify:deploy <url>");
  process.exit(2);
}

let failures = 0;
const section = (n) => console.log(`\n${n}`);
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

async function get(path) {
  const res = await fetch(base + path, { redirect: "manual" });
  const text = await res.text();
  return { res, text };
}

async function main() {
  console.log(`\nchecking ${base}`);

  section("the page is served");
  {
    const { res, text } = await get("/");
    check("200", res.status === 200, String(res.status));
    // Spelled the obvious way. The previous pattern assumed <div id="root"> was
    // in the first 2000 characters, and it is not -- Vite's injected script tags
    // land before it -- so a perfectly good page read as not-HTML.
    check("it is HTML", /<!doctype html>/i.test(text.slice(0, 200)) && /<div id="root">/i.test(text), text.slice(0, 60));
    check("and it is this app", /People Book/.test(text));
    // The rewrite has to send unknown paths to the app or a deep link 404s.
    const deep = await get("/app/book");
    check("a deep link returns the app, not a 404", deep.res.status === 200, String(deep.res.status));
  }

  section("the service worker unregisters itself and is uncached");
  // The OS push feature was removed. public/sw.js is a tombstone whose only act
  // is self.registration.unregister(), so browsers that installed the old worker
  // stop running it. Asserting the tombstone rather than deleting the check is
  // deliberate: a missing file leaves the installed worker in place forever.
  {
    const { res, text } = await get("/sw.js");
    check("200", res.status === 200, String(res.status));
    check("it is served as JavaScript", /javascript|ecmascript/i.test(res.headers.get("content-type") ?? ""), res.headers.get("content-type") ?? "(none)");
    check("and it is the unregistering tombstone, not a worker", /self\.registration\.unregister/.test(text.slice(0, 3000)));
    // A cached sw.js means a fix never reaches anyone.
    const cc = res.headers.get("cache-control") ?? "";
    check("and is not cached", /max-age=0|no-store|no-cache/i.test(cc), cc || "(no cache-control)");
  }

  section("the API answers");
  {
    const { res, text } = await get("/api/health");
    check("200", res.status === 200, String(res.status));
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* reported below */
    }
    check("it is JSON, not an HTML error page", Boolean(body), text.slice(0, 80));
    if (!body) return finish();
    check("ok is true", body.ok === true, JSON.stringify(body?.detail ?? body));

    const cfg = body.config ?? {};
    // Each of these turns into a confusing failure later if it is missing, so
    // they are named here rather than discovered during a demo.
    check("delegate key is configured", cfg.delegate === true);
    check("session secret is configured", cfg.session === true);
    check("Groq is configured", cfg.groq === true);

    check("the registry matches the relayer's package", body.deployment?.registryOk === true, JSON.stringify(body.deployment?.registryDetail ?? "").slice(0, 90));
    check("and the network is mainnet", body.network === "mainnet", String(body.network));
  }

  section("routes that must exist");
  for (const [path, why] of [
    ["/api/memories", "the ledger"],
    ["/api/today", "notifications"],
    ["/api/patterns", "what you keep saying"],
    ["/api/corrections", "the corrections panel"],
    ["/api/profile", "the profile screen"],
  ]) {
    const { res } = await get(path);
    // 401 is correct: the route exists and wants a session. 404 means the
    // deployed bundle predates the route, which is the bug this catches.
    check(`${path} exists (401 or 200, not 404)`, res.status === 401 || res.status === 200, `${res.status} — ${why}`);
  }

  section("the client was built with the Sui variables");
  {
    const { text } = await get("/");
    const assets = [...text.matchAll(/\/assets\/[^"']+\.js/g)].map((m) => m[0]);
    if (!assets.length) {
      check("found a hashed bundle", false, "no /assets/*.js in the HTML");
    } else {
      let found = null;
      for (const a of assets.slice(0, 8)) {
        const js = await (await get(a)).text;
        // The RPC URL is VITE_-prefixed, so its absence means the variable was
        // not set when the build ran, and setting it in the dashboard afterwards
        // changes nothing.
        if (/fullnode\.mainnet\.sui\.io/.test(js)) found = a;
      }
      check("the Sui RPC URL was inlined at build time", Boolean(found), found ?? "not found in any bundle");
    }
  }

  finish();
}

function finish() {
  console.log("");
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("deployed URL looks correct");
}
main().catch((e) => {
  console.error("\ncould not reach the URL:", e.message);
  process.exit(1);
});
