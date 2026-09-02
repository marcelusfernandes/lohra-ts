import { resolveAuthRoute, resolveCredentials } from "../auth/credentials.js";
import { pythonJsonDumpsInsertionOrder } from "../serialization/python-json.js";

const noProvider =
  "no provider configured — there are three ways in:\n\n" +
  "  1. API key (paid, any provider)\n" +
  "       export ANTHROPIC_API_KEY=sk-...      # or OPENAI_API_KEY, OPENROUTER_API_KEY,\n" +
  "                                            # DEEPSEEK_API_KEY, GROQ_API_KEY,\n" +
  "                                            # TOGETHER_API_KEY, GEMINI_API_KEY\n" +
  "     Keys are also read from ~/.lohra/.env (one KEY=value per line), which is\n" +
  "     what the desktop app writes and what a Finder-launched app relies on.\n\n" +
  "  2. OpenAI/Codex subscription (no API key; opt-in, ToS-gray)\n" +
  "       lohra auth enable        # prints the ToS warning and asks for a yes\n" +
  "       lohra auth login         # Lohra's own login (auto-refreshing)\n\n" +
  "  3. Local models, keyless (nothing leaves the machine)\n" +
  "       ollama serve             # then, in another shell:\n" +
  '       lohra chat "oi" --provider ollama\n\n' +
  "Or name a provider explicitly with --provider <name>.\n\n" +
  "Not sure which? Run `lohra init` — it detects what this machine already has and\n" +
  "sets up the rest (it is read-only without a terminal, so it is safe in CI), or\n" +
  "`lohra doctor` for a read-only report with the exact command for each gap.\n";

const envelope = (input: string, model: string | null, error: string): string =>
  `${pythonJsonDumpsInsertionOrder({
    session_id: "",
    model,
    temperature: null,
    input,
    output: null,
    reasoning: null,
    tool_calls: [],
    usage: null,
    usage_total: null,
    cost: null,
    stop_reason: null,
    completed: false,
    error,
    api_calls: 0,
  })}\n`;

export async function runChatBoundary(options: {
  readonly home: string;
  readonly codexHome: string;
  readonly input: string;
}): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const route = resolveAuthRoute(options.home);
  if (route.error)
    return {
      code: 2,
      stdout: envelope(options.input, null, route.error),
      stderr: `${route.error}\n`,
    };
  if (route.mode === "subscription") {
    try {
      await resolveCredentials(options.home, { codexHome: options.codexHome });
      return {
        code: 2,
        stdout: envelope(options.input, "gpt-5.5", "subscription transport is not available"),
        stderr: "lohra: chat transport is not implemented in the TypeScript bootstrap\n",
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `subscription mode: ${detail}`;
      return {
        code: 2,
        stdout: envelope(options.input, "gpt-5.5", message),
        stderr: `${message}\n`,
      };
    }
  }
  const short = "no provider configured — run `lohra init` (or `lohra doctor`); details on stderr";
  return {
    code: 2,
    stdout: envelope(options.input, null, short),
    stderr: `${route.note ? `${route.note}\n` : ""}${noProvider}`,
  };
}
