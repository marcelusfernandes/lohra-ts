// Issue #576: parsing e validação de `tests/fixtures/eval/<id>.json` para
// `EvalCase`. Fail-closed (CLAUDE.md, invariante 2): qualquer forma
// inesperada é um `Error` com a razão, nunca um valor parcial silencioso.
import type {
  EvalCase,
  EvalCaseFixture,
  EvalOutcome,
  EvalSeedTurn,
  EvalStubScript,
  EvalStubStep,
  EvalStubToolCall,
  MechanismAssertion,
} from "./types.js";

function fail(path: string, reason: string): never {
  throw new Error(`eval: caso inválido em ${path}: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseString(value: unknown, path: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, `"${field}" precisa ser uma string não vazia`);
  }
  return value;
}

function parseFixture(value: unknown, path: string): EvalCaseFixture | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail(path, `"cwd_fixture" precisa ser um objeto`);
  return {
    path: parseString(value.path, path, "cwd_fixture.path"),
    content:
      typeof value.content === "string"
        ? value.content
        : fail(path, "cwd_fixture.content precisa ser string"),
  };
}

function parseToolCall(value: unknown, path: string): EvalStubToolCall {
  if (!isRecord(value)) fail(path, `chamada de tool scriptada precisa ser um objeto`);
  return {
    name: parseString(value.name, path, "stub_script[].calls[].name"),
    argumentsRaw: parseString(value.argumentsRaw, path, "stub_script[].calls[].argumentsRaw"),
  };
}

const STEP_KINDS = new Set(["text", "tool_calls", "http_error"]);

function parseStep(value: unknown, path: string): EvalStubStep {
  if (!isRecord(value)) fail(path, `passo de stub_script precisa ser um objeto`);
  const kind = value.kind;
  if (typeof kind !== "string" || !STEP_KINDS.has(kind)) {
    fail(path, `stub_script[].kind desconhecido: ${JSON.stringify(kind)}`);
  }
  const step: {
    kind: "text" | "tool_calls" | "http_error";
    content?: string;
    calls?: readonly EvalStubToolCall[];
    status?: number;
    message?: string;
  } = { kind: kind as "text" | "tool_calls" | "http_error" };
  if (value.content !== undefined) {
    // Uma string vazia é um valor legítimo aqui (ex.: script de "dead_turn"
    // — turno final sem texto e sem tool call, src/orchestration/child-runner.ts:244)
    // — nunca rejeitada como se fosse ausência de campo.
    if (typeof value.content !== "string") fail(path, `stub_script[].content precisa ser string`);
    step.content = value.content;
  }
  if (value.calls !== undefined) {
    if (!Array.isArray(value.calls)) fail(path, `stub_script[].calls precisa ser array`);
    step.calls = value.calls.map((call) => parseToolCall(call, path));
  }
  if (value.status !== undefined) {
    if (typeof value.status !== "number") fail(path, `stub_script[].status precisa ser number`);
    step.status = value.status;
  }
  if (value.message !== undefined)
    step.message = parseString(value.message, path, "stub_script[].message");
  return step;
}

function parseStubScript(value: unknown, path: string): EvalStubScript {
  if (!isRecord(value)) fail(path, `"stub_script" precisa ser um objeto (lane -> passos)`);
  const script: Record<string, readonly EvalStubStep[]> = {};
  for (const [lane, steps] of Object.entries(value)) {
    if (!Array.isArray(steps)) fail(path, `stub_script["${lane}"] precisa ser array de passos`);
    script[lane] = steps.map((step) => parseStep(step, path));
  }
  return script;
}

const MECHANISM_KINDS = new Set([
  "system_prompt_includes",
  "system_prompt_excludes",
  "request_count",
  "message_roles_at_request",
  "tool_result_includes",
  "message_content_includes",
  "envelope_pointer",
  "tools_include",
  "tools_exclude",
]);

function parseOptionalRequestIndex(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") fail(path, `mechanism[].request precisa ser number`);
  return value;
}

function parseMechanismAssertion(value: unknown, path: string): MechanismAssertion {
  if (!isRecord(value)) fail(path, `assertion de "mechanism" precisa ser um objeto`);
  const kind = value.kind;
  if (typeof kind !== "string" || !MECHANISM_KINDS.has(kind)) {
    fail(path, `mechanism[].kind desconhecido: ${JSON.stringify(kind)}`);
  }
  switch (kind) {
    case "system_prompt_includes":
    case "system_prompt_excludes": {
      const request = parseOptionalRequestIndex(value.request, path);
      return {
        kind,
        substring: parseString(value.substring, path, "mechanism[].substring"),
        ...(request === undefined ? {} : { request }),
      };
    }
    case "request_count": {
      if (typeof value.count !== "number") fail(path, `mechanism[].count precisa ser number`);
      return { kind: "request_count", count: value.count };
    }
    case "message_roles_at_request": {
      if (typeof value.request !== "number") fail(path, `mechanism[].request precisa ser number`);
      if (!Array.isArray(value.roles) || !value.roles.every((role) => typeof role === "string")) {
        fail(path, `mechanism[].roles precisa ser string[]`);
      }
      return { kind: "message_roles_at_request", request: value.request, roles: value.roles };
    }
    case "tool_result_includes": {
      if (typeof value.request !== "number") fail(path, `mechanism[].request precisa ser number`);
      return {
        kind: "tool_result_includes",
        request: value.request,
        substring: parseString(value.substring, path, "mechanism[].substring"),
      };
    }
    case "message_content_includes": {
      if (typeof value.request !== "number") fail(path, `mechanism[].request precisa ser number`);
      return {
        kind: "message_content_includes",
        request: value.request,
        substring: parseString(value.substring, path, "mechanism[].substring"),
      };
    }
    case "envelope_pointer": {
      return {
        kind: "envelope_pointer",
        pointer: parseString(value.pointer, path, "mechanism[].pointer"),
        value: value.value,
      };
    }
    case "tools_include":
    case "tools_exclude": {
      if (typeof value.request !== "number") fail(path, `mechanism[].request precisa ser number`);
      return {
        kind,
        request: value.request,
        name: parseString(value.name, path, "mechanism[].name"),
      };
    }
    default:
      fail(path, `mechanism[].kind desconhecido: ${JSON.stringify(kind)}`);
  }
}

function parseSeedTurn(value: unknown, path: string): EvalSeedTurn {
  if (!isRecord(value)) fail(path, `session_seed[] precisa ser um objeto`);
  return {
    user: parseString(value.user, path, "session_seed[].user"),
    assistant: parseString(value.assistant, path, "session_seed[].assistant"),
  };
}

function parseOutcome(value: unknown, path: string): EvalOutcome {
  if (!isRecord(value)) fail(path, `"outcome" precisa ser um objeto`);
  return {
    question: parseString(value.question, path, "outcome.question"),
    expect: parseString(value.expect, path, "outcome.expect"),
  };
}

/** Valida um `EvalCase` cru (já parseado de JSON) contra o formato
 * declarado na issue #576: `{ input, cwd_fixture?, stub_script, mechanism,
 * outcome, budget_tokens }`, mais o `id` do próprio fixture. */
export function parseEvalCase(value: unknown, path: string, id: string): EvalCase {
  if (!isRecord(value)) fail(path, "o fixture não é um objeto JSON");
  if (!Array.isArray(value.mechanism)) fail(path, `"mechanism" precisa ser array`);
  if (typeof value.budget_tokens !== "number" || value.budget_tokens <= 0) {
    fail(path, `"budget_tokens" precisa ser number positivo`);
  }
  const result: EvalCase = {
    id,
    input: parseString(value.input, path, "input"),
    stubScript: parseStubScript(value.stub_script, path),
    mechanism: value.mechanism.map((assertion) => parseMechanismAssertion(assertion, path)),
    outcome: parseOutcome(value.outcome, path),
    budgetTokens: value.budget_tokens,
  };
  const fixture = parseFixture(value.cwd_fixture, path);
  const note = value.note;
  const sessionSeedRaw = value.session_seed;
  if (sessionSeedRaw !== undefined && !Array.isArray(sessionSeedRaw)) {
    fail(path, `"session_seed" precisa ser array`);
  }
  const sessionSeed = Array.isArray(sessionSeedRaw)
    ? sessionSeedRaw.map((turn) => parseSeedTurn(turn, path))
    : undefined;
  const contextWindowOverrideRaw = value.context_window_override;
  if (contextWindowOverrideRaw !== undefined && typeof contextWindowOverrideRaw !== "number") {
    fail(path, `"context_window_override" precisa ser number`);
  }
  return {
    ...result,
    ...(fixture === undefined ? {} : { cwdFixture: fixture }),
    ...(typeof note === "string" ? { note } : {}),
    ...(sessionSeed === undefined ? {} : { sessionSeed }),
    ...(typeof contextWindowOverrideRaw === "number"
      ? { contextWindowOverride: contextWindowOverrideRaw }
      : {}),
  };
}
