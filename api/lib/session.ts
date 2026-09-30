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
import { toBase64 } from "@mysten/sui/utils";

export const SESSION_COOKIE = "pb_session";

/** Sessions are long-lived but bounded — an unbounded cookie is a permanent credential. */
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const CHALLENGE_TEXT = "Sign in to People Book. This proves the address is yours.";

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

  const text = `${CHALLENGE_TEXT}\n\nAddress: ${address}\nNonce: ${nonce}`;
  return { token, message: text, bytes: encoder.encode(text) };
}

export type ChallengeFailure =
  | "unknown_challenge"
  | "expired"
  | "bad_signature"
  | "address_mismatch";

export type RedeemResult =
  | { ok: true; address: string }
  | { ok: false; reason: ChallengeFailure };

/**
 * Consumes a challenge and verifies the signature against it.
 *
 * Single-use on every outcome, not just success — that is what stops a captured
 * signature being replayed to mint sessions. The address is passed as
 * `options.address`, so one call both checks the signature and binds it to the
 * address we intended to sign in, offline, with no RPC round trip.
 */
export async function redeemChallenge(token: string, signature: string): Promise<RedeemResult> {
  const record = challenges.get(token);
  if (!record) return { ok: false, reason: "unknown_challenge" };
  challenges.delete(token);

  if (Date.now() - record.issuedAt > CHALLENGE_TTL_MS) {
    return { ok: false, reason: "expired" };
  }

  const text = `${CHALLENGE_TEXT}\n\nAddress: ${record.address}\nNonce: ${record.nonce}`;

  let valid = false;
  try {
    valid = await isValidPersonalMessageSignature(encoder.encode(text), signature, {
      address: record.address,
    });
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  return { ok: true, address: record.address };
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
