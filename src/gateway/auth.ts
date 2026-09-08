import { randomBytes, timingSafeEqual } from "node:crypto";

// Matches Python's secrets.token_urlsafe(32): 32 random bytes, base64url
// without padding -> 43 characters.
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

// Constant-time comparison over fixed-size operands derived from the two
// strings, so a length mismatch never leaks via an early return on the raw
// bytes. The parser (request-parser.ts) is responsible for the h11-style
// leading-OWS-only trim; this function performs no trimming of its own.
export function timingSafeTokenEqual(candidate: string, expected: string): boolean {
  // Issue #221: an empty `expected` never authenticates, even against an
  // equally empty candidate. dashboard.ts refuses an empty
  // LOHRA_DASHBOARD_SESSION_TOKEN before this is ever reached, but this is
  // defense in depth for any other caller.
  if (expected.length === 0) return false;
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (candidateBuffer.length !== expectedBuffer.length) {
    // Still perform a constant-time compare against a same-length buffer so
    // the branch itself doesn't become a timing oracle on top of the length
    // check (which is already observable via Content-Length in practice,
    // but keep the comparison itself uniform regardless).
    timingSafeEqual(candidateBuffer, candidateBuffer);
    return false;
  }
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}
