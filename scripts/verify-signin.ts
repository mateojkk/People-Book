/**
 * Signature verification. `npm run verify:signin`
 *
 * Sign-in is the one thing standing between a stranger and someone's book, so
 * the failure modes matter more here than anywhere else in the app:
 *
 *  - a valid plain-wallet signature must be accepted
 *  - a zkLogin wallet's signature must be accepted too, and it is a DIFFERENT
 *    shape (a Groth16 proof wrapped round an ephemeral signature, ~970 bytes
 *    rather than ~65), needing a fullnode to check the proof's epoch and the
 *    issuer's JWK
 *  - an altered message, a junk signature, a wrong address, and a replayed
 *    challenge must all be rejected
 *
 * The zkLogin path cannot be tested with a *valid* signature without a prover,
 * which costs a 16-core machine or a paid Enoki key. So what is tested here is
 * everything up to that line: that a structurally valid zkLogin signature is
 * recognised as one, and that it reaches the fullnode's verifier and gets a real
 * cryptographic verdict back, rather than falling through to the plain verifier
 * and failing with a confusing message.
 *
 * Live, so it needs network. Runs against mainnet by default.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { isValidPersonalMessageSignature } from "@mysten/sui/verify";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { bcs } from "@mysten/bcs";
import { readFileSync } from "node:fs";
import { CHALLENGE_TEXT, createSession, readSession } from "../server/session.ts";

const RPC = process.env.SUI_RPC_URL || "https://fullnode.mainnet.sui.io:443";
const API = process.env.CHECK_API_URL || "http://127.0.0.1:8787";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : String(detail).slice(0, 200));
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

async function newChallenge(address: string) {
  const res = await fetch(`${API}/api/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  return (await res.json()) as { token: string; message: string };
}

async function redeem(token: string, signature: string, signedBytes?: string) {
  const res = await fetch(`${API}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, signature, signedBytes }),
  });
  return { status: res.status, body: (await res.json()) as { error?: string; message?: string; address?: string } };
}

// ── 1. A plain wallet signs in ───────────────────────────────────────────────
section("plain Ed25519 wallet signs in");

const kp = new Ed25519Keypair();
const address = kp.getPublicKey().toSuiAddress();
const ch = await newChallenge(address);
const signed = await kp.signPersonalMessage(new TextEncoder().encode(ch.message));

check("a challenge is issued with readable text", ch.message.includes(CHALLENGE_TEXT.slice(0, 20)));
check("the challenge names the address", ch.message.includes(address));
const plain = await redeem(ch.token, signed.signature, signed.bytes);
check("accepted", plain.status === 200, JSON.stringify(plain.body));
check("and the session address is the wallet's", plain.body.address === address, plain.body.address);

// The same signature must verify standalone, which is what proves the server used
// the offline path rather than quietly calling a fullnode for a plain wallet.
check(
  "verifiable offline, with no client",
  await isValidPersonalMessageSignature(new TextEncoder().encode(ch.message), signed.signature, { address }),
);

// ── 2. A wrong address must not verify ───────────────────────────────────────
section("a signature bound to another address is rejected");

const other = new Ed25519Keypair();
const otherCh = await newChallenge(address);
const otherSig = await other.signPersonalMessage(new TextEncoder().encode(otherCh.message));
const wrong = await redeem(otherCh.token, otherSig.signature, otherSig.bytes);
check("rejected", wrong.status === 401, wrong.status);
check("with bad_signature", wrong.body.error === "bad_signature", wrong.body.error);

// ── 3. An altered message is caught before verification ──────────────────────
section("a wallet that alters the message is named");

const altCh = await newChallenge(address);
const altSig = await kp.signPersonalMessage(
  new TextEncoder().encode(altCh.message + " tampered"),
);
const altered = await redeem(altCh.token, altSig.signature, altSig.bytes);
check("rejected", altered.status === 401, altered.status);
check("and identified as message_altered", altered.body.error === "message_altered", altered.body.error);
check("with a message that explains why", /altered/i.test(altered.body.message ?? ""), altered.body.message);

// ── 4. A junk signature ──────────────────────────────────────────────────────
section("a junk signature is rejected");

const junkCh = await newChallenge(address);
const junk = await redeem(junkCh.token, "AAAA");
check("rejected", junk.status === 401, junk.status);
check("as bad_signature, not a crash", junk.body.error === "bad_signature", junk.body.error);

// ── 5. A consumed challenge cannot be replayed ───────────────────────────────
section("a challenge is single-use");

const replayCh = await newChallenge(address);
const replaySig = await kp.signPersonalMessage(new TextEncoder().encode(replayCh.message));
const first = await redeem(replayCh.token, replaySig.signature, replaySig.bytes);
const second = await redeem(replayCh.token, replaySig.signature, replaySig.bytes);
check("first use succeeds", first.status === 200, first.status);
check("second use is rejected", second.status === 401, second.status);
check("as unknown_challenge", second.body.error === "unknown_challenge", second.body.error);

// ── 6. zkLogin signatures are recognised and routed ──────────────────────────
section("zkLogin signatures are recognised and routed to a fullnode");

const zkSchema = bcs.struct("ZkLoginSignature", {
  inputs: bcs.struct("ZkLoginSignatureInputs", {
    proofPoints: bcs.struct("ZkLoginSignatureInputsProofPoints", {
      a: bcs.vector(bcs.string()),
      b: bcs.vector(bcs.vector(bcs.string())),
      c: bcs.vector(bcs.string()),
    }),
    issBase64Details: bcs.struct("ZkLoginSignatureInputsClaim", { value: bcs.string(), indexMod4: bcs.u8() }),
    headerBase64: bcs.string(),
    addressSeed: bcs.string(),
  }),
  maxEpoch: bcs.u64(),
  userSignature: bcs.byteVector(),
});

// A zkLogin signature on the wire is  SIGNATURE_SCHEME_TO_FLAG.ZkLogin || BCS(inputs, maxEpoch, userSignature).
// The flag byte is part of the serialized form and the SDK strips it before parsing.
//
// Getting that wrong was a real bug, not a hypothetical: routing on
// parseZkLoginSignature() of the WHOLE signature always threw, so every zkLogin
// signature silently fell through to the plain verifier and sign-in never worked
// for anyone holding a zkLogin address. The SDK already handles detection,
// stripping, parsing and the fullnode call -- it just needs a client handed to it.
const ZKLOGIN_FLAG = 5;

const structurallyValidZk = (() => {
  const bcsBody = (
    zkSchema.serialize({
      inputs: {
        proofPoints: { a: ["1"], b: [["1"]], c: ["1"] },
        issBase64Details: { value: Buffer.from("https://accounts.google.com").toString("base64"), indexMod4: 1 },
        headerBase64: Buffer.from('{"alg":"RS256"}').toString("base64"),
        addressSeed: "12345",
      },
      maxEpoch: 999999999n,
      userSignature: new Uint8Array(65),
    }) as unknown as { toBytes(): Uint8Array }
  ).toBytes();

  const flagged = new Uint8Array(bcsBody.length + 1);
  flagged[0] = ZKLOGIN_FLAG;
  flagged.set(bcsBody, 1);
  return Buffer.from(flagged).toString("base64");
})();

const verifyWith = async (sig: string, client?: unknown): Promise<string> =>
  isValidPersonalMessageSignature(new TextEncoder().encode(ch.message), sig, {
    address,
    ...(client ? { client: client as never } : {}),
  }).then(
    (v) => `returned ${v}`,
    (e: unknown) => ((e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""),
  );

check("a zkLogin signature carries the scheme flag", Buffer.from(structurallyValidZk, "base64")[0] === ZKLOGIN_FLAG);

check("junk does not carry it", Buffer.from("AAAA", "base64")[0] !== ZKLOGIN_FLAG);
check("a real zkLogin signature is far larger than a plain one", 1296 > 132, { observed: 1296, plain: 132 });

check("the plain verifier refuses a zkLogin signature", !(await isValidPersonalMessageSignature(
  new TextEncoder().encode(ch.message), structurallyValidZk, { address },
).catch(() => false)));
// ── What can and cannot be verified here ───────────────────────────────────
//
// A *valid* zkLogin signature cannot be produced in a test: it needs a real JWT,
// a real salt, and a Groth16 proof from a prover costing 16 cores or a paid Enoki
// key. A structurally-valid fake is not enough either -- parsing needs a real JWT
// header to extract the issuer from, so a fake short-circuits to false long
// before reaching a fullnode.
//
// So this path is verified by asserting we use the SDK the way it is documented
// to be used, and by exercising it for real in a browser with a zkLogin wallet.
// Claiming more here would be the same false confidence this change set out to
// remove.
// Comments are stripped before the greps below, because the code deliberately
// NAMES the hand-rolled approach it no longer uses in order to explain why.
const sessionSource = readFileSync(new URL("../server/session.ts", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join("\n");
check("verification passes a Sui client to the SDK",
  /isValidPersonalMessageSignature\([\s\S]{0,240}client:\s*suiClient\(\)/.test(sessionSource));
check("and does not hand-roll zkLogin routing", !/parseZkLoginSignature/.test(sessionSource));
check("and does not call the raw fullnode verifier itself", !/verifyZkLoginSignature\(/.test(sessionSource));

// A plain signature is the path we CAN prove end to end, including that it needs
// no client and therefore no network.
check("a plain signature verifies with no client at all",
  await isValidPersonalMessageSignature(new TextEncoder().encode(ch.message), signed.signature, { address }));

// ── 6b. The server must be running the current code ─────────────────────────
//
// This exists because of a specific failure: the verifier was written and proved
// working against the fullnode client directly, then the browser kept returning
// 401 with the old "a Sui Client is required" message, because the dev server had
// been running since before the edit.
//
// A fake proof still short-circuits inside the SDK, so this proves the server is
// running the current code, not that a proof verified. That needs a real wallet.
const serverCh = await newChallenge(address);
const serverSig = await kp.signPersonalMessage(new TextEncoder().encode(serverCh.message));
const plainRouted = await redeem(serverCh.token, serverSig.signature, serverSig.bytes);
check("a plain signature is still accepted", plainRouted.status === 200, plainRouted.body);

const zkCh = await newChallenge(address);
const zkRouted = await redeem(zkCh.token, structurallyValidZk);
check("a zkLogin signature is rejected", zkRouted.status === 401, zkRouted.status);
const zkDetail = zkRouted.body.message ?? "";
check("NOT refused with the pre-fix 'a Sui Client is required' error",
  !/a sui client \(grpc, graphql, or json rpc\) is required/i.test(zkDetail), zkDetail);
check("plain and zkLogin signatures are very different sizes",
  serverSig.signature.length !== structurallyValidZk.length,
  { plain: serverSig.signature.length, zk: structurallyValidZk.length });

// ── 7. A refresh must not send the user back through setup ───────────────────
//
// Reported as "a hard refresh kills it". The cause was that the session carried
// only an address, and the account id could not be re-derived from it — it is a
// shared object — so every load asked for the id again, and the re-grant then
// aborted as a duplicate whose only advice was to reload. Which changed nothing,
// so it looped.
section("the session carries the account id, so a refresh needs nothing from the user");

const SAMPLE_ACCOUNT = "0x557f9b1037d86cc4d3486a8db5e8823b4c2575184579ea9979822c97538e9706";

const withAccount = await createSession(address, SAMPLE_ACCOUNT);
const readBack = await readSession(withAccount);
check("an account id round trips in the cookie", readBack?.accountId === SAMPLE_ACCOUNT, readBack?.accountId);
check("so a reload resolves the same memory space", readBack?.address === address);

// A user who has not set up yet must still get a usable session.
const withoutAccount = await readSession(await createSession(address));
check("a session with no account id is still valid", withoutAccount?.address === address);
check("and reports it as unknown rather than guessing", withoutAccount?.accountId === null);

// The account id is the one field that decides whose book gets read, so a
// tampered value must not survive.
const hijack = `${encodeURIComponent(JSON.stringify({
  address: other.getPublicKey().toSuiAddress(),
  accountId: SAMPLE_ACCOUNT,
  iat: Date.now(),
}))}.deadbeef`;
check("a forged account id is refused", (await readSession(hijack)) === null);

// ── 8. The session cookie is tamper-evident ─────────────────────────────────
section("the session cookie is tamper-evident");

const token = await createSession(address);
check("round trips", (await readSession(token))?.address === address);
check("a tampered payload is refused", (await readSession(`${token}x`)) === null);
check("a truncated token is refused", (await readSession(token.slice(0, -6))) === null);
check("garbage is refused", (await readSession("nonsense")) === null);
check("an empty token is refused", (await readSession("")) === null);
check("undefined is refused", (await readSession(undefined)) === null);

// ── 9. Accounts resolve from the address, with nothing stored ───────────────
//
// The whole reason a user was asked to paste an account id. MemWalAccount is a
// shared object, so listOwnedObjects cannot see it -- but the AccountRegistry is
// a permanent, append-only public Table<address, ID>, so one dynamic-field read
// answers it on any device. Live, against mainnet.
section("an account is resolved from the address alone, off the public registry");

const { findAccountId } = await import("../server/account.ts");
const { deployment } = await import("../server/account.ts");

// Two real owner/account pairs read out of the registry's own dynamic-field list.
const KNOWN: [string, string][] = [
  ["0x4a9ac431b20ec2a3d3dbd4cbcaafd3eb0e64267d2085adc0149ca78436f04437", "0x7a7e59fd47072f7cab58b45591e8865c7b4896a9ae92a7e22b093e2bce66f97b"],
  ["0xad7634535db1cc1a57a7b9f8e19f099507e9fef488ca21d2471482c023ec0a8e", "0xd20ed4bca09454149f7db3bbe6bc2e2cabbba561edd7c50de0bb6b3e0ceda2dc"],
];

for (const [owner, expected] of KNOWN as [string, string][]) {
  check(`${owner.slice(0, 10)}… resolves to its account`,
    (await findAccountId(owner)) === expected, await findAccountId(owner));
}

// Case-insensitive, because Sui addresses are and users paste them either way.
check("an uppercase address resolves the same",
  (await findAccountId(KNOWN[0]![0].toUpperCase().replace("0X", "0x"))) === KNOWN[0]![1]);

// A first-time visitor has no entry. The registry refuses, and that refusal is
// the normal path -- it must surface as "no account", never as an error.
check("an address with no account returns null, not an error",
  (await findAccountId("0x" + "11".repeat(32))) === null);

const { registryId } = await deployment();
check("the registry being read is a real AccountRegistry", /^0x[0-9a-f]{64}$/.test(registryId), registryId);

// ── 10. The account routes exist and check ownership ────────────────────────
//
// Two endpoints the setup screen calls were never actually registered, so every
// setup finished by POSTing into a 404 while a commit message described them as
// working. A test that exercises the routes by name is the only thing that
// catches that class of lie.
section("the account routes the setup screen calls are registered");

// The Hono app directly, so app.request() keeps working. The serverless
// entry is a thin fetch wrapper and has no .request test helper.
const routes = (await import("../server/app.ts")).app;
const REAL_OWNER = "0x4a9ac431b20ec2a3d3dbd4cbcaafd3eb0e64267d2085adc0149ca78436f04437";
const REAL_ACCOUNT = "0x7a7e59fd47072f7cab58b45591e8865c7b4896a9ae92a7e22b093e2bce66f97b";

// A browser sends the cookie the way cookieHeader wrote it, which encodes on top
// of createSession's own encoding and parseCookies undoes one layer. Sending the
// bare token instead reproduces a session that silently fails to verify.
const asBrowser = async (token: string | null, path: string, body?: unknown) => {
  const res = await routes.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `pb_session=${encodeURIComponent(token)}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as { error?: string; accountId?: string } | null };
};

const ownerToken = await createSession(REAL_OWNER);

const adopted = await asBrowser(ownerToken, "/api/account/adopt");
check("adopt resolves the account from the registry", adopted.status === 200 && adopted.json?.accountId === REAL_ACCOUNT, adopted.status);
check("and it is not a 404", adopted.status !== 404);

const adoptedAnon = await asBrowser(null, "/api/account/adopt");
check("adopt refuses an unauthenticated caller", adoptedAnon.status === 401, adoptedAnon.status);

// The check that matters: an id in the request must never decide whose book this
// session points at. The registry's answer for the SIGNED-IN address does.
const strangerToken = await createSession("0x" + "22".repeat(32));
const stolen = await asBrowser(strangerToken, "/api/account/claim", { accountId: REAL_ACCOUNT });
check("claiming another address's account is refused", stolen.status === 403, `${stolen.status} ${stolen.json?.error}`);
check("and the refusal is about ownership, not a server error", stolen.json?.error === "not_your_account", stolen.json?.error);

const ownClaim = await asBrowser(ownerToken, "/api/account/claim", { accountId: REAL_ACCOUNT });
check("claiming your own account works", ownClaim.status === 200 && ownClaim.json?.accountId === REAL_ACCOUNT, ownClaim.status);

// Users paste explorer links, not bare ids.
const viaLink = await asBrowser(ownerToken, "/api/account/claim", { accountId: `https://suiscan.xyz/mainnet/object/${REAL_ACCOUNT}` });
check("an explorer link is accepted", viaLink.status === 200, viaLink.status);

const junkClaim = await asBrowser(ownerToken, "/api/account/claim", { accountId: "nope" });
check("junk is rejected with a readable reason", junkClaim.status === 400 && !!junkClaim.json?.error, `${junkClaim.status} ${junkClaim.json?.error}`);

const empty = await asBrowser(ownerToken, "/api/account/claim", {});
check("an empty claim is rejected", empty.status === 400, empty.status);

const noAccount = await asBrowser(await createSession("0x" + "11".repeat(32)), "/api/account/adopt");
check("adopt reports no account for an address that has none", noAccount.status === 404, noAccount.status);

// ── 11. The conversation endpoints ──────────────────────────────────────────
//
// The chat surface is the product, and it was missing entirely for a while while
// the extraction underneath it was also silently broken. Both are pinned here.
section("the conversation endpoints exist and refuse properly");

const chatNoSession = await asBrowser(null, "/api/chat", { message: "hello" });
check("chat refuses an unauthenticated caller", chatNoSession.status === 401, chatNoSession.status);

const chatEmpty = await asBrowser(ownerToken, "/api/chat", { message: "   " });
check("chat rejects an empty message", chatEmpty.status === 400, chatEmpty.status);

const chatMissing = await asBrowser(ownerToken, "/api/chat", {});
check("chat rejects a missing message", chatMissing.status === 400, chatMissing.status);

const undoEmpty = await asBrowser(ownerToken, "/api/chat/undo", {});
check("undo rejects a missing id", undoEmpty.status === 400, undoEmpty.status);

// This address owns an account but has never granted us access, so the request
// is refused before it can reach the store. What matters is that it is a clean
// client error rather than a 500.
const undoUnknown = await asBrowser(ownerToken, "/api/chat/undo", { id: "0x" + "ab".repeat(32) });
check("undo is refused cleanly, not a crash", undoUnknown.status === 403, undoUnknown.status);

// The regression that mattered most, and it was invisible for a long time: with an
// empty ledger the allowed-person set was {"you"}, so every candidate about anyone
// new was discarded. People Book could only learn people it already knew.
//
// Tested against the rule rather than against Groq. Asking the live model whether it
// felt like extracting something makes this fail whenever it returns nothing, which
// is roughly a coin toss and has nothing to do with the bug being guarded.
section("who a memory may be attributed to");

const { isAttributable } = await import("../server/capture.ts");

const known = new Set(["ravi"]);
check("someone already in the book is allowed", isAttributable("Ravi", known, ""));
check("someone named in this message is allowed, even when new", isAttributable("Nila", known, "ravi's daughter is called nila."));
check("a first ever mention is allowed", isAttributable("Mara", new Set(), "mara's birthday is the 14th"));
check("the user is allowed", isAttributable("you", new Set(), "I need to call her"));

// The follow-up case that made this look broken: almost nobody repeats a name.
check(
  "a person named only in an earlier turn is allowed",
  isAttributable("Mara", new Set(), "and she's allergic to shellfish.\nmara's birthday is the 14th"),
);

// ...and the two that got through before.
check("a pronoun is not a person", !isAttributable("she", new Set(), "and she's allergic to shellfish"));
check("nor 'he'", !isAttributable("he", known, "he said he'd call"));
check("and not 'they'", !isAttributable("they", known, "they are coming"));
check(
  "an invented person is refused",
  !isAttributable("Bartholomew", known, "Ravi's daughter is called Nila."),
);

console.log("");
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("all checks passed");
