import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "crypto";
import { promisify } from "util";

/**
 * Password hashing only, with no framework dependency, so it can be
 * imported from plain scripts (e.g. scripts/seed.ts) as well as from
 * Next.js request code. Kept separate from src/lib/auth.ts, which
 * imports next/headers and therefore only works inside a request scope.
 */

const scrypt = promisify(scryptCallback);
const SCRYPT_KEY_LEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, SCRYPT_KEY_LEN)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;

  const derived = (await scrypt(password, salt, SCRYPT_KEY_LEN)) as Buffer;
  const storedBuf = Buffer.from(hashHex, "hex");

  // Lengths must match before timingSafeEqual, and a mismatch here is
  // just as much "wrong password" as a content mismatch — never throw.
  if (derived.length !== storedBuf.length) return false;
  return timingSafeEqual(derived, storedBuf);
}
