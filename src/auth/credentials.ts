import { randomUUID } from "node:crypto";

import { readCodexTokens } from "./codex.js";
import { RefreshFailedError, SubscriptionError, TokenPersistError } from "./errors.js";
import { isExpired } from "./jwt.js";
import { acquireFileLease, releaseFileLease, waitForFileLease } from "./lease.js";
import { defaultOAuthPost, oauthRefreshTokens, type OAuthPost } from "./oauth.js";
import { readConfig, readTokens, tokenPath, writeTokens } from "./store.js";
import { OAuthTokens, SubscriptionCredentials, type AuthRoute } from "./types.js";

// TTL curto (issue #354): a lease só precisa sobreviver ao tempo de um
// round-trip HTTP de refresh. Um TTL curto também limita quanto tempo um
// dono morto (crash entre acquire e o `finally` de release) tranca os
// outros processos fora — o próximo `acquireFileLease` sempre pode tomar
// de volta uma lease vencida.
const REFRESH_LEASE_TTL_SECONDS = 10;

function isExpiringSoon(tokens: OAuthTokens, now: number): boolean {
  return now >= tokens.expiresAt - 300;
}

/**
 * Faz o refresh de verdade e persiste o resultado. A escrita
 * (`writeTokens`) fica FORA do `try` que envolve o POST (issue #354,
 * achado 2 da PR #352): um refresh bem-sucedido que falha só ao gravar em
 * disco precisa de um erro nomeado próprio (`TokenPersistError`) — não o
 * `RefreshFailedError` de "o login falhou", que diz para rodar
 * `lohra auth login` de novo (inútil aqui: o login funcionou).
 */
async function performRefresh(
  home: string,
  own: OAuthTokens,
  oauthPost: OAuthPost,
): Promise<OAuthTokens> {
  let fresh;
  try {
    fresh = await oauthRefreshTokens(own.refreshToken, oauthPost);
  } catch (error) {
    const latest = readTokens(home);
    if (latest !== null && latest.accessToken !== own.accessToken) return latest;
    throw new RefreshFailedError(
      `could not refresh the login (${error instanceof Error ? error.message : String(error)}) — run \`lohra auth login\` again`,
    );
  }
  const updated = new OAuthTokens(
    fresh.accessToken,
    fresh.refreshToken,
    fresh.accountId ?? own.accountId,
    fresh.expiresAt,
  );
  try {
    writeTokens(home, updated);
  } catch (error) {
    throw new TokenPersistError(
      `the login refresh itself succeeded, but saving it to disk failed (${error instanceof Error ? error.message : String(error)}) — retry the command; the refresh token in memory is not lost until the process exits, but nothing else will see it until the save works`,
    );
  }
  return updated;
}

/**
 * Coordena a renovação sob uma lease de arquivo (issue #354): quem adquire
 * a lease faz o refresh e grava; quem perde espera a lease sumir (liberada
 * ou expirada) e relê o arquivo, usando o token novo que o dono já
 * escreveu — sem bater no `oauthPost` de novo. Bounded a duas tentativas:
 * se a espera acabar e o token no disco ainda estiver expirando (o dono
 * pode ter morrido antes de escrever), esta chamada tenta adquirir a
 * lease ela mesma, agora livre para tomar a lease órfã de volta.
 */
async function refreshUnderLease(
  home: string,
  own: OAuthTokens,
  now: number,
  oauthPost: OAuthPost,
): Promise<OAuthTokens> {
  const lockPath = `${tokenPath(home)}.lock`;
  const attempts = 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const holder = `${String(process.pid)}:${randomUUID()}`;
    let acquired: boolean;
    try {
      acquired = acquireFileLease(lockPath, holder, REFRESH_LEASE_TTL_SECONDS);
    } catch (error) {
      // Not "lease held by someone else" (that path returns false, never
      // throws) — a real I/O failure creating the lock file itself, most
      // often the same unwritable-home cause `performRefresh` guards for
      // `writeTokens`. Same named error, so callers don't need to
      // distinguish "couldn't lock" from "couldn't save" — both mean
      // "the refresh worked, disk didn't cooperate".
      throw new TokenPersistError(
        `could not create the refresh lease at ${lockPath} (${error instanceof Error ? error.message : String(error)}) — check permissions on ${home}`,
      );
    }
    if (acquired) {
      try {
        return await performRefresh(home, own, oauthPost);
      } finally {
        try {
          releaseFileLease(lockPath, holder);
        } catch {
          // Best-effort cleanup (same stance as the tmp-file unlink in
          // json-file.ts:55-59): a lock that can't be unlinked expires via
          // its own TTL and is stolen by the next `acquireFileLease`. A
          // cleanup failure here must neither mask the fault
          // `performRefresh` just raised nor turn a *successful* refresh
          // into one — home turning unwritable between acquiring the
          // lease and releasing it (ex.: the same disk failure that made
          // `writeTokens` throw `TokenPersistError`) is exactly that case.
        }
      }
    }
    await waitForFileLease(lockPath, { maxWaitMs: REFRESH_LEASE_TTL_SECONDS * 1000 });
    const latest = readTokens(home);
    if (latest !== null && !isExpiringSoon(latest, now)) return latest;
  }
  throw new RefreshFailedError(
    "could not refresh the login (lost the renewal lease and the token on disk is still expiring) — run `lohra auth login` again",
  );
}

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
    if (isExpiringSoon(own, now)) {
      // No caller wires a real `oauthPost` in production (issue #351) — the
      // 4 CLI entry points (chat, dashboard, chat-boundary, client-pool) all
      // omit it, so this branch used to throw unconditionally instead of
      // ever refreshing. Defaulting here, once, covers all of them without
      // touching each call site; only tests still override it, to mock the
      // network instead of hitting auth.openai.com.
      const oauthPost = options.oauthPost ?? defaultOAuthPost;
      own = await refreshUnderLease(home, own, now, oauthPost);
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
