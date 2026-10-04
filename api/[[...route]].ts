/**
 * The API.
 *
 * One Hono app, two hosts: a Vercel serverless function in production and a plain
 * Node server in development (scripts/dev-api.ts). Same routes, same code, so
 * "works on my machine" and "works deployed" cannot drift — which is the point
 * of criterion 3, "could someone clone the repo and run it?".
 *
 * Every route that touches memory takes its accountId from the verified session
 * and then from the onchain account that address owns. There is no route that
 * accepts an accountId, a namespace, or a person from the request body, because
 * each of those would be a way for a caller to read someone else's book.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { computeNudges, elisionLine } from "./_lib/ranking.ts";
import { capture } from "./_lib/capture.ts";
import { takeTurn } from "./_lib/chat.ts";
import { tasksFor, composeNotice, noticeHistory, isTaskMemory } from "./_lib/tasks.ts";
import { computePatterns } from "./_lib/patterns.ts";
import { PeopleBookStore, MemoryNotFoundError } from "../shared/store.ts";
import { isConfigError, isWriteError, NAMESPACE, RECALL_LIMIT, getClient, dropClient } from "./_lib/memwal.ts";
import {
  delegateIsRegistered,
  deployment,
  markDelegateRegistered,
  verifyAccountShape,
  findAccountId,
  registryReadable,
  isPlausibleAddress,
  looksLikeRevoked,
  normalize,
  ourDelegatePublicKey,
  resetDeploymentCache,
  clearDelegateCache,
  verifyRegistry,
} from "./_lib/account.ts";
import {
  SESSION_COOKIE,
  SessionConfigError,
  clearCookieHeader,
  cookieHeader,
  issueChallenge,
  parseCookies,
  readSession,
  redeemChallenge,
} from "./_lib/session.ts";
import { SELF, type NudgeSet, type PersonMemory } from "../shared/types.ts";
import { demoCast } from "../shared/demo-cast.ts";

export const app = new Hono();

/**
 * Resolves the caller's identity to a memory space.
 *
 * This is the only place a store is ever constructed, which is what makes the
 * isolation guarantee auditable by reading one function. Two independent checks
 * must pass: a signature-verified session, and an onchain account owned by that
 * exact address. Either alone would be insufficient — a valid session does not
 * prove the account still exists, and an account existing does not prove the
 * caller owns it.
 */
async function resolveStore(c: Context): Promise<
  { store: PeopleBookStore; address: string } | { error: Response }
> {
  const cookie = c.req.header("cookie");
  const session = await readSession(parseCookies(cookie)[SESSION_COOKIE]);
  if (!session) {
    return { error: c.json({ error: "not_signed_in", message: "Connect your wallet and sign the challenge to continue." }, 401) };
  }

  // The session carries the account id once it is known. It is preferred over
  // resolution because MemWalAccount is a shared object and shared objects
  // cannot be enumerated from their owner, so resolveAccountId() finds nothing
  // for any real user. A cookie also means a refresh or a second tab resolves
  // the same memory space with no chain round trip.
  let accountId: string | null = session.accountId;
  try {
    // The cookie first: it is free and per-browser. The registry answers for any
    // address on any device in one read, which is what makes a new browser and a
    // new device work with nothing stored anywhere.
    if (!accountId) accountId = await findAccountId(session.address);
  } catch (error) {
    return {
      error: c.json(
        { error: "sui_unreachable", message: `Could not reach Sui to confirm your account: ${error instanceof Error ? error.message : String(error)}` },
        503,
      ),
    };
  }

  if (!accountId) {
    return {
      error: c.json(
        { error: "no_account", message: "This address has no Walrus Memory account yet. Create one, then grant People Book access to it." },
        409,
      ),
    };
  }

  // A key this app has not been granted cannot read anything, and finding that
  // out by enumerating costs eight doomed recalls -- measured at 26s against the
  // live relayer before this check existed. One authenticated probe answers it in
  // about a second, so a browser that has never granted us access gets told so
  // immediately instead of after a long silence.
  //
  // Only for an account id we resolved just now. A session that already carries
  // one means the grant succeeded in this browser, and re-probing every request
  // would add a round trip to every read to re-confirm something the user already
  // did by signing.
  if (!session.accountId && !(await delegateIsRegistered(accountId))) {
    return {
      error: c.json(
        {
          error: "no_grant",
          message:
            "People Book does not have access to this Walrus Memory account yet. Grant access to continue — it is one signature, and it can be revoked on chain at any time.",
        },
        403,
      ),
    };
  }

  return {
    // Transitional: the browser owns the key now, so these read/write routes go
    // away entirely in the final stage. Until then they still need a client, and
    // this is the last place one is built from an environment variable.
    store: new PeopleBookStore({
      accountId,
      namespace: NAMESPACE,
      createClient: (id, ns) => getClient(id, ns),
      onReset: dropClient,
    }),
    address: session.address,
  };
}

function toErrorResponse(c: Context, error: unknown): Response {
  if (isConfigError(error)) {
    return c.json({ error: error.code, message: error.message }, 503);
  }
  if (error instanceof SessionConfigError) {
    return c.json({ error: error.code, message: error.message }, 503);
  }
  if (isWriteError(error)) {
    return c.json({ error: error.code, message: error.message }, 502);
  }
  if (error instanceof MemoryNotFoundError) {
    return c.json({ error: error.code, message: error.message }, 404);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (looksLikeRevoked(error)) {
    return c.json(
      {
        error: "revoked",
        message:
          "The Walrus Memory account rejected this key. It looks like the delegate key was removed on chain — which is exactly what that button is for. Re-grant access to carry on.",
      },
      403,
    );
  }
  return c.json({ error: "internal", message }, 500);
}

// ── MemWal relay proxy ──────────────────────────────────────────────────────
//
// The browser holds the delegate keypair. It signs every MemWal request itself
// and sends it here; this forwards it to the relayer with the signing headers
// untouched. **This route holds no key and must never gain one.** Its whole
// reason to exist is CORS: the relayer sends no Access-Control-Allow-Origin on
// preflight, so a direct browser call fails with "Failed to fetch". Relaying
// from the server side is the fix, and it is deliberately a dumb byte-and-header
// forward rather than a place where a key lives.
//
// Modelled on vela/handlers/memwal.py, which does the same thing and has the same
// comment about why.

const MEMWAL_FORWARD_HEADERS = [
  "content-type",
  "x-public-key",
  "x-signature",
  "x-timestamp",
  "x-nonce",
  "x-account-id",
  "x-delegate-key",
  "x-seal-session",
  "x-memwal-account-id",
  "x-memwal-namespace",
] as const;

app.all("/api/memwal/*", async (c) => {
  const upstreamBase = (
    process.env.MEMWAL_SERVER_URL ?? "https://relayer.memory.walrus.xyz"
  ).replace(/\/$/, "");

  // Everything after /api/memwal is the relayer's own path.
  const suffix = new URL(c.req.url).pathname.replace(/^\/api\/memwal/, "") || "/";
  const target = upstreamBase + suffix + new URL(c.req.url).search;

  const headers = new Headers();
  for (const name of MEMWAL_FORWARD_HEADERS) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }

  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
  const body = hasBody ? await c.req.arrayBuffer() : undefined;

  try {
    const upstream = await fetch(target, {
      method: c.req.method,
      headers,
      body,
      // The relayer is authoritative for the outcome of a write; relaying its
      // status verbatim is what lets the browser tell "accepted" from "failed".
      redirect: "manual",
    });

    const outHeaders = new Headers();
    for (const name of ["content-type", "x-request-id", "retry-after"]) {
      const value = upstream.headers.get(name);
      if (value) outHeaders.set(name, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json(
      { error: "relay_failed", message: `Could not reach the MemWal relayer: ${message}` },
      502,
    );
  }
});

// ── Health ───────────────────────────────────────────────────────────────────

app.get("/api/health", async (c) => {
  const delegateConfigured = Boolean(process.env.MEMWAL_DELEGATE_KEY);
  const groqConfigured = Boolean(process.env.GROQ_API_KEY);
  const sessionConfigured = Boolean(process.env.SESSION_SECRET);
  // Cleared each call so a rotation is picked up without a redeploy. The delegate
  // cache goes too: this is the endpoint a person hits while debugging why a
  // revoked key still half-works, so it must not serve a stale "registered".
  resetDeploymentCache();
  clearDelegateCache();
  let pair: { packageId: string; registryId: string; registryOk: boolean; registryDetail: string } | null = null;
  try {
    const resolved = await deployment();
    const check = await verifyRegistry();
    pair = { ...resolved, registryOk: check.ok, registryDetail: check.detail };
  } catch {
    pair = null;
  }
  let delegatePublic: string | null = null;
  try {
    delegatePublic = (await ourDelegatePublicKey()).reduce((hex, b) => hex + b.toString(16).padStart(2, "0"), "");
  } catch {
    delegatePublic = null;
  }
  return c.json({
    // The registry check is part of readiness: a package rotation with a stale
    // registry is the failure that produces an opaque 401 on every write.
    ok: delegateConfigured && groqConfigured && sessionConfigured && (pair?.registryOk ?? false),
    config: { delegate: delegateConfigured, groq: groqConfigured, session: sessionConfigured },
    delegatePublicKey: delegatePublic,
    namespace: NAMESPACE,
    network: "mainnet",
    deployment: pair,
    recallLimit: RECALL_LIMIT,
  });
});

// ── Auth ─────────────────────────────────────────────────────────────────────

/** Step 1: server issues a single-use challenge bound to an address. */
app.post("/api/auth/challenge", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { address?: unknown };
  if (!isPlausibleAddress(body.address)) {
    return c.json({ error: "bad_address", message: "That is not a Sui address." }, 400);
  }
  const challenge = issueChallenge(normalize(body.address));
  return c.json({ token: challenge.token, message: challenge.message, bytes: [...challenge.bytes] });
});

/** Step 2: the wallet signs it, and we verify before minting a session. */
app.post("/api/auth/session", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    token?: unknown;
    signature?: unknown;
    signedBytes?: unknown;
  };
  if (typeof body.token !== "string" || typeof body.signature !== "string") {
    return c.json({ error: "bad_request", message: "token and signature are required." }, 400);
  }

  const result = await redeemChallenge(
    body.token,
    body.signature,
    typeof body.signedBytes === "string" ? body.signedBytes : undefined,
  );
  if (!result.ok) {
    // The signature and the challenge bytes are never logged — they are
    // credentials, and MemWal's own guidance is explicit about not logging them.
    // What is logged is the shape of the failure, which is what a real
    // incompatibility needs to be diagnosed.
    console.warn(
      `[auth] challenge rejected: reason=${result.reason} detail=${result.detail ?? "none"} ` +
        `sigLen=${body.signature.length} presentedBytes=${typeof body.signedBytes === "string" ? body.signedBytes.length : "absent"}`,
    );

    // The message is written per failure rather than being one generic string,
    // because "your signature did not verify" is unactionable when the real
    // cause could be an expired challenge, an altered message, or a mismatch.
    const messages: Record<string, string> = {
      unknown_challenge: "That sign-in request expired before it was used. Ask for a new one and try again.",
      expired: "That sign-in request took too long to sign. Ask for a new one and try again.",
      bad_signature: result.detail
        ? `That signature did not verify against the challenge (${result.detail}). Ask for a new one and try again.`
        : "That signature did not verify against the challenge. Ask for a new one and try again.",
      address_mismatch: "The address that signed is not the address the challenge was issued for.",
      message_altered: `The wallet signed a different message than the one we asked it to sign (${result.detail ?? "bytes differ"}).`,
    };
    return c.json(
      { error: result.reason, message: messages[result.reason] ?? "Sign-in failed.", detail: result.detail },
      401,
    );
  }

  const { createSession } = await import("./_lib/session.ts");
  const cookie = await createSession(result.address);
  c.header("Set-Cookie", cookieHeader(SESSION_COOKIE, cookie, 60 * 60 * 24 * 30));
  return c.json({ address: result.address });
});

app.get("/api/auth/whoami", async (c) => {
  const session = await readSession(parseCookies(c.req.header("cookie"))[SESSION_COOKIE]);
  if (!session) return c.json({ signedIn: false }, 200);
  const accountId = session.accountId ?? (await findAccountId(session.address).catch(() => null));

  // Whether OUR delegate key is already on that account decides whether setup is
  // finished, and it is NOT implied by the account existing. A user who already
  // used another MemWal app has an account but has never granted us access, and
  // sending them straight into the app would mean every write failing as
  // unauthorized with no explanation. Probed with the cheapest authenticated call
  // the relayer offers, and cached per process because the answer cannot change
  // without the user acting.
  // The session carrying an account id means setup already completed for this
  // account, because the id is only written there after a successful grant. So
  // the answer is known without a round trip. Falling back to the probe is what
  // makes an old session still work.
  let hasDelegate: boolean;
  if (session.accountId) {
    hasDelegate = true;
  } else if (accountId) {
    hasDelegate = await delegateIsRegistered(accountId);
  } else {
    hasDelegate = false;
  }

  return c.json({ signedIn: true, address: session.address, accountId, hasDelegate });
});

app.post("/api/auth/logout", (c) => {
  c.header("Set-Cookie", clearCookieHeader(SESSION_COOKIE));
  return c.json({ ok: true });
});

/**
 * Reports the app's own delegate public key so the UI can show it.
 *
 * The user is about to sign a transaction granting this key access to their
 * account, so they are entitled to see exactly what they are granting. Showing
 * it is also what makes the revocation demo checkable.
 */
/**
 * The live Walrus Memory deployment pair.
 *
 * The browser needs the same package and registry ids the server uses, or
 * create_account lands an account under a package the relayer does not serve.
 * Serving them from one place means a rotation is fixed in exactly one file.
 */
app.get("/api/account/deployment", async (c) => {
  try {
    const pair = await deployment();
    const registry = await verifyRegistry();
    return c.json({ ...pair, network: "mainnet", registryOk: registry.ok, registryDetail: registry.detail });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

app.get("/api/account/delegate-key", async (c) => {
  try {
    const publicKey = await ourDelegatePublicKey();
    const hex = [...publicKey].map((b) => b.toString(16).padStart(2, "0")).join("");
    return c.json({ publicKey: hex });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/**
 * Records the caller's account in their session, so later requests skip the
 * registry read.
 *
 * The account id is NOT taken from the request. It is read from the registry for
 * the signed-in address, which means a client cannot talk the server into
 * pointing its session at somebody else's book: the only account this can ever
 * resolve is the one the registry already says that address owns.
 *
 * This is a cache warm, not a grant. Being able to read the account id is not
 * the same as being able to read its memories -- that still requires the
 * onchain delegate key, and a 404-worthy wrong account id simply will not
 * resolve here.
 */
app.post("/api/account/adopt", async (c) => {
  const session = await readSession(parseCookies(c.req.header("cookie"))[SESSION_COOKIE]);
  if (!session) return c.json({ error: "not_signed_in" }, 401);

  const accountId = session.accountId ?? (await findAccountId(session.address).catch(() => null));
  if (!accountId) return c.json({ error: "no_account" }, 404);

  const { createSession } = await import("./_lib/session.ts");
  c.header("Set-Cookie", cookieHeader(SESSION_COOKIE, await createSession(session.address, accountId), 60 * 60 * 24 * 30));
  return c.json({ ok: true, accountId });
});

/**
 * The manual escape hatch: use an account id the registry lookup could not
 * reach.
 *
 * With the registry this should almost never be needed, which is why it is
 * checked rather than trusted. The id is verified to be a real MemWalAccount,
 * and then verified to be the account the signed-in address actually owns. The
 * second check is the one that matters: without it, a user could paste any
 * account id in the explorer and be handed a session pointing at a stranger's
 * book.
 */
app.post("/api/account/claim", async (c) => {
  const session = await readSession(parseCookies(c.req.header("cookie"))[SESSION_COOKIE]);
  if (!session) return c.json({ error: "not_signed_in" }, 401);

  const body = await c.req.json().catch(() => ({}) as { accountId?: string });
  const raw = String(body?.accountId ?? "").trim();
  if (!raw) return c.json({ error: "missing_account_id" }, 400);

  // Accepts a bare id or an explorer link, since that is what people copy.
  const shape = await verifyAccountShape(raw);
  if (!shape.ok) return c.json({ error: "not_an_account", detail: shape.reason }, 400);
  const hex = shape.accountId;

  // The ownership check, and the part that actually matters. The registry is
  // authoritative, so this is decided by what it says about the SIGNED-IN
  // address -- never by the id in the request.
  if (!(await registryReadable())) {
    // Cannot check, so do not claim: fail closed rather than wave it through.
    return c.json(
      { error: "registry_unavailable", detail: "Could not reach the Walrus Memory registry to verify ownership. Try again in a moment." },
      503,
    );
  }
  const owned = await findAccountId(session.address).catch(() => null);
  if (owned !== hex) {
    return c.json(
      {
        error: "not_your_account",
        detail: owned
          ? "That account is registered to a different address than the one you are signed in with."
          : "The address you are signed in with has no Walrus Memory account on record, so it cannot own that one.",
      },
      403,
    );
  }

  // A fresh grant is still required, so a previous negative answer must not stick.
  markDelegateRegistered(hex);
  const { createSession } = await import("./_lib/session.ts");
  c.header("Set-Cookie", cookieHeader(SESSION_COOKIE, await createSession(session.address, hex), 60 * 60 * 24 * 30));
  return c.json({ ok: true, accountId: hex });
});

// ── The book ─────────────────────────────────────────────────────────────────

/** The ledger, with an honest coverage figure. */
app.get("/api/memories", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;
  try {
    const { memories, coverage } = await resolved.store.listLive();
    const total = await resolved.store.memoryCount();
    return c.json({
      memories,
      coverage,
      // The relayer's own count. When this is larger than the list, the ledger
      // is partial and the UI says so rather than implying completeness.
      blobCount: total,
      truncated: total !== null && total > memories.length,
    });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/**
 * The revision chain of one memory.
 *
 * Every correction and every change of mind, oldest first, with what was believed
 * at each step. This is the read that makes the append-only model worth anything:
 * the March answer is still there, and asking for it gets the March answer rather
 * than the current one rewritten over it.
 */
app.get("/api/memories/:id/history", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;
  const id = c.req.param("id");
  try {
    const history = await resolved.store.listHistory(id);
    if (!history.length) {
      return c.json({ error: "No memory with that id." }, 404);
    }
    return c.json({ id, revisions: history });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/**
 * Standing corrections.
 *
 * Separate from the ledger because these are rules about how the assistant works,
 * not facts about anyone's life. Rendering them beside "Maya is vegetarian" is what
 * makes them read as trivia instead.
 */
app.get("/api/corrections", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;
  try {
    return c.json({ corrections: await resolved.store.listCorrections() });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/**
 * "What do I keep saying?"
 *
 * Computed, not stored. There is no memory in anyone's book that contains this
 * answer -- it is a shape across many of them, so it cannot be retrieved and must
 * be derived. Deterministic on purpose: asked this question, a model will answer
 * fluently and invent the answer, which is the one thing this product must never
 * do. Every pattern comes back with the memory ids behind it, so the user can be
 * shown the evidence instead of a conclusion.
 */
app.get("/api/patterns", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;
  try {
    const { memories } = await resolved.store.listLive();
    return c.json({ patterns: computePatterns(memories) });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/**
 * The nudges.
 *
 * `?memory=off` is the A/B switch. It does not degrade the product, it produces
 * the honest baseline: every nudge is a recall, so with memory off there is
 * nothing. That contrast is the before/after the submission is judged on.
 */
/**
 * What to do today.
 *
 * The screen that answers "why did I open this". Assembled from the ledger rather
 * than stored separately, so it cannot drift from the book, and filtered through
 * decay so nothing faded is presented as urgent.
 */
app.get("/api/today", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;
  try {
    const { memories, coverage } = await resolved.store.listLive();
    const now = new Date();
    // The user's own zone, so "today" is today where they are rather than in UTC.
    // Read on every call rather than cached: it changes when they change it, and
    // a stale zone would put a birthday on the wrong day.
    const timeZone = await userTimeZone(resolved.store);
    const tasks = tasksFor(memories, now, timeZone);
    const dueToday = tasks.filter((t) => t.active && (t.urgency === "overdue" || t.urgency === "today"));
    return c.json({
      tasks,
      // A sentence, not a count. "2 things need you today" is a task list with a
      // bell on it; the sentence is this app being useful in its own voice.
      notice: composeNotice(memories, tasks, now, timeZone),
      // What it could have said for the last week. Recomputed, not recorded --
      // see noticeHistory for why, and for what that costs in honesty.
      history: noticeHistory(memories, tasks, now, timeZone),
      dueCount: dueToday.length,
      staleCount: tasks.filter((t) => !t.active).length,
      coverage,
    });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/**
 * Marks a task done -- or undoes that.
 *
 * Written as a new revision rather than an edit, so the promise that existed
 * before is still in the book. That is the difference between "you changed your
 * mind" and "this never happened", and it is the same reason forgetting writes a
 * tombstone.
 *
 * Settling and reopening are the same route with an explicit verb rather than a
 * toggle, so a double-tap cannot settle something and then immediately reopen it.
 */
app.post("/api/tasks/:id/:action", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;

  const action = c.req.param("action");
  if (action !== "settle" && action !== "reopen") {
    return c.json({ error: "bad_request", message: "action must be settle or reopen." }, 400);
  }

  try {
    const memory = await resolved.store.getById(c.req.param("id"));
    if (!memory) return c.json({ error: "not_found", message: "That is not in your book." }, 404);
    // The shared predicate, so this route and tasksFor cannot disagree about what a
    // task is. They did: the list produced promises AND dated events while this
    // accepted only promises, so every dated event rendered a Done button that
    // answered 400.
    if (!isTaskMemory(memory)) {
      return c.json(
        { error: "not_a_task", message: "Only promises and dated events can be settled." },
        400,
      );
    }

    // Settling something already settled is a no-op rather than an error, because
    // the honest answer to "is this done?" when it is already done is yes.
    if (action === "settle" && (memory.status === "kept" || memory.status === "settled")) {
      return c.json({ ok: true, memory });
    }
    if (action === "reopen" && memory.status === "open") {
      return c.json({ ok: true, memory });
    }

    // Reopening puts it back to open, which is what the ranker surfaces. Kept is
    // reserved for the user saying so directly, so a settled task that comes back
    // is genuinely outstanding again rather than silently kept.
    const next = await resolved.store.revise(
      memory,
      action === "settle" ? { status: "settled" } : { status: "open" },
    );
    return c.json({ ok: true, memory: next });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

app.get("/api/nudges", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;

  const memoryDisabled = c.req.query("memory") === "off";
  const dismissals = parseCookies(c.req.header("cookie")).pb_dismiss
    ? new Set(parseCookies(c.req.header("cookie")).pb_dismiss!.split(",").filter(Boolean))
    : new Set<string>();

  try {
    const { memories } = memoryDisabled ? { memories: [] as PersonMemory[] } : await resolved.store.listLive();
    const ranked = computeNudges({
      memories,
      memoryDisabled,
      dismissed: dismissals,
      now: new Date(),
      timeZone: await userTimeZone(resolved.store),
    });

    // No model call to reword these. Every nudge already has a deterministic
    // sentence, and the one that was here cost a full extra round trip -- about a
    // second and 1600 tokens -- to rephrase text that was already fine. It also
    // made the same sentence read differently depending on whether the model was
    // reachable, which is the opposite of what a reminder should do.
    const nudges = ranked.nudges;

    const payload: NudgeSet & { elisionNotices: string[] } = {
      nudges,
      elisions: ranked.elisions,
      computedAt: new Date().toISOString(),
      basis: ranked.basis,
      elisionNotices: ranked.elisions.map((e) => elisionLine(e.person, e.since)),
    };
    return c.json(payload);
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/** Dismiss a nudge. The memory underneath survives, deliberately. */
app.post("/api/nudges/dismiss", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== "string" || !body.id) {
    return c.json({ error: "bad_request", message: "id is required." }, 400);
  }
  const existing = parseCookies(c.req.header("cookie")).pb_dismiss;
  const next = [...new Set([...(existing?.split(",").filter(Boolean) ?? []), body.id])].slice(-50);
  c.header("Set-Cookie", cookieHeader("pb_dismiss", next.join(","), 60 * 60 * 24 * 30));
  return c.json({ ok: true, dismissed: next.length });
});

/** Extracts candidate memories from a message. Nothing is written. */
/**
 * One turn of conversation: say something, have it remembered, get an answer.
 *
 * This is the app. Everything else in here exists to serve it.
 */
app.post("/api/chat", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;

  const body = (await c.req.json().catch(() => ({}))) as {
    message?: unknown;
    undoOf?: unknown;
    history?: unknown;
  };
  if (typeof body.message !== "string" || !body.message.trim()) {
    return c.json({ error: "bad_request", message: "message is required." }, 400);
  }
  const undoOf = Array.isArray(body.undoOf) ? body.undoOf.filter((v): v is string => typeof v === "string") : [];

  // The thread, so pronouns and follow-ups resolve. Bounded and shape-checked
  // because this is client input: capped to the last 20 turns, and anything that
  // is not a {role, text} pair is dropped rather than trusted.
  const history = Array.isArray(body.history)
    ? (body.history as unknown[])
        .filter(
          (t): t is { role: "you" | "assistant"; text: string } =>
            typeof t === "object" &&
            t !== null &&
            (t as { role?: unknown }).role !== undefined &&
            ["you", "assistant"].includes(String((t as { role?: unknown }).role)) &&
            typeof (t as { text?: unknown }).text === "string" &&
            String((t as { text?: unknown }).text).trim().length > 0,
        )
        .slice(-20)
        .map((t) => ({
          role: String(t.role) as "you" | "assistant",
          // Bounded per turn so a long transcript cannot be used to push the
          // extraction prompt past the model's context.
          text: String(t.text).slice(0, 2_000),
        }))
    : [];

  const turn = { store: resolved.store, message: body.message.trim(), undoOf, history };

  // Streaming when asked for it, JSON when not.
  //
  // Both paths exist deliberately: a browser wants tokens as they arrive, while
  // curl, the test suite and anything else scripted wants one parseable body. The
  // alternative -- streaming only -- means a failed turn cannot be read as an
  // error, which is exactly the failure that is hardest to debug.
  const wantsStream = (c.req.header("accept") ?? "").includes("text/event-stream");
  if (!wantsStream) {
    try {
      return c.json(await takeTurn(turn));
    } catch (error) {
      return toErrorResponse(c, error);
    }
  }

  const encoder = new TextEncoder();
  const send = (event: Record<string, unknown>) =>
    encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Sent before anything slow happens. Reading the ledger can take seconds,
        // and without this the browser shows a spinner with no explanation of what
        // it is waiting for.
        controller.enqueue(send({ type: "status", detail: "Reading your book" }));

        let opened = false;
        const result = await takeTurn(turn, {
          onDelta: (text) => {
            if (!opened) {
              opened = true;
              controller.enqueue(send({ type: "status", detail: "Thinking" }));
            }
            controller.enqueue(send({ type: "delta", text }));
          },
        });

        controller.enqueue(send({ type: "done", ...result }));
      } catch (error) {
        // Errors go down the same stream once it is open, because by this point
        // there is no status code left to change.
        const response = toErrorResponse(c, error);
        const payload = await response.json().catch(() => ({ error: "internal", message: String(error) }));
        controller.enqueue(send({ type: "error", ...(payload as Record<string, unknown>) }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Stops Vercel and nginx buffering the stream into one lump at the end,
      // which would defeat the entire point.
      "x-accel-buffering": "no",
      // Deliberately NO `connection: keep-alive`. It is a hop-by-hop header and is
      // forbidden in HTTP/2, which is what Vercel serves -- sending it can fail the
      // request outright, or be stripped. The framing is handled by the runtime.
      //
      // It was here because it is the reflex when a stream appears not to arrive,
      // and it worked locally over HTTP/1.1. On Vercel it is the kind of header
      // that turns a working endpoint into a 500.
    },
  });
});

/**
 * Undoes a memory this conversation saved.
 *
 * A tombstone, so it collapses in the ledger like any other revision rather than
 * leaving a hole. This is what makes silent saving defensible: the user never had
 * to confirm anything, and correcting it is one tap.
 */
app.post("/api/chat/undo", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;

  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== "string" || !body.id.trim()) {
    return c.json({ error: "bad_request", message: "id is required." }, 400);
  }

  try {
    const forgotten = await resolved.store.forget(body.id.trim());
    return c.json({ ok: true, id: forgotten.id });
  } catch (error) {
    if (error instanceof MemoryNotFoundError) {
      return c.json({ error: "not_found", message: "That memory is already gone." }, 404);
    }
    return toErrorResponse(c, error);
  }
});

app.post("/api/capture", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;

  const body = (await c.req.json().catch(() => ({}))) as { message?: unknown };
  if (typeof body.message !== "string" || !body.message.trim()) {
    return c.json({ error: "bad_request", message: "message is required." }, 400);
  }

  try {
    const { memories } = await resolved.store.listLive();
    const known = [...new Set(memories.map((m) => m.person))];
    const result = await capture(body.message, known);
    return c.json({
      ...result,
      // Echoed so the UI can explain WHY something was dropped.
      knownPeople: known,
    });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/**
 * Promotes a candidate into a memory.
 *
 * Only here does a candidate become stored, and it is stored as `confirmed`
 * because a person just looked at it. If the write fails, this returns an error
 * and stores nothing — a confirmation that does not persist would leave the user
 * believing their book knows something it does not.
 */
app.post("/api/memories", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const person = typeof body.person === "string" ? body.person.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const type = body.type;

  if (!person || !text) {
    return c.json({ error: "bad_request", message: "person and text are required." }, 400);
  }

  try {
    const memory = await resolved.store.remember({
      person,
      text,
      type: type as never,
      confidence: "confirmed",
      // The original sentence is opt-in. It is the most sensitive thing we hold,
      // so it is never stored unless the user explicitly asked.
      ...(typeof body.verbatim === "string" && body.verbatim.trim() ? { verbatim: body.verbatim.trim() } : {}),
      ...(typeof body.occurredAt === "string" ? { occurredAt: body.occurredAt } : {}),
      ...(typeof body.dueAt === "string" ? { dueAt: body.dueAt } : {}),
    });
    return c.json({ memory }, 201);
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/** Forgets a memory. Writes a tombstone; reports honestly if it did not land. */
app.delete("/api/memories/:id", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;
  try {
    const memory = await resolved.store.forget(c.req.param("id"));
    return c.json({ forgotten: memory.id, rev: memory.rev });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/** Closes a promise the user says they kept. */
app.post("/api/memories/:id/resolve", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;
  const body = (await c.req.json().catch(() => ({}))) as { status?: unknown };
  const status = body.status === "kept" || body.status === "missed" ? body.status : "settled";
  try {
    const current = await resolved.store.getById(c.req.param("id"));
    if (!current) return c.json({ error: "not_found", message: "No such memory." }, 404);
    const next = await resolved.store.revise(current, { status });
    return c.json({ memory: next });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/** The user's own timezone, if they set one. Used for every "today". */
async function userTimeZone(store: PeopleBookStore): Promise<string | undefined> {
  const memory = await store.getById("profile_timezone");
  if (!memory || memory.deleted === true) return undefined;
  return /^Is in the (.+) timezone\.$/.exec(memory.text)?.[1];
}

/**
 * The profile: what the assistant calls you, and a few standing facts.
 *
 * ── Why these are memories and not a settings table ───────────────────────────
 * Because they belong in the same place as everything else you told it. If your
 * name lives in a Postgres row and the rest of what the assistant knows lives in
 * your Walrus account, then exporting your book does not export you, and revoking
 * the key does not revoke the bit that knows your name. Both facts would be
 * trivially small and both would be worth having.
 *
 * So a profile field is a memory about "you", written deliberately rather than
 * extracted. Deliberately matters: everything else in the book arrives through
 * the model, which is right for facts you mentioned in passing and wrong for
 * something you typed into a form and expect to be obeyed.
 *
 * Writes are upserts against the previous value rather than appends. A profile
 * you change five times should not leave five claims about your name in the book
 * for the assistant to choose between -- and because every write is a revision of
 * the same id, the history still shows what it used to call you.
 */
const PROFILE_SLOTS = ["name", "pronouns", "timezone"] as const;
type ProfileSlot = (typeof PROFILE_SLOTS)[number];

/** Stable id per slot, so a rewrite revises rather than forks. */
const profileId = (slot: ProfileSlot) => `profile_${slot}`;

const profileClaim: Record<ProfileSlot, (value: string) => string> = {
  name: (v) => `Prefers to be called ${v}.`,
  pronouns: (v) => `Uses ${v} pronouns.`,
  timezone: (v) => `Is in the ${v} timezone.`,
};

/**
 * Reads the profile out of the book.
 *
 * By id rather than by scanning for wording. Scanning means the profile breaks
 * the moment someone says "call me Mateo" in conversation and the extractor
 * writes it as a plain trait -- which it will, because that is a legitimate thing
 * to say.
 */
async function readProfile(store: PeopleBookStore): Promise<Partial<Record<ProfileSlot, string>>> {
  const out: Partial<Record<ProfileSlot, string>> = {};
  for (const slot of PROFILE_SLOTS) {
    const memory = await store.getById(profileId(slot));
    if (memory && memory.deleted !== true) {
      const value = /^(.*)\.$/.exec(memory.text)?.[1];
      if (value) out[slot] = value;
    }
  }
  return out;
}

app.get("/api/profile", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;
  try {
    return c.json({ profile: await readProfile(resolved.store) });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

app.post("/api/profile", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    for (const slot of PROFILE_SLOTS) {
      if (!(slot in body)) continue;
      const raw = typeof body[slot] === "string" ? body[slot].trim() : "";
      const existing = await resolved.store.getById(profileId(slot));

      // Empty clears it. A tombstone rather than a delete, like everything else,
      // so clearing your name is itself part of the record.
      if (!raw) {
        if (existing) await resolved.store.forget(existing.id);
        continue;
      }
      const claim = profileClaim[slot](raw);
      if (existing) await resolved.store.revise(existing, { text: claim, status: "active" });
      else {
        await resolved.store.remember({
          id: profileId(slot),
          person: "you",
          type: "trait",
          text: claim,
          status: "active",
          // Typed by the user, not guessed. Confirmed, or it could never inform
          // a reply.
          confidence: "confirmed",
        });
      }
    }
    return c.json({ profile: await readProfile(resolved.store) });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/** Per-person brief. Taboos are withheld, and the withholding is announced. */
app.get("/api/people/:person", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;
  const person = decodeURIComponent(c.req.param("person"));
  try {
    const { memories } = await resolved.store.listLive();
    const theirs = memories.filter((m) => m.person === person);
    const taboos = theirs.filter((m) => m.type === "taboo" && m.confidence === "confirmed");
    const body = {
      person,
      traits: theirs.filter((m) => m.type === "trait" || m.type === "update"),
      events: theirs.filter((m) => m.type === "event"),
      promises: theirs.filter((m) => m.type === "promise"),
      howto: theirs.filter((m) => m.type === "howto"),
      // Taboo CONTENT is never returned. Only the fact that rules exist, and
      // when they were set, so the brief can honestly say it is withholding.
      tabooCount: taboos.length,
      taboosSince: taboos.map((t) => t.occurredAt ?? t.createdAt.slice(0, 10)).sort()[0] ?? null,
      elisionNotice: taboos.length
        ? elisionLine(person, taboos.map((t) => t.occurredAt ?? t.createdAt.slice(0, 10)).sort()[0] ?? "")
        : null,
    };
    return c.json(body);
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/** Everyone in the book, including the user themself. */
app.get("/api/people", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;
  try {
    const { memories } = await resolved.store.listLive();
    const people = [...new Set(memories.map((m) => m.person))].map((person) => {
      const theirs = memories.filter((m) => m.person === person);
      return {
        person,
        isSelf: person === SELF,
        count: theirs.length,
        openPromises: theirs.filter((m) => m.type === "promise" && m.status === "open").length,
        hasTaboo: theirs.some((m) => m.type === "taboo" && m.confidence === "confirmed"),
      };
    });
    people.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || b.count - a.count);
    return c.json({ people });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/** Everything, as JSON. Portability, and the thing a user is entitled to. */
app.get("/api/export", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;
  try {
    const { memories } = await resolved.store.listLive();
    const accountId = await findAccountId(resolved.address);
    c.header("Content-Disposition", 'attachment; filename="people-book.json"');
    return c.json({
      exportedAt: new Date().toISOString(),
      owner: resolved.address,
      memwalAccount: accountId,
      namespace: NAMESPACE,
      count: memories.length,
      memories,
    });
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

/**
 * Loads the demo cast.
 *
 * Fictional people, deliberately. A judge opening the app should see a book with
 * history, and that must not mean publishing real details about real people who
 * never agreed to be in a submission. The real app is used with real contacts;
 * the demo and the article are not.
 */
app.post("/api/demo/seed", async (c) => {
  const resolved = await resolveStore(c);
  if ("error" in resolved) return resolved.error;
  try {
    const { memories } = await resolved.store.listLive();
    if (memories.length > 0) {
      return c.json({
        error: "not_empty",
        message: `This book already has ${memories.length} memories. Seeding on top would muddy it — clear it first if you want the demo cast.`,
        existing: memories.length,
      }, 409);
    }
    // Bulk, verified twice inside seedBulk. A demo book that quietly half-wrote
    // would be worse than a visible failure: a judge would conclude the memory
    // does not work.
    const { written, failed } = await resolved.store.seedBulk(demoCast());
    if (failed.length > 0) {
      return c.json(
        {
          error: "partial_seed",
          message: `Seeded ${written.length} of ${demoCast().length}. These did not land: ${failed.join("; ")}. Run it again to fill the gaps.`,
          seeded: written.length,
          expected: demoCast().length,
          failed,
        },
        502,
      );
    }
    return c.json({ seeded: written.length }, 201);
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

app.get("/api/demo/cast-size", (c) => c.json({ count: demoCast().length }));

export default app;
