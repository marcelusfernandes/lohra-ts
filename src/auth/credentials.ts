import { readCodexTokens } from "./codex.js";
import { SubscriptionError } from "./errors.js";
import { isExpired } from "./jwt.js";
import { oauthRefreshTokens, type OAuthPost } from "./oauth.js";
import { readConfig, readTokens, writeTokens } from "./store.js";
import { OAuthTokens, SubscriptionCredentials, type AuthRoute } from "./types.js";

export const PREFER_KEY_NOTE =
  "note: your OpenAI/Codex subscription is active, but preference=api_key — using your API key (`lohra auth prefer auto` to go back).";
export const PREFER_SUB_ERROR =
  "preference=subscription, but subscription mode is not usable: run `lohra auth enable` to opt in (accepts the ToS risk) and `lohra auth login` to log in (or reuse `codex login`). To fall back to an API key instead, run `lohra auth prefer auto`.";

export function subscriptionActive(home: string): boolean {
  const config = readConfig(home);
  return config?.authMode === "subscription" && config.acknowledgedTosRisk;
}

export function routeFor(preference: string, active: boolean): AuthRoute {
  if (preference === "api_key")
    return active ? { mode: "api_key", note: PREFER_KEY_NOTE } : { mode: "api_key" };
  if (preference === "subscription" && !active) return { mode: "api_key", error: PREFER_SUB_ERROR };
  return { mode: active ? "subscription" : "api_key" };
}

export function resolveAuthRoute(home: string): AuthRoute {
  const config = readConfig(home);
  return routeFor(config?.preference ?? "auto", subscriptionActive(home));
}

export async function resolveCredentials(
  home: string,
  options: {
    readonly now?: number;
    readonly codexHome: string;
    readonly oauthPost?: OAuthPost;
  },
): Promise<SubscriptionCredentials | null> {
  const config = readConfig(home);
  if (config?.authMode !== "subscription") return null;
  if (!config.acknowledgedTosRisk)
    throw new SubscriptionError(
      "subscription mode is set but the ToS risk is not acknowledged — run `lohra auth enable` to confirm (default stays API key)",
    );
  const now = options.now ?? Date.now() / 1000;
  let own = readTokens(home);
  if (own !== null) {
    if (now >= own.expiresAt - 300) {
      if (options.oauthPost === undefined)
        throw new SubscriptionError(
          "could not refresh the login (no OAuth post configured) — run `lohra auth login` again",
        );
      try {
        const fresh = await oauthRefreshTokens(own.refreshToken, options.oauthPost);
        own = new OAuthTokens(
          fresh.accessToken,
          fresh.refreshToken,
          fresh.accountId ?? own.accountId,
          fresh.expiresAt,
        );
        writeTokens(home, own);
      } catch (error) {
        const latest = readTokens(home);
        if (latest !== null && latest.accessToken !== own.accessToken) own = latest;
        else
          throw new SubscriptionError(
            `could not refresh the login (${error instanceof Error ? error.message : String(error)}) — run \`lohra auth login\` again`,
          );
      }
    }
    return new SubscriptionCredentials(own.accessToken, own.accountId);
  }
  const codex = readCodexTokens(options.codexHome);
  if (codex === null)
    throw new SubscriptionError(
      "not logged in — run `lohra auth login` (own login, auto-refresh) or `codex login` (reuse), or unset subscription mode to use an API key",
    );
  if (isExpired(codex.accessToken, now))
    throw new SubscriptionError(
      "the Codex token is expired — run any `codex` command to refresh it, run `lohra auth login` for a self-refreshing login, or use an API key",
    );
  return new SubscriptionCredentials(codex.accessToken, codex.accountId);
}
