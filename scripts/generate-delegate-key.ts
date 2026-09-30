/**
 * Generates the app's delegate key. `npm run keygen`
 *
 * Prints a value to put in `.env` as MEMWAL_DELEGATE_KEY.
 *
 * What this key IS: a 32-byte Ed25519 seed that gets registered, by each user,
 * into their own MemWalAccount. It is scoped to them and revocable by them.
 *
 * What this key IS NOT: a master key. It cannot address a memory space it was
 * never granted into, and a compromise of this process does not hand over
 * anyone's book — it hands over the ability to act inside accounts that
 * deliberately granted it, each of which can revoke in one transaction.
 *
 * It is still a live secret, so it goes in `.env` (gitignored) and never in
 * source control.
 */

import { randomBytes } from "node:crypto";

const seed = randomBytes(32);
const hex = seed.toString("hex");

process.stdout.write(
  [
    "",
    "  People Book — delegate key",
    "  ------------------------",
    "",
    "  Add this to your .env:",
    "",
    `    MEMWAL_DELEGATE_KEY=${hex}`,
    "",
    "  This is a live secret. It goes in .env, which is gitignored — do not",
    "  commit it, do not paste it into a public issue, and do not reuse it for",
    "  another project.",
    "",
    "  Each user registers this key's public half into their own onchain",
    "  MemWalAccount, so it is scoped to them and revocable by them. Losing this",
    "  key does not lose anyone's memory: they grant it again, and nothing they",
    "  stored needs to move.",
    "",
  ].join("\n"),
);
