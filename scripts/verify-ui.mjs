/**
 * Visual checks that cannot be made by reading the code.
 *
 * Every layout bug so far was invisible in the source and obvious on screen: an
 * input nested inside an input, a collapsed rail nobody could read, an empty
 * composer 102px tall. All three were reported by a person looking at the page
 * while the build, the typecheck and the test suite were all green.
 *
 * So this drives a real browser against the real dev server and asserts on what
 * comes out. The API is intercepted with fixtures, which means it needs no
 * granted account, no Groq key, and no network -- it checks the interface, not
 * the backend.
 *
 *   npm run dev            # in one shell
 *   npm run verify:ui      # in another
 */

import { chromium } from "playwright";

const BASE = process.env.UI_BASE_URL || "http://localhost:5173";
const ADDRESS = "0xcdc3f886eba88a4459c987f76f24a5720650b5edaa77816f95c92f1f355e142a";
const ACCOUNT = "0x7a7e59fd47072f7cab58b45591e8865c7b4896a9ae92a7e22b093e2bce66f97b";

let failures = 0;
let checks = 0;

function check(label, ok, detail) {
  checks += 1;
  if (ok) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}\n`);
  }
}

function section(name) {
  process.stdout.write(`\n${name}\n`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.route("**/api/auth/whoami", (r) =>
  r.fulfill({ json: { signedIn: true, address: ADDRESS, accountId: ACCOUNT, hasDelegate: true } }));
await page.route("**/api/account/deployment", (r) =>
  r.fulfill({ json: { packageId: "0xpkg", registryId: "0xreg", network: "mainnet", registryOk: true, registryDetail: "" } }));
await page.route("**/api/health", (r) =>
  r.fulfill({ json: { ok: true, config: { delegate: true, groq: true, session: true } } }));

const REPLY = "Noted — Mara's birthday is on the 14th, and the shellfish allergy.";
await page.route("**/api/chat", (r) =>
  r.fulfill({
    headers: { "content-type": "text/event-stream" },
    body: [
      { type: "status", detail: "Reading your book" },
      { type: "delta", text: REPLY },
      {
        type: "done",
        reply: REPLY,
        saved: [
          { id: "m1", person: "Mara", text: "Mara's birthday is on the 14th." },
          { id: "m2", person: "Mara", text: "Mara is allergic to shellfish." },
        ],
        cited: [{ id: "m1", person: "Mara", text: "Mara's birthday is on the 14th." }],
        volunteered: [{ id: "n1", person: "Dev", text: "you owe Dev the signed contract" }],
      },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join(""),
  }));

// ── The empty state ─────────────────────────────────────────────────────────
section("the empty state is the input and nothing else");

// The three routes, because they are three screens and only one of them had ever
// been looked at. Signed out, so / is the landing page rather than a redirect.
const anon = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await anon.route("**/api/auth/whoami", (r) => r.fulfill({ json: { signedIn: false } }));
await anon.route("**/api/health", (r) => r.fulfill({ json: { ok: true, config: { groq: true } } }));
await anon.goto(BASE + "/", { waitUntil: "networkidle" });
await anon.waitForTimeout(600);
const landing = await anon.evaluate(() => document.body.innerText);
check("the landing page says what the thing is", /remembers the people/i.test(landing), JSON.stringify(landing.slice(0, 100)));
check("and offers one action", /sign in with a sui wallet/i.test(landing));
const fold = await anon.evaluate(() => {
  const h1 = document.querySelector("h1")?.innerText ?? "";
  const first = document.querySelector("h1")?.nextElementSibling?.innerText ?? "";
  return `${h1} ${first}`;
});
check("with no jargon in the claim itself", !/delegate key|namespace|relayer|walrus/i.test(fold), fold.slice(0, 120));

// Padding was the first thing wrong with it: mono is a wide face, so the measure
// and the vertical rhythm both have to come in, or every screen reads as a poster
// with one sentence on it.
const landingBox = await anon.evaluate(() => {
  const main = document.querySelector("main");
  const cs = getComputedStyle(main);
  return { width: main.getBoundingClientRect().width, padTop: parseFloat(cs.paddingTop), padBottom: parseFloat(cs.paddingBottom) };
});
check("the landing column is not wider than the text needs", landingBox.width <= 640, `${landingBox.width}px`);
check("and is not floating in a tall empty page", landingBox.padTop <= 56, `${landingBox.padTop}px`);
await anon.close();

// Scoped to the conversation column. The whole body includes the rail, where
// "People Book" is the brand and legitimately present -- asserting on that is
// asserting on the sidebar.
await page.goto(BASE + "/", { waitUntil: "networkidle" });
await page.waitForTimeout(500);

const emptyText = await page.evaluate(() => {
  const main = document.querySelector("main");
  return (main?.innerText ?? "").trim();
});
check("no headline or explanation in the column", !/remember|people|owes|birthday|everyone/i.test(emptyText), JSON.stringify(emptyText.slice(0, 120)));

// ── The composer ─────────────────────────────────────────────────────────────
section("the composer is one compact row");

const box = await page.evaluate(() => {
  const ta = document.querySelector("textarea");
  const el = ta.closest("div.rounded-2xl") ?? ta.parentElement.parentElement;
  const cs = getComputedStyle(ta);
  return { textarea: ta.getBoundingClientRect().height, container: el.getBoundingClientRect().height, outline: cs.outlineStyle };
});
// It was 102px, because the send button sat on its own line. Anything over 64 is
// a hollow box for a one-line input.
check("empty composer is not a hollow box", box.container <= 64, `${box.container}px`);
check("the textarea is not outlined inside its own frame", box.outline === "none", box.outline);

// ── No nested controls ───────────────────────────────────────────────────────
section("no control inside another control");

const nested = await page.evaluate(() => {
  const found = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      const tag = el.tagName.toLowerCase();
      if (["input", "textarea", "select"].includes(tag)) {
        const inner = el.querySelectorAll("input, textarea, select").length;
        if (inner) found.push(`${tag} contains ${inner}`);
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return found;
});
check("nothing is nested inside a form control", nested.length === 0, nested.join(", "));

// ── The rail ─────────────────────────────────────────────────────────────────
section("the rail is readable without hovering");

const rail = await page.evaluate(() => {
  const text = document.querySelector("aside")?.innerText ?? "";
  return { text, width: document.querySelector("aside")?.getBoundingClientRect().width ?? 0 };
});
check("navigation items show their labels", /Talk to it/.test(rail.text), JSON.stringify(rail.text.slice(0, 80)));
check("and the rail is wide enough for them", rail.width > 180, `${rail.width}px`);

// ── A streamed exchange ──────────────────────────────────────────────────────
section("a conversation renders");

await page.locator("textarea").first().fill("Mara's birthday is the 14th and she's allergic to shellfish");
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);

const body = await page.evaluate(() => document.body.innerText);
check("the message you sent is shown", body.includes("Mara's birthday is the 14th"));
check("the reply is shown", body.includes("shellfish allergy"));
check("what it remembered is attributed to a person", body.includes("Mara is allergic to shellfish"));
check("the unprompted nudge is shown", body.includes("you owe Dev"));
check("its sources are offered", body.includes("From 1 thing"));

const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check("nothing overflows horizontally", !overflow);

// ── It survives a reload of a narrow screen ──────────────────────────────────
section("narrow screens");

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check("no horizontal overflow at 390px", !narrowOverflow);
await page.setViewportSize({ width: 1280, height: 900 });

check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

await browser.close();

process.stdout.write("\n");
if (failures > 0) {
  process.stdout.write(`${failures} of ${checks} checks FAILED\n`);
  process.exit(1);
}
process.stdout.write(`all ${checks} checks passed\n`);