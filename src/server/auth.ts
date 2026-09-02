/** Bearer API-key auth — mirrors `lohra/server/app.py`'s `authorized()`.
 * Timing-safe compare (assertion 18): `node:crypto.timingSafeEqual` needs
 * equal-length buffers, so both sides are first reduced to a fixed-size HMAC
 * digest — that derivation is what makes the compare itself constant-time
 * regardless of the token's length. */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const compareKey = randomBytes(32);

function digest(value: string): Buffer {
  return createHmac("sha256", compareKey).update(value, "utf8").digest();
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

const BEARER_PREFIX = "Bearer ";

/** `apiKey === null` means auth is disabled (`--insecure`): everything passes,
 * including a garbage scheme, matching the oracle's unconditional bypass. */
export function authorized(
  authorizationHeader: string | undefined,
  apiKey: string | null,
): boolean {
  if (apiKey === null) return true;
  if (!authorizationHeader || !authorizationHeader.startsWith(BEARER_PREFIX)) return false;
  const token = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  return timingSafeStringEqual(token, apiKey);
}
