import { AUTO_PROVIDER, resolveProviderName } from "../providers/resolve.js";

export interface ProviderStatus {
  readonly provider: string;
  readonly display_name: string;
  readonly env_vars: readonly string[];
  readonly present_vars: readonly string[];
  readonly requires_api_key: boolean;
  readonly configured: boolean;
}

const providerDefinitions = [
  ["anthropic", "Anthropic", ["ANTHROPIC_API_KEY"], true],
  ["openai", "OpenAI", ["OPENAI_API_KEY"], true],
  ["openrouter", "OpenRouter", ["OPENROUTER_API_KEY"], true],
  ["deepseek", "DeepSeek", ["DEEPSEEK_API_KEY"], true],
  ["groq", "Groq", ["GROQ_API_KEY"], true],
  ["together", "Together AI", ["TOGETHER_API_KEY"], true],
  ["gemini", "Google Gemini", ["GEMINI_API_KEY", "GOOGLE_API_KEY"], true],
  ["xai", "xAI", ["XAI_API_KEY"], true],
  ["glm", "Zhipu GLM", ["ZHIPUAI_API_KEY", "ZAI_API_KEY", "GLM_API_KEY"], true],
  ["kimi", "Moonshot Kimi", ["MOONSHOT_API_KEY"], true],
  ["ollama", "Ollama", ["OLLAMA_API_KEY"], false],
] as const;

export function providerStatuses(
  environment: Readonly<Record<string, string | undefined>>,
): readonly ProviderStatus[] {
  return providerDefinitions.map(([provider, displayName, variables, requiresApiKey]) => {
    const present = variables.filter((name) => Boolean(environment[name]));
    return {
      provider,
      display_name: displayName,
      env_vars: [...variables],
      present_vars: present,
      requires_api_key: requiresApiKey,
      configured: present.length > 0,
    };
  });
}

/** O que `snapshot.ts` chamava `detected` inline (`resolveProviderName(undefined,
 * undefined, environment) !== AUTO_PROVIDER`, issue #604) — extraído para cá
 * para `src/commands/provider-detectado.ts` reusar a MESMA regra sem
 * duplicar a tabela de provedores. `error` carrega a mensagem de um
 * `LOHRA_PROVIDER` desconhecido (a única forma de `resolveProviderName`
 * lançar) — nunca engolida em silêncio (invariante 2 do CLAUDE.md). */
export interface DetectedProvider {
  readonly provider: string | null;
  readonly error: string | null;
}

export function detectConfiguredProvider(
  environment: Readonly<Record<string, string | undefined>>,
): DetectedProvider {
  try {
    const resolved = resolveProviderName(undefined, undefined, environment);
    return resolved === AUTO_PROVIDER
      ? { provider: null, error: null }
      : { provider: resolved, error: null };
  } catch (error) {
    return { provider: null, error: error instanceof Error ? error.message : String(error) };
  }
}
