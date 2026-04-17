import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 64;
const SALT_LEN = 16;

export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(plain, salt, KEYLEN, { N, r, p });
  return `${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[0], "base64");
    expected = Buffer.from(parts[1], "base64");
  } catch {
    return false;
  }
  if (salt.length !== SALT_LEN || expected.length !== KEYLEN) return false;
  const actual = scryptSync(plain, salt, KEYLEN, { N, r, p });
  return timingSafeEqual(actual, expected);
}
