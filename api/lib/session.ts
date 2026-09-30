/**
 * Session handling: a signed challenge, then an httpOnly cookie.
 *
 * Why a challenge at all. dApp Kit's `ConnectButton` tells us which address the
 * user picked, but on its own that is a claim, not a proof — anyone can post
 * anyone's address to our API. So the user signs a server-issued challenge and
 * we verify the signature against that exact address before writing anything.
 * Without it, "your memory is yours" would be a sentence about a value we
 * accepted from a request body.
 *
 * The cookie carries only the verified address. It is HMAC-signed with
 * SESSION_SECRET so it cannot be edited client-side, and httpOnly so client
 * script cannot read it at all.
 */

import { isValidPersonalMessageSignature } from "@mysten/sui/verify";
import { parseZkLoginSignature } from "@mysten/sui/zklogin";
import { suiClient } from "./account.ts";
import { toBase64, fromBase64 } from "@mysten/sui/utils";

export const SESSION_COOKIE = "pb_session";

/** Sessions are long-lived but bounded — an unbounded cookie is a permanent credential. */
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Exported so the sign-in test can assert the challenge names this app and not another. */
export const CHALLENGE_TEXT = "Sign in to People Book. This proves the address is yours.";

export class SessionConfigError extends Error {
  readonly code = "session_config_missing";
  constructor() {
    super("SESSION_SECRET is not set. Generate one with `openssl rand -hex 32` and put it in .env.");
    this.name = "SessionConfigError";
  }
}

const encoder = new TextEncoder();

function secretMaterial(): string {
  const hex = process.env.SESSION_SECRET;
  if (!hex || hex.length < 32) throw new SessionConfigError();
  return hex;
}

// ─── HMAC ────────────────────────────────────────────────────────────────────

async function mac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretMaterial()) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toBase64(new Uint8Array(sig));
}

/** Constant-time-ish compare: always walk the whole string, never early-return. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── Challenge ───────────────────────────────────────────────────────────────

interface ChallengeRecord {
  nonce: string;
  address: string;
  issuedAt: number;
}

/**
 * Issued challenges, held in memory and never persisted. A challenge is
 * single-use with a five-minute life, so there is nothing to gain from writing
 * it to disk — and an in-memory map cannot be replayed after a cold start.
 *
 * Consequence of holding them in memory: a serverless cold start between issue
 * and sign-in loses the challenge and the user retries. That is a correct
 * trade against writing a replayable credential to disk.
 */
const challenges = new Map<string, ChallengeRecord>();

function pruneChallenges(): void {
  const cutoff = Date.now() - CHALLENGE_TTL_MS;
  for (const [token, record] of challenges) {
    if (record.issuedAt < cutoff) challenges.delete(token);
  }
}

/** The one place the challenge text is built. Issue and verify must agree exactly. */
function expectedMessage(record: { address: string; nonce: string }): string {
  return `${CHALLENGE_TEXT}\n\nAddress: ${record.address}\nNonce: ${record.nonce}`;
}

export interface ChallengePayload {
  token: string;
  /** Base64. Shown to the user so the sign-in is legible rather than a blank prompt. */
  message: string;
  /** Exactly the bytes the wallet must sign. */
  bytes: Uint8Array;
}

export function issueChallenge(address: string): ChallengePayload {
  pruneChallenges();
  const nonce = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  const token = crypto.randomUUID();
  challenges.set(token, { nonce, address, issuedAt: Date.now() });

  const text = expectedMessage({ address, nonce });
  return { token, message: text, bytes: encoder.encode(text) };
}

export type ChallengeFailure =
  | "unknown_challenge"
  | "expired"
  | "bad_signature"
  | "address_mismatch"
  | "message_altered";

export type RedeemResult =
  | { ok: true; address: string }
  | { ok: false; reason: ChallengeFailure; detail?: string };

/**
 * Verifies a signature over the challenge bytes.
 *
 * Two signature shapes reach this, and they need different verifiers:
 *
 *  - A plain Ed25519 signature, from an ordinary Sui wallet. Verified offline in
 *    one call, binding the signature to the address at the same time.
 *
 *  - A zkLogin signature, from a wallet holding a zkLogin address. That is a
 *    Groth16 proof plus an ephemeral signature, so it cannot be checked without
 *    asking a fullnode whether the proof is still inside its valid epoch and
 *    whether the issuer's JWK still matches. The SDK says so plainly: "A Sui
 *    Client is required to verify zkLogin signatures."
 *
 * The plain path is tried first because it is offline and cheap. The zkLogin path
 * is only taken when the signature actually parses as one, so a garbage signature
 * does not cause a pointless network round trip.
 *
 * Note the honesty cost of the second path: verifying a zkLogin signature is not
 * offline. See README > "Verified offline".
 */
async function verifyChallengeSignature(
  message: Uint8Array,
  signature: string,
  address: string,
): Promise<{ ok: true } | { ok: false; detail: string; needsClient: boolean }> {
  // 1. Plain Ed25519 — offline, and it binds the address in the same call.
  try {
    const valid = await isValidPersonalMessageSignature(message, signature, { address });
    if (valid) return { ok: true };
    return { ok: false, detail: "Signature is well-formed but does not recover to this address.", needsClient: false };
  } catch (error) {
    const message_ = error instanceof Error ? error.message : String(error);
    // Only a signature that parses as zkLogin gets the network path. Anything
    // else is a genuine bad signature and should not cost a round trip.
    let isZkLogin = false;
    try {
      parseZkLoginSignature(signature);
      isZkLogin = true;
    } catch {
      isZkLogin = false;
    }
    if (!isZkLogin) return { ok: false, detail: message_, needsClient: false };
  }

  // 2. zkLogin — needs a fullnode to check the proof's epoch and the issuer JWK.
  const response = await suiClient().verifyZkLoginSignature({
    bytes: toBase64(message),
    signature,
    intentScope: "PersonalMessage",
    address,
  });
  if (response.success) return { ok: true };
  return {
    ok: false,
    detail: `zkLogin signature rejected: ${response.errors.join("; ") || "no reason given"}`,
    needsClient: true,
  };
}

/**
 * Consumes a challenge and verifies the signature against it.
 *
 * Single-use on every outcome, not just success — that is what stops a captured
 * signature being replayed to mint sessions.
 *
 * `signedBytesBase64` is what the WALLET says it signed. Wallets are supposed to
 * sign the exact bytes handed to them, but some normalise whitespace or re-encode
 * the string, and then a perfectly valid signature fails against our
 * reconstruction for reasons that are invisible from the outside. Verifying
 * against the wallet's own bytes, and separately checking those bytes are a
 * faithful copy of the challenge, turns "your signature did not verify" into
 * either a working sign-in or a specific, fixable reason.
 */
export async function redeemChallenge(
  token: string,
  signature: string,
  signedBytesBase64?: string,
): Promise<RedeemResult> {
  const record = challenges.get(token);
  if (!record) return { ok: false, reason: "unknown_challenge" };
  challenges.delete(token);

  if (Date.now() - record.issuedAt > CHALLENGE_TTL_MS) {
    return { ok: false, reason: "expired" };
  }

  const expected = encoder.encode(expectedMessage(record));

  // Compare what the wallet claims to have signed against what we asked it to
  // sign. Length plus a full XOR walk, so a mismatch anywhere is caught.
  if (signedBytesBase64) {
    let signed: Uint8Array;
    try {
      signed = fromBase64(signedBytesBase64);
    } catch {
      return { ok: false, reason: "bad_signature", detail: "The wallet returned unreadable message bytes." };
    }
    if (!sameBytes(signed, expected)) {
      return {
        ok: false,
        reason: "message_altered",
        detail: `The wallet signed ${signed.length} bytes but the challenge is ${expected.length}. It appears to have altered the message before signing.`,
      };
    }
  }

  let verdict: Awaited<ReturnType<typeof verifyChallengeSignature>>;
  try {
    verdict = await verifyChallengeSignature(expected, signature, record.address);
  } catch (error) {
    return {
      ok: false,
      reason: "bad_signature",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!verdict.ok) return { ok: false, reason: "bad_signature", detail: verdict.detail };

  return { ok: true, address: record.address };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

// ─── Session cookie ──────────────────────────────────────────────────────────

export async function createSession(address: string): Promise<string> {
  const payload = encodeURIComponent(JSON.stringify({ address, iat: Date.now() }));
  return `${payload}.${await mac(payload)}`;
}

export async function readSession(token: string | undefined): Promise<{ address: string } | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;

  const payload = token.slice(0, dot);
  let expected: string;
  try {
    expected = await mac(payload);
  } catch (error) {
    if (error instanceof SessionConfigError) throw error;
    return null;
  }
  if (!safeEqual(token.slice(dot + 1), expected)) return null;

  try {
    const parsed = JSON.parse(decodeURIComponent(payload)) as { address?: unknown; iat?: unknown };
    if (typeof parsed.address !== "string" || !parsed.address) return null;
    if (typeof parsed.iat !== "number") return null;
    if (Date.now() - parsed.iat > SESSION_TTL_MS) return null;
    return { address: parsed.address };
  } catch {
    return null;
  }
}

// ─── Cookies ─────────────────────────────────────────────────────────────────

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export function cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    // Lax rather than Strict: the session must survive an OAuth-style return or
    // an inbound link, which Strict would drop.
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  // Secure is omitted in dev so the cookie works over plain http on localhost.
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function clearCookieHeader(name: string): string {
  return cookieHeader(name, "", 0);
}

/** Reads the verified address from a request's cookies, or null. */
export async function sessionAddressFrom(
  cookieHeaderValue: string | undefined,
): Promise<string | null> {
  const token = parseCookies(cookieHeaderValue)[SESSION_COOKIE];
  const session = await readSession(token);
  return session?.address ?? null;
}
