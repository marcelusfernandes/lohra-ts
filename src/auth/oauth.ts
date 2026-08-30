import { OAuthError } from "./errors.js";
import { accountIdFromToken } from "./jwt.js";
import { OAuthTokens } from "./types.js";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const DEVICE_VERIFY_URL = "https://auth.openai.com/codex/device";
export const DEVICE_REDIRECT = "https://auth.openai.com/deviceauth/callback";

export type OAuthPost = (
  url: string,
  body: Readonly<Record<string, unknown>>,
) => Promise<readonly [number, unknown]>;

export const defaultOAuthPost: OAuthPost = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": "lohra/0.0.11",
      ...(url === TOKEN_URL
        ? { "content-type": "application/x-www-form-urlencoded" }
        : { "content-type": "application/json" }),
    },
    body:
      url === TOKEN_URL
        ? new URLSearchParams(
            Object.fromEntries(Object.entries(body).map(([key, value]) => [key, String(value)])),
          )
        : JSON.stringify(body),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return [response.status, parsed];
};

export interface DeviceCode {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly interval: number;
  readonly verifyUrl: string;
}

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

async function callPost(
  post: OAuthPost,
  url: string,
  body: Readonly<Record<string, unknown>>,
): Promise<readonly [number, unknown]> {
  let value: unknown;
  try {
    value = await post(url, body);
  } catch (error) {
    throw new OAuthError(`oauth request failed (${error instanceof Error ? error.name : "Error"})`);
  }
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "number")
    throw new OAuthError("POST_SEAM_MISMATCH: oauth.post must return [status, body]");
  return value as unknown as readonly [number, unknown];
}

export async function startDeviceLogin(post: OAuthPost): Promise<DeviceCode> {
  const [status, raw] = await callPost(post, USERCODE_URL, { client_id: CODEX_CLIENT_ID });
  const body = object(raw);
  if (status !== 200 || typeof body?.user_code !== "string" || !body.user_code)
    throw new OAuthError(`could not start device login (status ${String(status)})`);
  let interval = 5;
  if (
    (typeof body.interval === "string" || typeof body.interval === "number") &&
    Boolean(body.interval)
  ) {
    const parsed = Number.parseInt(String(body.interval), 10);
    if (Number.isFinite(parsed)) interval = Math.max(parsed, 1);
  }
  return {
    deviceAuthId: typeof body.device_auth_id === "string" ? body.device_auth_id : "",
    userCode: body.user_code,
    interval,
    verifyUrl: DEVICE_VERIFY_URL,
  };
}

export function tokensFromResponse(
  body: Readonly<Record<string, unknown>>,
  now = Date.now() / 1000,
): OAuthTokens {
  const access = body.access_token;
  if (typeof access !== "string" || !access)
    throw new OAuthError("token response had no access_token");
  const expires = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return new OAuthTokens(
    access,
    typeof body.refresh_token === "string" ? body.refresh_token : "",
    accountIdFromToken(body.id_token) ?? accountIdFromToken(access),
    now + expires,
  );
}

const exchange = async (code: string, verifier: string, post: OAuthPost): Promise<OAuthTokens> => {
  const [status, raw] = await callPost(post, TOKEN_URL, {
    grant_type: "authorization_code",
    code,
    redirect_uri: DEVICE_REDIRECT,
    client_id: CODEX_CLIENT_ID,
    code_verifier: verifier,
  });
  const body = object(raw);
  if (status !== 200 || body === null)
    throw new OAuthError(`token exchange failed (status ${String(status)})`);
  return tokensFromResponse(body);
};

export async function pollForTokens(
  device: DeviceCode,
  post: OAuthPost,
  options: {
    readonly sleep?: (seconds: number) => Promise<void>;
    readonly monotonicNow?: () => number;
  } = {},
): Promise<OAuthTokens> {
  const clock = options.monotonicNow ?? (() => performance.now() / 1000);
  const sleep =
    options.sleep ??
    (async (seconds) => {
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    });
  const deadline = clock() + 600;
  while (clock() < deadline) {
    const [status, raw] = await callPost(post, DEVICE_TOKEN_URL, {
      device_auth_id: device.deviceAuthId,
      user_code: device.userCode,
    });
    const body = object(raw);
    if (status === 200 && typeof body?.authorization_code === "string")
      return await exchange(
        body.authorization_code,
        typeof body.code_verifier === "string" ? body.code_verifier : "",
        post,
      );
    if (status !== 403 && status !== 404)
      throw new OAuthError(`device authorization failed (status ${String(status)})`);
    await sleep(device.interval);
  }
  throw new OAuthError("device login timed out — please try again");
}

export async function oauthRefreshTokens(
  refreshToken: string,
  post: OAuthPost,
): Promise<OAuthTokens> {
  if (!refreshToken) throw new OAuthError("no refresh token available");
  const [status, raw] = await callPost(post, TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
  });
  const body = object(raw);
  if (status !== 200 || body === null)
    throw new OAuthError(`token refresh failed (status ${String(status)})`);
  const tokens = tokensFromResponse(body);
  return tokens.refreshToken
    ? tokens
    : new OAuthTokens(tokens.accessToken, refreshToken, tokens.accountId, tokens.expiresAt);
}
