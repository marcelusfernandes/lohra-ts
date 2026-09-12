/**
 * Estimador conservador de tokens do histórico de mensagens (issue #251,
 * épico #230). Puro, sem chamada de rede e sem tokenizer externo: conta
 * caracteres por tipo de bloco (texto, argumentos/resultado de tool,
 * raciocínio) com um fator calibrado contra `usage` real de dois provedores.
 * Fixtures em `tests/fixtures/context/`; método e erro medido em
 * `docs/context-estimate.md`.
 *
 * A meta é nunca subestimar: cada fator foi escolhido para que a soma fique
 * acima do `usage.inputTokens` reportado nas fixtures, mesmo quando o
 * provedor tokeniza de forma mais eficiente que o pior caso assumido aqui.
 */

// Type-only: erased at emit, so this never creates a runtime import cycle —
// `transports/types.ts` itself has zero imports. Backs estimatePartialUsage
// (issue #518) below.
import type { PartialStream, Usage } from "../transports/types.js";

/** Caracteres por token para prosa solta (texto de usuário/assistente). */
const TEXT_CHARS_PER_TOKEN = 2.9;

/**
 * Caracteres por token para conteúdo denso: JSON de argumentos de tool,
 * resultado de tool, raciocínio e qualquer bloco estruturado de formato
 * desconhecido. JSON e cadeias de raciocínio tendem a tokenizar com menos
 * caracteres por token do que prosa (pontuação, chaves, palavras curtas
 * repetidas) — por isso o fator é menor (mais conservador).
 */
const JSON_CHARS_PER_TOKEN = 2.4;

/** Overhead fixo por mensagem no array (formatação de role, delimitadores). */
const MESSAGE_OVERHEAD_TOKENS = 6;

/** Overhead fixo por tool call (envelope `type`/`function`/id). */
const TOOL_CALL_OVERHEAD_TOKENS = 4;

export interface TokenEstimate {
  readonly tokens: number;
  readonly method: "heuristic";
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function charsToTokens(chars: number, charsPerToken: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / charsPerToken);
}

function jsonLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    const serialized: unknown = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return String(value).length;
  }
}

/** Tokens de um único bloco de conteúdo estruturado (Anthropic-style
 * `text`/`thinking`/`tool_result`/`tool_use`, ou qualquer outro formato
 * futuro — que cai no fallback conservador via `JSON.stringify`). */
function blockTokens(raw: unknown): number {
  const block = record(raw);
  if (block.type === "text" && typeof block.text === "string") {
    return charsToTokens(block.text.length, TEXT_CHARS_PER_TOKEN);
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return charsToTokens(block.thinking.length, JSON_CHARS_PER_TOKEN);
  }
  if (block.type === "tool_result") {
    return charsToTokens(jsonLength(block.content), JSON_CHARS_PER_TOKEN);
  }
  if (block.type === "tool_use") {
    return charsToTokens(jsonLength(block.input), JSON_CHARS_PER_TOKEN) + TOOL_CALL_OVERHEAD_TOKENS;
  }
  // Bloco de tipo desconhecido (imagem, redacted_thinking, formato futuro de
  // provedor): nunca ignora silenciosamente — soma o tamanho serializado
  // inteiro com o fator mais conservador.
  return charsToTokens(jsonLength(block), JSON_CHARS_PER_TOKEN);
}

function contentTokens(role: unknown, content: unknown): number {
  if (typeof content === "string") {
    const factor = role === "tool" ? JSON_CHARS_PER_TOKEN : TEXT_CHARS_PER_TOKEN;
    return charsToTokens(content.length, factor);
  }
  if (Array.isArray(content)) {
    return content.reduce((sum: number, block) => sum + blockTokens(block), 0);
  }
  return 0;
}

function functionArgumentsLength(fn: Readonly<Record<string, unknown>>): number {
  return typeof fn.name === "string"
    ? fn.name.length + jsonLength(fn.arguments)
    : jsonLength(fn.arguments);
}

function toolCallsTokens(toolCalls: unknown): number {
  if (!Array.isArray(toolCalls)) return 0;
  return toolCalls.reduce((sum: number, raw) => {
    const call = record(raw);
    const fn = record(call.function);
    const chars = functionArgumentsLength(fn);
    return sum + charsToTokens(chars, JSON_CHARS_PER_TOKEN) + TOOL_CALL_OVERHEAD_TOKENS;
  }, 0);
}

function thinkingBlockTokens(raw: unknown): number {
  const block = record(raw);
  const text = typeof block.thinking === "string" ? block.thinking : block.data;
  return typeof text === "string" ? charsToTokens(text.length, JSON_CHARS_PER_TOKEN) : 0;
}

/** Raciocínio pode chegar de duas formas: `message.reasoning` (string
 * simples, formato usado ao persistir turnos) ou
 * `message.provider_data.thinking_blocks` (formato de replay da Anthropic,
 * `src/transports/anthropic-messages.ts`). Soma as duas — nunca são a
 * mesma informação duplicada dentro de uma única mensagem no wire. */
function reasoningTokens(message: Readonly<Record<string, unknown>>): number {
  let total = 0;
  if (typeof message.reasoning === "string") {
    total += charsToTokens(message.reasoning.length, JSON_CHARS_PER_TOKEN);
  }
  const blocks = record(message.provider_data).thinking_blocks;
  if (Array.isArray(blocks)) {
    for (const block of blocks) total += thinkingBlockTokens(block);
  }
  return total;
}

function messageTokens(raw: unknown): number {
  const message = record(raw);
  let total = MESSAGE_OVERHEAD_TOKENS;
  total += contentTokens(message.role, message.content);
  total += toolCallsTokens(message.tool_calls);
  total += reasoningTokens(message);
  if (typeof message.name === "string") {
    total += charsToTokens(message.name.length, TEXT_CHARS_PER_TOKEN);
  }
  return total;
}

/**
 * Estima quantos tokens `messages` vai consumir de input, de forma
 * conservadora (nunca abaixo do real nas fixtures medidas). Pura: sem I/O,
 * sem rede, não muta `messages`.
 */
export function estimateTokens(
  messages: readonly Readonly<Record<string, unknown>>[],
): TokenEstimate {
  if (!Array.isArray(messages)) {
    throw new Error("estimateTokens: messages must be an array", { cause: messages });
  }
  const tokens = messages.reduce((sum: number, message) => sum + messageTokens(message), 0);
  return Object.freeze({ tokens, method: "heuristic" as const });
}

/** Minimum tokens attributed to a single tool definition even when its
 * serialized form comes back implausibly small (reviewer note on PR #267:
 * malformed/circular content falls back to `String(value)`, which is never
 * a conservative estimate) -- a real function schema is always bigger than
 * this in practice, so the floor only ever bites the malformed case. */
const MIN_TOOL_DEFINITION_TOKENS = 20;

export interface RequestTokenEstimateInput {
  readonly system: string;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly tools: readonly Readonly<Record<string, unknown>>[];
}

/**
 * Estimates the full input a provider call actually bills for (issue #252):
 * `estimateTokens` alone only sees `messages` -- the system prompt and tool
 * definitions are passed to the provider outside that array and are never
 * counted otherwise (reviewer note on PR #267/#270). Pure, no I/O.
 */
export function estimateRequestTokens(input: RequestTokenEstimateInput): TokenEstimate {
  const messagesTokens = estimateTokens(input.messages).tokens;
  const systemTokens = charsToTokens(input.system.length, TEXT_CHARS_PER_TOKEN);
  const toolsTokens =
    input.tools.length === 0
      ? 0
      : Math.max(
          charsToTokens(jsonLength(input.tools), JSON_CHARS_PER_TOKEN),
          input.tools.length * MIN_TOOL_DEFINITION_TOKENS,
        );
  return Object.freeze({
    tokens: messagesTokens + systemTokens + toolsTokens,
    method: "heuristic" as const,
  });
}

/**
 * Issue #518 (M16-S3, épico #490, ADR 0005): estimates what a stream aborted
 * in flight (`StreamAbortedError.partial`, `src/transports/errors.ts`)
 * already cost, from whatever it had already shown for itself before the
 * tear-down — never a network call, never a real measurement. `outputTokens`
 * charges `partial.text` at the prose factor and `reasoningChars` +
 * `toolArgumentChars` (lengths only, never the raw text) at the denser JSON
 * factor, same conservative split `blockTokens` above already uses per
 * block type.
 *
 * `inputTokens` prefers `partial.usage.inputTokens` when the transport
 * measured it (today only Anthropic's `message_start`, `PartialStream`'s own
 * contract) — but `anthropicPartialUsage` (transports/errors.ts) returns a
 * `Usage` with `inputTokens: 0` whenever `message_start` arrived with no
 * `usage` field at all, which is indistinguishable here from "the call
 * genuinely cost zero input tokens" (never true for a real request: the
 * system prompt alone is never free). Treated as NOT measured, exactly like
 * `partial.usage === null` — falls back to the conservative `request`
 * estimate rather than under-counting to zero, keeping this function's own
 * "never underestimates" contract from the module doc above.
 *
 * Always paired by the caller with `partial: true` and `usageUncertain:
 * true` (conversation/runtime.ts, orchestration/child-runner.ts) — an
 * estimate is never a real measurement, no matter how it was derived.
 */
export function estimatePartialUsage(
  partial: PartialStream,
  request: RequestTokenEstimateInput,
): Usage {
  const outputTokens =
    charsToTokens(partial.text.length, TEXT_CHARS_PER_TOKEN) +
    charsToTokens(partial.reasoningChars + partial.toolArgumentChars, JSON_CHARS_PER_TOKEN);
  const measuredInput = partial.usage?.inputTokens;
  const inputTokens =
    measuredInput !== undefined && measuredInput > 0
      ? measuredInput
      : estimateRequestTokens(request).tokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}
