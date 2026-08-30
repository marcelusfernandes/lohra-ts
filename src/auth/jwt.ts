const decodeClaims = (token: string): Record<string, unknown> | null => {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export function isExpired(token: string, now = Date.now() / 1000): boolean {
  const exp = decodeClaims(token)?.exp;
  return typeof exp !== "number" || !Number.isFinite(exp) || now >= exp - 300;
}

export function accountIdFromToken(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const claims = decodeClaims(token);
  if (claims === null) return null;
  if (typeof claims.chatgpt_account_id === "string") return claims.chatgpt_account_id;
  const nested = claims["https://api.openai.com/auth"];
  const nestedRecord =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : null;
  if (nestedRecord !== null && typeof nestedRecord.chatgpt_account_id === "string")
    return nestedRecord.chatgpt_account_id;
  const organizations = claims.organizations;
  if (Array.isArray(organizations)) {
    const first: unknown = organizations[0];
    const firstRecord =
      typeof first === "object" && first !== null ? (first as Record<string, unknown>) : null;
    if (typeof firstRecord?.id === "string") return firstRecord.id;
  }
  return null;
}
