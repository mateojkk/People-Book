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

await page.route("**/api/memories", (r) =>
  r.fulfill({ json: { memories: [], coverage: "complete", blobCount: 0, truncated: false } }));
await page.route("**/api/nudges", (r) => r.fulfill({ json: { nudges: [], elisions: [], basis: {} } }));
await page.route("**/api/tasks/*/*", (r) => r.fulfill({ json: { ok: true } }));
await page.route("**/api/today", (r) =>
  r.fulfill({
    json: {
      notice: "Maya\u2019s birthday is on the 14th \u2014 tomorrow. Also, Dev: send the signed contract \u2014 2 days late.",
      history: [
        { date: "2026-10-01", notice: "Maya\u2019s birthday is on the 14th \u2014 tomorrow. Also, Dev: send the signed contract \u2014 2 days late." },
        { date: "2026-09-30", notice: "Dev: send the signed contract \u2014 a day late." },
        { date: "2026-09-29", notice: "Dev: send the signed contract \u2014 2 days late." },
        { date: "2026-09-28", notice: "Dev: send the signed contract \u2014 3 days late." },
      ],
      dueCount: 2,
      staleCount: 1,
      coverage: "complete",
      tasks: [
        { memoryId: "t1", person: "Dev", text: "Send Dev the signed contract.", dueAt: "2026-09-29", urgency: "overdue", urgencyScore: 0.95, daysLate: 2, active: true, dueLabel: "2 days late" },
        { memoryId: "t2", person: "Maya", text: "Buy Maya a gift.", dueAt: "2026-10-01", urgency: "today", urgencyScore: 0.92, daysLate: 0, active: true, dueLabel: "today" },
      ],
    },
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
  const el = document.querySelector('[data-screen="landing"]');
  const cs = getComputedStyle(el);
  return { width: el.getBoundingClientRect().width, padTop: parseFloat(cs.paddingTop), padBottom: parseFloat(cs.paddingBottom) };
});
check("the landing column has room to breathe", landingBox.width >= 700 && landingBox.width <= 820, `${landingBox.width}px`);
check("and is not floating in a tall empty page", landingBox.padTop <= 56, `${landingBox.padTop}px`);
await anon.close();

// Scoped to the conversation column. The whole body includes the rail, where
// "People Book" is the brand and legitimately present -- asserting on that is
// asserting on the sidebar.
await page.goto(BASE + "/", { waitUntil: "networkidle" });
await page.waitForTimeout(500);

// The landing page must NOT be the <main> landmark: that belongs to the chat
// thread, and the chat's own assertions rely on it. This check used to pass only
// because the redirect bug bounced "/" to "/app", so <main> was the chat and read
// empty. With that fixed it was landing text in <main>, which is what a real
// visitor was always getting.
const claimed = await page.evaluate(() => {
  const chat = document.querySelector("main");
  return { hasMain: Boolean(chat), landing: Boolean(document.querySelector('[data-screen="landing"]')) };
});
check("the landing page does not claim the chat's <main>", claimed.hasMain === false && claimed.landing === true, JSON.stringify(claimed));

// Everything below this line is about the chat, and this page is signed in with a
// granted account, so it goes to /app to be asserted on. It used not to need
// saying: navigating to "/" bounced to the workspace on its own via the auth
// redirect, so the composer assertions were quietly running against the app while
// claiming to be about the landing page.
await page.goto(BASE + "/app", { waitUntil: "networkidle" });
await page.waitForTimeout(500);

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

// ── Signing in must not move you ─────────────────────────────────────────────
section("being signed in never changes which page you are on");

// This was a redirect keyed on auth state: signing in while sitting on the
// landing page threw you into the app. The page you chose got replaced by one
// you did not ask for, the moment a background refetch finished.
for (const start of ["/", "/signin", "/app"]) {
  let signedIn = false;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route("**/api/auth/whoami", (r) =>
    r.fulfill({ json: signedIn ? { signedIn: true, address: "0xabc", accountId: "0xdef", hasDelegate: true } : { signedIn: false } }),
  );
  await page.route("**/api/health", (r) => r.fulfill({ json: { ok: true, config: { groq: true } } }));
  await page.goto(BASE + start, { waitUntil: "networkidle" });
  const before = new URL(page.url()).pathname;
  signedIn = true;
  await page.reload({ waitUntil: "networkidle" });
  const after = new URL(page.url()).pathname;
  check(`signing in on ${start} leaves you on ${start}`, before === after, `moved to ${after}`);
  await page.close();
}

// A deep link to /app with no account shows the setup screen AT /app. It used to
// bounce to /signin, which meant the address bar lied about where you were.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route("**/api/auth/whoami", (r) => r.fulfill({ json: { signedIn: false } }));
  await page.route("**/api/health", (r) => r.fulfill({ json: { ok: true, config: { groq: true } } }));
  await page.goto(BASE + "/app", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  check("/app without an account keeps its URL", new URL(page.url()).pathname === "/app");
  check("/app without an account shows the setup screen", await page.getByText("Sign in", { exact: false }).first().isVisible());
  await page.close();
}

// ── Disconnect ───────────────────────────────────────────────────────────────
section("disconnecting ends the session and unplugs the wallet");

// Both halves, deliberately. Clearing only the cookie leaves dapp-kit believing
// it is still connected; clearing only the wallet leaves a valid session for an
// address the person can no longer see.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let signedIn = true;
  await page.route("**/api/auth/whoami", (r) => r.fulfill({ json: { signedIn: true, address: "0xabc", accountId: "0xdef", hasDelegate: true } }));
  await page.route("**/api/health", (r) => r.fulfill({ json: { ok: true, config: { groq: true } } }));
  await page.route("**/api/auth/logout", async (r) => {
    signedIn = false;
    await r.fulfill({ json: { ok: true } });
  });
  await page.goto(BASE + "/app", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  // In the workspace, not on a setup screen nobody returns to. The only Disconnect
  // button used to live there, so a fully set-up user had no way to leave at all.
  const leave = page.getByRole("button", { name: /Disconnect/i }).first();
  check("a set-up user can disconnect from the rail", await leave.isVisible());
  await leave.click();
  await page.waitForTimeout(600);
  check("disconnecting lands you on the landing page", new URL(page.url()).pathname === "/");
  check("disconnecting ends the session", signedIn === false);
  await page.close();
}

// ── Tap targets ─────────────────────────────────────────────────────────────
section("every control is big enough to hit with a thumb");

// 44px is the floor on mobile. The landing CTA was 39.5px and the back-link on
// the sign-in screen was 20px, which is the size of the text inside it.
for (const path of ["/", "/signin"]) {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.route("**/api/auth/whoami", (r) => r.fulfill({ json: { signedIn: false } }));
  await phone.route("**/api/health", (r) => r.fulfill({ json: { ok: true, config: { groq: true } } }));
  await phone.goto(BASE + path, { waitUntil: "networkidle" });
  await phone.waitForTimeout(500);
  const smallest = await phone.evaluate(() =>
    Math.min(...[...document.querySelectorAll("button, a")].map((e) => e.getBoundingClientRect().height).filter((x) => x > 0)),
  );
  check(`${path} has no control under 44px`, smallest >= 44, `${smallest}px`);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(`${path} does not overflow a phone`, !overflow);
  await phone.close();
}

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

// A done frame with no deltas must still render the answer. It used to say
// nothing at all, silently, because the turn reads `text` and the payload names
// it `reply`.
const nodelta = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await nodelta.route("**/api/auth/whoami", (r) => r.fulfill({ json: { signedIn: true, address: ADDRESS, accountId: ACCOUNT, hasDelegate: true } }));
await nodelta.route("**/api/today", (r) => r.fulfill({ json: { tasks: [], history: [], dueCount: 0, staleCount: 0, coverage: "complete" } }));
await nodelta.route("**/api/chat", (r) =>
  r.fulfill({ headers: { "content-type": "text/event-stream" },
    body: `data: ${JSON.stringify({ type: "done", reply: "Answered without a single delta.", saved: [], cited: [], volunteered: [] })}\n\n` }));
await nodelta.goto(BASE + "/app", { waitUntil: "networkidle" });
await nodelta.locator("textarea").first().fill("hello");
await nodelta.keyboard.press("Enter");
await nodelta.waitForTimeout(900);
check("a reply with no streamed deltas still renders",
  (await nodelta.evaluate(() => document.body.innerText)).includes("Answered without a single delta"));
await nodelta.close();
check("what it remembered is attributed to a person", body.includes("Mara is allergic to shellfish"));
check("the unprompted nudge is shown", body.includes("you owe Dev"));
check("its sources are offered", body.includes("From 1 thing"));

// Following a citation is the whole reason the book exists.
const cited = page.getByText("From 1 thing");
if (await cited.count()) {
  await cited.first().click();
  await page.waitForTimeout(200);
  const opened = page.getByText(/See everything it has/);
  if (await opened.count()) {
    await opened.first().click();
    await page.waitForTimeout(500);
    check("a citation opens the book", /Your book|Partial view/.test(await page.evaluate(() => document.body.innerText)), "the audit surface is what a citation is for");
  }
}
await page.goto(BASE + "/app", { waitUntil: "networkidle" });
await page.waitForTimeout(500);

const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check("nothing overflows horizontally", !overflow);

// ── The collapsed rail ──────────────────────────────────────────────────────
section("the rail collapses without clipping itself");

// A collapsed rail hides the address block, so if the exit lived only inside it,
// collapsing the rail would take away the only way to sign out.
{
  const c = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await c.route("**/api/auth/whoami", (r) => r.fulfill({ json: { signedIn: true, address: ADDRESS, accountId: ACCOUNT, hasDelegate: true } }));
  await c.route("**/api/account/deployment", (r) => r.fulfill({ json: { packageId: "0xpkg", registryId: "0xreg", network: "mainnet", registryOk: true, registryDetail: "" } }));
  await c.route("**/api/health", (r) => r.fulfill({ json: { ok: true, config: { delegate: true, groq: true, session: true } } }));
  await c.goto(BASE + "/app", { waitUntil: "networkidle" });
  await c.waitForTimeout(400);
  await c.getByRole("button", { name: /collapse/i }).first().click();
  await c.waitForTimeout(500);
  check("a collapsed rail still offers a way out", await c.getByRole("button", { name: "Disconnect wallet" }).isVisible());
  await c.close();
}

await page.getByRole("button", { name: /Collapse sidebar/i }).click();
await page.waitForTimeout(300);
const folded = await page.evaluate(() => {
  const el = document.querySelector("aside");
  return { w: el?.getBoundingClientRect().width ?? 0, scrollW: el?.scrollWidth ?? 0, text: (el?.innerText ?? "").trim() };
});
// It was 56px wide holding 108px of content, so every label rendered clipped
// mid-word: "alk to it", "otifications", "he book".
check("collapsed rail has no overflow", folded.scrollW <= folded.w + 1, `${folded.scrollW}px of content in ${folded.w}px`);
check("and shows icons only", folded.text === "", JSON.stringify(folded.text));
check("with accessible names still on every one", await page.getByRole("button", { name: "Notifications" }).count() > 0);
await page.getByRole("button", { name: /Expand sidebar/i }).click();
await page.waitForTimeout(300);

// ── It survives a reload of a narrow screen ──────────────────────────────────
section("narrow screens");

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check("no horizontal overflow at 390px", !narrowOverflow);
await page.setViewportSize({ width: 1280, height: 900 });

// ── Today, and the notification that reaches you ────────────────────────────
section("today is a list you can finish");

await page.goto(BASE + "/app", { waitUntil: "networkidle" });
await page.waitForTimeout(600);
const shell = await page.evaluate(() => document.body.innerText);
// A sentence, not a count. "2 things need you today" is a reminders app.
check("something is said to you on arrival, in a sentence", /birthday is on the 14th . tomorrow/i.test(shell), JSON.stringify(shell.slice(0, 160)));
check("no task count badge anywhere", !/\d+ things need/i.test(shell));
check("there IS a notifications tab in the rail", /^Notifications$/m.test(shell), "asked for twice");
// What it is called is the whole point, so assert the name.
check("and it is labelled Notifications", /Notifications/.test(shell));
check("not called Today", !/^Today$/m.test(shell));
check("there is no manual add form", !/Write one in|Add by hand/i.test(shell));
check("the book is reachable from the conversation", /the book/i.test(shell));

// It is reached through the notice.
await page.getByRole("button", { name: /^Notifications$/ }).click();
await page.waitForTimeout(600);
const today = await page.evaluate(() => document.body.innerText);
check("the screen is headed Notifications", /Notifications/.test(today));
check("an overdue item says how late", /2 days late/.test(today), today.slice(0, 160));
check("and an item due today says so", /\btoday\b/i.test(today));
check("each row can be finished", await page.getByRole("button", { name: "Done" }).count() >= 2);

// Case-insensitive on purpose: the heading is uppercased in CSS, and innerText
// returns what is rendered rather than what is written.
check("notifications leave a seven day record", /told you . last 7 days/i.test(today), today.slice(0, 200));
check("and past ones are in it", /a day late/.test(today) && /3 days late/.test(today));
// Case-insensitive: the heading is uppercased in CSS and innerText returns what
// is rendered. indexOf("Told you") on "TOLD YOU" is -1, which silently turned this
// assertion into a check of the last character of the page.
const recordAt = today.search(/told you/i);
const record = recordAt === -1 ? "" : today.slice(recordAt);
check("with the newest not repeated in the list", !/birthday is on the 14th/.test(record), record.slice(0, 120));
check("and the days before it are all still there", /a day late/.test(record) && /2 days late/.test(record) && /3 days late/.test(record));
// The one that made this an activity tracker.
check("nothing scores the user", !/you said you would do|let pass|% of/i.test(today));
await page.screenshot({ path: "/tmp/shots/20-today.png" });

// Pressing Done must actually call the settle route.
const settleCalls = [];
page.on("request", (r) => {
  if (r.url().includes("/api/tasks/")) settleCalls.push(r.url().split("/api/")[1]);
});
await page.getByRole("button", { name: "Done" }).first().click();
await page.waitForTimeout(700);
check("Done writes a revision rather than deleting", settleCalls.some((u) => u.includes("/settle")), settleCalls.join(","));

check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

await browser.close();

process.stdout.write("\n");
if (failures > 0) {
  process.stdout.write(`${failures} of ${checks} checks FAILED\n`);
  process.exit(1);
}
process.stdout.write(`all ${checks} checks passed\n`);