import { chromium } from "playwright";
const A = "0xcdc3f886eba88a4459c987f76f24a5720650b5edaa77816f95c92f1f355e142a";
const C = "0x7a7e59fd47072f7cab58b45591e8865c7b4896a9ae92a7e22b093e2bce66f97b";
const b = await chromium.launch();

const setup = async (who) => {
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await p.route("**/api/auth/whoami", (r) => r.fulfill({ json: who }));
  await p.route("**/api/health", (r) => r.fulfill({ json: { ok: true, config: { groq: true, delegate: true, session: true } } }));
  await p.route("**/api/account/deployment", (r) => r.fulfill({ json: { packageId: "0xp", registryId: "0xr", network: "mainnet", registryOk: true, registryDetail: "" } }));
  await p.route("**/api/memories", (r) => r.fulfill({ json: { memories: [], coverage: "complete", blobCount: 0, truncated: false } }));
  await p.route("**/api/nudges", (r) => r.fulfill({ json: { nudges: [], elisions: [], basis: {} } }));
  return p;
};

// 1. Landing, signed out.
const p1 = await setup({ signedIn: false });
await p1.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await p1.waitForTimeout(600);
await p1.screenshot({ path: "/tmp/shots/10-landing.png" });
await p1.close();

// 2. Sign-in, signed out.
const p2 = await setup({ signedIn: false });
await p2.goto("http://localhost:5173/signin", { waitUntil: "networkidle" });
await p2.waitForTimeout(600);
await p2.screenshot({ path: "/tmp/shots/11-signin.png" });
await p2.close();

// 3. Sign-in, signed in but not granted -> the setup step.
const p3 = await setup({ signedIn: true, address: A, accountId: null, hasDelegate: false });
await p3.goto("http://localhost:5173/signin", { waitUntil: "networkidle" });
await p3.waitForTimeout(600);
await p3.screenshot({ path: "/tmp/shots/12-setup.png" });
await p3.close();

// 4. The app.
const p4 = await setup({ signedIn: true, address: A, accountId: C, hasDelegate: true });
await p4.goto("http://localhost:5173/app", { waitUntil: "networkidle" });
await p4.waitForTimeout(800);
await p4.screenshot({ path: "/tmp/shots/13-app.png" });
console.log("app body:", JSON.stringify((await p4.evaluate(() => document.body.innerText)).slice(0, 160)));
await p4.close();

await b.close();
