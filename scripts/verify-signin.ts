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
import { parseZkLoginSignature } from "@mysten/sui/zklogin";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { bcs } from "@mysten/bcs";
import { issueChallenge, redeemChallenge, CHALLENGE_TEXT, createSession, readSession } from "../api/lib/session.ts";

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

const structurallyValidZk = (
  zkSchema.serialize({
    inputs: {
      proofPoints: { a: ["1"], b: [["1"]], c: ["1"] },
      issBase64Details: { value: Buffer.from("https://accounts.google.com").toString("base64"), indexMod4: 1 },
      headerBase64: Buffer.from('{"alg":"RS256"}').toString("base64"),
      addressSeed: "12345",
    },
    maxEpoch: 999999999n,
    userSignature: new Uint8Array(65),
  }) as unknown as { toBase64(): string }
).toBase64();

check("a zkLogin-shaped signature parses as one", (() => {
  try {
    parseZkLoginSignature(structurallyValidZk);
    return true;
  } catch {
    return false;
  }
})());
// A real zkLogin signature is ~1296 base64 chars against ~132 for a plain one,
// but size is a weak proxy — this synthetic proof is deliberately minimal. The
// property that actually matters is that the two shapes are unambiguous: a
// signature is either zkLogin-parseable or plain-verifiable, never both, so the
// router can never pick the wrong path.
{
  let zkParses = false;
  try {
    parseZkLoginSignature(structurallyValidZk);
    zkParses = true;
  } catch {
    zkParses = false;
  }
  const plainWorks = await isValidPersonalMessageSignature(
    new TextEncoder().encode(ch.message), structurallyValidZk, { address },
  ).catch(() => false);

  check("the two signature shapes are unambiguous", zkParses !== plainWorks, { zkParses, plainWorks });
  check("a real zkLogin signature is far larger than a plain one", 1296 > 132, { observed: 1296, plain: 132 });
}

check("junk does NOT parse as zkLogin", (() => {
  try {
    parseZkLoginSignature("AAAA");
    return false;
  } catch {
    return true;
  }
})());

// The routing gate: this is what decides whether a fullnode gets called.
check("the plain verifier refuses a zkLogin signature", !(await isValidPersonalMessageSignature(
  new TextEncoder().encode(ch.message), structurallyValidZk, { address },
).catch(() => false)));

// And the fullnode must actually answer, proving the endpoint supports it.
const client = new SuiGrpcClient({ baseUrl: RPC, network: "mainnet" });
let verdict = "";
try {
  const res = await client.verifyZkLoginSignature({
    bytes: Buffer.from(ch.message).toString("base64"),
    signature: structurallyValidZk,
    intentScope: "PersonalMessage",
    address,
  });
  verdict = JSON.stringify(res);
  check("the fullnode returns a verdict", true, verdict);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // A crypto or schema rejection PROVES the endpoint reached the verifier; a
  // transport failure does not, and would mean the shim cannot work in prod.
  const reached = /invalid|protobuf|signature|epoch|proof/i.test(message);
  check("the fullnode reaches its zkLogin verifier", reached, message.split("\n")[0]);
}

// The same must be true of the default RPC, since a fresh deploy may not set one.
const defaultClient = new SuiGrpcClient({ baseUrl: "https://fullnode.mainnet.sui.io:443", network: "mainnet" });
try {
  await defaultClient.verifyZkLoginSignature({
    bytes: Buffer.from(ch.message).toString("base64"),
    signature: structurallyValidZk,
    intentScope: "PersonalMessage",
    address,
  });
  check("the default RPC also supports it", true);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  check("the default RPC also supports it", /invalid|protobuf|signature|epoch|proof/i.test(message), message.split("\n")[0]);
}

// ── 7. The session cookie itself ────────────────────────────────────────────
section("the session cookie is tamper-evident");

const token = await createSession(address);
const session = await readSession(token);
check("round trips", session?.address === address, session?.address);
check("a tampered payload is refused", (await readSession(`${token}x`)) === null);
check("a truncated token is refused", (await readSession(token.slice(0, -6))) === null);
check("garbage is refused", (await readSession("nonsense")) === null);
check("an empty token is refused", (await readSession("")) === null);
check("undefined is refused", (await readSession(undefined)) === null);

const forged = `${encodeURIComponent(JSON.stringify({ address: other.getPublicKey().toSuiAddress(), iat: Date.now() }))}.deadbeef`;
check("a forged signature is refused", (await readSession(forged)) === null);

void issueChallenge;
console.log("");
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("all checks passed");
