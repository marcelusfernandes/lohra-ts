import type { AuthPreference } from "../auth/types.js";
import type { JsonFloat } from "../serialization/json-numbers.js";
import type { ProviderStatus } from "./providers.js";

export interface Check {
  readonly name: string;
  readonly state: "ok" | "warn" | "fail";
  readonly detail: string;
  readonly remedy: string;
}

export interface DoctorEnvironment {
  readonly active_profile: string | null;
  readonly auth_preference: AuthPreference;
  readonly auth_route: "api_key" | "subscription" | "unusable";
  readonly base: string;
  readonly base_auth_preference: AuthPreference;
  readonly base_subscription_active: boolean;
  /** Issue #631: o que `detectChatProvider` (`src/commands/provider-detectado.ts`)
   * devolveria para este mesmo ambiente — o provedor que `chat`/`dashboard`
   * de fato usam sem `--provider` na rota `api_key`. Difere de
   * `detected_provider` só em intenção, não em valor (mesma função por
   * baixo): existe para o consumidor de `doctor --json` não precisar saber
   * que `detected_provider` serve às duas perguntas. `null` quando nenhuma
   * chave/`LOHRA_PROVIDER` está configurada — mesmo com `usable: true` só
   * por `ollama.alive` (a fronteira #631 documenta). */
  readonly chat_default_provider: string | null;
  readonly codex_auth_present: boolean;
  readonly codex_home: string;
  readonly detected_provider: string | null;
  readonly env_file: string;
  readonly env_file_present: boolean;
  readonly harnesses: readonly Record<string, unknown>[];
  readonly has_api_key: boolean;
  readonly home: string;
  readonly interactive: boolean;
  readonly lohra_auth_present: boolean;
  readonly lohra_oauth_expires_at: number | JsonFloat | null;
  readonly lohra_oauth_present: boolean;
  readonly ollama: {
    readonly alive: boolean;
    readonly detail: string;
    readonly models: readonly string[];
    readonly url: string;
  };
  readonly os_name: "nt" | "posix";
  readonly platform: string;
  readonly provider_error: string | null;
  readonly provider_origin: "api-key" | "env-var" | "none";
  readonly providers: readonly ProviderStatus[];
  readonly python_supported: true;
  readonly python_version: "3.12.10";
  readonly stderr_tty: boolean;
  readonly stdin_tty: boolean;
  readonly subscription_active: boolean;
  readonly subscription_divergence: boolean;
  readonly timezone: string;
  readonly usable: boolean;
}

export interface OllamaStatus {
  readonly alive: boolean;
  readonly detail: string;
  readonly models: readonly string[];
  readonly url: string;
}

export interface DoctorPayload {
  readonly checks: readonly Check[];
  readonly environment: DoctorEnvironment;
  readonly exit_code: 0 | 2;
  readonly ok: boolean;
}
