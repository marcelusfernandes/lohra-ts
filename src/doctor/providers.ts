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
