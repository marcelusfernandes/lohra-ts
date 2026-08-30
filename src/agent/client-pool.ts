import { resolveAuthRoute, resolveCredentials, subscriptionActive } from "../auth/credentials.js";
import {
  CODEX_PROVIDER,
  getProviderProfile,
  resolveApiKey,
  type ProviderProfile,
} from "../providers/index.js";
import { buildClient, createResponsesClient } from "../transports/index.js";

export class ProviderError extends Error {
  override readonly name = "ProviderError";
}

export interface ClosableClient {
  close?(): void | Promise<void>;
}

export interface ClientPoolOptions {
  readonly home: string;
  readonly codexHome?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly build?: (profile: ProviderProfile, apiKey: string) => ClosableClient;
  readonly buildSubscription?: () => ClosableClient | Promise<ClosableClient>;
}

export class ClientPool {
  private readonly owned = new Map<string, readonly [ProviderProfile, ClosableClient]>();
  private readonly pending = new Map<string, Promise<readonly [ProviderProfile, ClosableClient]>>();
  private closed = false;

  public constructor(
    private readonly parentProvider: ProviderProfile,
    private readonly parentClient: ClosableClient,
    private readonly options: ClientPoolOptions,
  ) {}

  public async get(
    name: string | null | undefined,
  ): Promise<readonly [ProviderProfile, ClosableClient]> {
    if (!name || name === this.parentProvider.name)
      return [this.parentProvider, this.parentClient] as const;
    if (this.closed) throw new ProviderError("client pool is closed");
    const existing = this.owned.get(name);
    if (existing !== undefined) return existing;
    const current = this.pending.get(name);
    if (current !== undefined) return current;
    const pending = this.build(name);
    this.pending.set(name, pending);
    try {
      const result = await pending;
      this.owned.set(name, result);
      return result;
    } finally {
      this.pending.delete(name);
    }
  }

  private async build(name: string): Promise<readonly [ProviderProfile, ClosableClient]> {
    if (name === "openai-codex") return this.buildCodex();
    const profile = getProviderProfile(name);
    if (profile === null) throw new ProviderError(`unknown provider '${name}'`);
    if (profile.apiMode === "responses")
      throw new ProviderError(`provider '${name}' (api_mode 'responses') is not supported`);
    const apiKey = resolveApiKey(profile.name, this.options.environment);
    if (profile.requiresApiKey && apiKey === null)
      throw new ProviderError(`no API key configured for provider '${name}'`);
    try {
      const client =
        this.options.build?.(profile, apiKey ?? "lohra-local") ??
        buildClient(profile, apiKey ?? "lohra-local");
      return [profile, client] as const;
    } catch (error) {
      throw new ProviderError(
        `could not build a client for '${name}': ${error instanceof Error ? error.name : "Error"}`,
      );
    }
  }

  private async buildCodex(): Promise<readonly [ProviderProfile, ClosableClient]> {
    if (!subscriptionActive(this.options.home))
      throw new ProviderError(
        "subscription not enabled — run `lohra auth enable` (won't auto-escalate)",
      );
    if (resolveAuthRoute(this.options.home).mode !== "subscription")
      throw new ProviderError(
        "subscription opted in but not preferred — run `lohra auth prefer auto` to let a child use it (won't override your choice)",
      );
    try {
      if (this.options.buildSubscription !== undefined)
        return [CODEX_PROVIDER, await this.options.buildSubscription()] as const;
      const credentials = await resolveCredentials(this.options.home, {
        codexHome: this.options.codexHome ?? "",
      });
      if (credentials === null) throw new Error("not logged in");
      return [
        CODEX_PROVIDER,
        createResponsesClient({
          baseUrl: credentials.baseUrl,
          token: credentials.token,
          accountId: credentials.accountId,
          headers: credentials.headers,
        }),
      ] as const;
    } catch (error) {
      throw new ProviderError(
        `subscription: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let failure: unknown;
    for (const [, client] of this.owned.values()) {
      try {
        await client.close?.();
      } catch (error) {
        failure ??= error;
      }
    }
    this.owned.clear();
    if (failure !== undefined)
      throw failure instanceof Error
        ? failure
        : new Error("client close failed with non-Error value");
  }
}

export async function configureFor(
  pool: ClientPool | null,
  options: {
    readonly provider?: string | null;
    readonly model?: string | null;
    readonly effort?: string | null;
    readonly forcedTool?: Readonly<Record<string, unknown>> | null;
    readonly maxIterations?: number | null;
  },
): Promise<Readonly<Record<string, unknown>> | null> {
  if (!options.provider && !options.model && !options.effort && !options.forcedTool) return null;
  let model = options.model ?? null;
  let pair: readonly [ProviderProfile, ClosableClient] | null = null;
  if (options.provider) {
    if (pool === null) throw new ProviderError("cross-provider delegation is not available here");
    pair = await pool.get(options.provider);
    model ??= pair[0].fallbackModels[0] ?? null;
    if (model === null)
      throw new ProviderError(
        `provider '${options.provider}' has no default model — pass an explicit model`,
      );
  }
  return {
    ...(model === null ? {} : { model }),
    ...(options.effort == null ? {} : { effort: options.effort }),
    ...(options.forcedTool == null ? {} : { forcedTool: options.forcedTool }),
    ...(options.maxIterations == null ? {} : { maxIterations: options.maxIterations }),
    ...(pair === null ? {} : { provider: pair[0], client: pair[1] }),
  };
}
