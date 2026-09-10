export type ProviderApiMode = "anthropic_messages" | "chat_completions" | "responses";

export interface ProviderProfile {
  readonly name: string;
  readonly apiMode: ProviderApiMode;
  readonly aliases: readonly string[];
  readonly displayName: string;
  readonly description: string;
  readonly signupUrl: string;
  readonly envVars: readonly string[];
  readonly baseUrl: string;
  readonly modelsUrl: string;
  readonly requiresApiKey: boolean;
  readonly supportsVision: boolean;
  readonly fallbackModels: readonly string[];
  readonly defaultMaxTokens: number;
  readonly defaultAuxModel: string;
  /**
   * Piso da janela de contexto do provedor (issue #250) — usado quando o
   * modelo não aparece no cache do catálogo (`loadWindowsCache`) nem na
   * tabela estática (`modelWindows`). `resolveContextWindow` só chega aqui
   * depois de esgotar `override` e `catalog`.
   */
  readonly defaultContextWindow?: number;
  /**
   * Tabela estática pequena, por prefixo mais longo do id do modelo (issue
   * #250) — só os modelos que este runtime usa hoje, cada linha datada e com
   * fonte em `src/providers/registry.ts`. Nunca inventada: um modelo sem
   * fonte verificável fica fora da tabela e cai no piso do provedor.
   */
  readonly modelWindows?: Readonly<Record<string, number>>;
  readonly authType?: "api_key" | "oauth_external";
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fixedTemperature?: number | null;
}

export type ResolutionOrigin = "argument" | "config" | "env-var" | "api-key" | "keyless" | "none";

export interface ProviderResolution {
  readonly provider: string | null;
  readonly origin: ResolutionOrigin;
  readonly model?: string;
  readonly detail?: string;
  readonly error?: string;
}
