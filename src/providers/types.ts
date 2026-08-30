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
