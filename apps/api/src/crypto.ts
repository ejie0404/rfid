import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export async function hashPassword(password: string) {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
export async function verifyPassword(password: string, stored: string | null) {
  if (!stored) {
    // Derive anyway so a missing account is not distinguishable by response time.
    await scrypt(password, randomBytes(SALT_LENGTH), KEY_LENGTH, PARAMS);
    return false;
  }
  const [scheme, N, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !N || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function newToken() {
  return randomBytes(32).toString("base64url");
}
export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function randomId() {
  return randomBytes(16).toString("hex");
}
function base32Encode(bytes: Buffer) {
  let bits = 0,
    value = 0,
    output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
function base32Decode(input: string) {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0,
    value = 0;
  const output: number[] = [];
  for (const character of clean) {
    const index = alphabet.indexOf(character);
    if (index === -1) throw new Error("Invalid base32 secret.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
function hotp(key: Buffer, counter: number) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const truncated =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return (truncated % 1_000_000).toString().padStart(6, "0");
}
export const TOTP_STEP_SECONDS = 30;
export function totpStep(at = Date.now()) {
  return Math.floor(at / 1000 / TOTP_STEP_SECONDS);
}
export function newTotpSecret() {
  return base32Encode(randomBytes(20));
}
export function totpCode(secret: string, at = Date.now()) {
  return hotp(base32Decode(secret), totpStep(at));
}
export function otpauthUrl(secret: string, account: string, issuer = "SmartGate") {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query}`;
}
/**
 * Returns the accepted TOTP step, or null. A step at or below `lastStep` is refused so a
 * captured code cannot be presented twice inside its own validity window.
 */
export function verifyTotp(secret: string, code: string, lastStep: number | null, at = Date.now()) {
  const submitted = code.trim();
  if (!/^\d{6}$/.test(submitted)) return null;
  const current = totpStep(at);
  const key = base32Decode(secret);
  const submittedBuffer = Buffer.from(submitted);
  for (const step of [current, current - 1, current + 1]) {
    if (step < 0) continue;
    if (lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, step)), submittedBuffer)) return step;
  }
  return null;
}
export function newRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(4).toString("hex").toUpperCase();
    return raw.slice(0, 4) + "-" + raw.slice(4);
  });
}
export function normalizeRecoveryCode(code: string) {
  return code.trim().toUpperCase().replace(/[\s-]/g, "");
}
export function recoveryCodeHash(code: string) {
  return createHash("sha256")
    .update("recovery:" + normalizeRecoveryCode(code))
    .digest("hex");
}
