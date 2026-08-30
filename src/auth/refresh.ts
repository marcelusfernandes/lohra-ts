import { CODEX_CLIENT_ID, TOKEN_URL } from "./oauth.js";

export type RefreshPost = (
  url: string,
  body: Readonly<Record<string, unknown>>,
) => Promise<Readonly<Record<string, unknown>>>;

export class RefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefreshError";
  }
}

export class RefreshResult {
  constructor(
    readonly accessToken: string,
    readonly refreshToken: string,
  ) {}
  toString(): string {
    return "RefreshResult(access_token=***, refresh_token=***)";
  }
}

export async function refreshAccessToken(
  refreshToken: string,
  post: RefreshPost,
): Promise<RefreshResult> {
  if (!refreshToken) throw new RefreshError("no refresh token available");
  let body: Readonly<Record<string, unknown>>;
  try {
    const value: unknown = await post(TOKEN_URL, {
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new RefreshError("POST_SEAM_MISMATCH: refresh.default_post must return a dict");
    body = value as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof RefreshError) throw error;
    throw new RefreshError(
      `refresh request failed: ${error instanceof Error ? error.name : "Error"}`,
    );
  }
  if (typeof body.access_token !== "string" || !body.access_token)
    throw new RefreshError("refresh response had no access_token");
  return new RefreshResult(
    body.access_token,
    typeof body.refresh_token === "string" ? body.refresh_token : "",
  );
}
