// Issue #576: os dois oráculos do harness. `evaluateMechanism` é
// determinístico e só olha para as requisições cruas capturadas do stub —
// nunca para o texto da resposta final. `evaluateOutcome` julga a resposta
// final contra a expectativa declarada no caso (regex), o mesmo teste tanto
// contra o stub (trivialmente satisfeito, já que o texto é scriptado) quanto
// contra um provedor real (onde o resultado varia de verdade).
import type {
  CapturedRequest,
  MechanismAssertion,
  MechanismResult,
  OutcomeResult,
} from "./types.js";

function messageAt(
  request: CapturedRequest | undefined,
  index: number,
): Record<string, unknown> | undefined {
  return request?.body.messages?.[index];
}

/** `request` é 1-indexado e por padrão mira a primeira requisição (o
 * comportamento histórico, preservado para todo fixture existente que não
 * declara `request`) — mas uma requisição de resumo de compactação
 * (`SUMMARY_SYSTEM`, `src/agent/aux.ts`) nunca é a primeira quando a
 * própria sessão compacta antes do turno real, e seu próprio system
 * prompt é o que precisa ser verificado nesse caso. */
function systemContent(requests: readonly CapturedRequest[], request = 1): string {
  const target = chatCompletionRequests(requests)[request - 1];
  const system = messageAt(target, 0);
  return system?.role === "system" && typeof system.content === "string" ? system.content : "";
}

/** Substring em QUALQUER mensagem (qualquer role) da requisição — usado
 * para conteúdo que sobrevive dentro de uma mensagem do MEIO do array
 * (ex.: o resumo sintético que uma compactação insere), não só a última
 * `tool` (`lastToolContent`) ou a primeira `system` (`systemContent`). */
function anyMessageContentIncludes(
  request: CapturedRequest | undefined,
  substring: string,
): boolean {
  return (request?.body.messages ?? []).some(
    (message) => typeof message.content === "string" && message.content.includes(substring),
  );
}

function rolesOf(request: CapturedRequest | undefined): readonly string[] {
  return (request?.body.messages ?? []).map((message) =>
    typeof message.role === "string" ? message.role : "",
  );
}

/** A última mensagem `role: "tool"` na requisição — o resultado que o
 * dispatcher devolveu ao modelo para a chamada de tool mais recente. */
function lastToolContent(request: CapturedRequest | undefined): string {
  const messages = request?.body.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "tool" && typeof message.content === "string") return message.content;
  }
  return "";
}

/** Só requisições de chat completions contam para `request_count` — um GET
 * incidental (ex.: probe de modelos) nunca deveria inflar a contagem de uma
 * assertion que existe para pegar retentativas indevidas. */
function chatCompletionRequests(requests: readonly CapturedRequest[]): readonly CapturedRequest[] {
  return requests.filter(
    (request) => request.method === "POST" && request.path === "/v1/chat/completions",
  );
}

function toolNamesOf(request: CapturedRequest | undefined): readonly string[] {
  return (request?.body.tools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => typeof name === "string");
}

function readPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  const segments = pointer.split("/").filter((segment) => segment.length > 0);
  let current: unknown = value;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function evaluateOne(
  assertion: MechanismAssertion,
  requests: readonly CapturedRequest[],
  envelope: unknown,
): MechanismResult {
  switch (assertion.kind) {
    case "system_prompt_includes": {
      const content = systemContent(requests, assertion.request);
      const passed = content.includes(assertion.substring);
      return {
        kind: assertion.kind,
        passed,
        detail: passed
          ? "substring presente no system prompt"
          : `substring ausente do system prompt (requisição ${String(assertion.request ?? 1)}): ${JSON.stringify(assertion.substring)}`,
      };
    }
    case "system_prompt_excludes": {
      const content = systemContent(requests, assertion.request);
      const passed = !content.includes(assertion.substring);
      return {
        kind: assertion.kind,
        passed,
        detail: passed
          ? "substring ausente do system prompt, como esperado"
          : `substring presente indevidamente no system prompt (requisição ${String(assertion.request ?? 1)}): ${JSON.stringify(assertion.substring)}`,
      };
    }
    case "request_count": {
      const observed = chatCompletionRequests(requests).length;
      const passed = observed === assertion.count;
      return {
        kind: assertion.kind,
        passed,
        detail: `esperado ${String(assertion.count)}, observado ${String(observed)}`,
      };
    }
    case "message_roles_at_request": {
      const request = chatCompletionRequests(requests)[assertion.request - 1];
      const roles = rolesOf(request);
      const passed = JSON.stringify(roles) === JSON.stringify(assertion.roles);
      return {
        kind: assertion.kind,
        passed,
        detail: `requisição ${String(assertion.request)}: esperado ${JSON.stringify(
          assertion.roles,
        )}, observado ${JSON.stringify(roles)}`,
      };
    }
    case "tool_result_includes": {
      const request = chatCompletionRequests(requests)[assertion.request - 1];
      const content = lastToolContent(request);
      const passed = content.includes(assertion.substring);
      return {
        kind: assertion.kind,
        passed,
        detail: passed
          ? "substring presente no resultado da tool"
          : `substring ausente do resultado da tool (requisição ${String(assertion.request)}): ${JSON.stringify(content)}`,
      };
    }
    case "message_content_includes": {
      const request = chatCompletionRequests(requests)[assertion.request - 1];
      const passed = anyMessageContentIncludes(request, assertion.substring);
      return {
        kind: assertion.kind,
        passed,
        detail: passed
          ? "substring presente em alguma mensagem da requisição"
          : `substring ausente de toda mensagem da requisição ${String(assertion.request)}: ${JSON.stringify(assertion.substring)}`,
      };
    }
    case "envelope_pointer": {
      const observed = readPointer(envelope, assertion.pointer);
      const passed = JSON.stringify(observed) === JSON.stringify(assertion.value);
      return {
        kind: assertion.kind,
        passed,
        detail: `${assertion.pointer}: esperado ${JSON.stringify(assertion.value)}, observado ${JSON.stringify(observed)}`,
      };
    }
    case "tools_include": {
      const request = chatCompletionRequests(requests)[assertion.request - 1];
      const names = toolNamesOf(request);
      const passed = names.includes(assertion.name);
      return {
        kind: assertion.kind,
        passed,
        detail: passed
          ? `"${assertion.name}" presente no catálogo da requisição ${String(assertion.request)}`
          : `"${assertion.name}" ausente do catálogo da requisição ${String(assertion.request)}: ${JSON.stringify(names)}`,
      };
    }
    case "tools_exclude": {
      const request = chatCompletionRequests(requests)[assertion.request - 1];
      const names = toolNamesOf(request);
      const passed = !names.includes(assertion.name);
      return {
        kind: assertion.kind,
        passed,
        detail: passed
          ? `"${assertion.name}" ausente do catálogo da requisição ${String(assertion.request)}, como esperado`
          : `"${assertion.name}" presente indevidamente no catálogo da requisição ${String(assertion.request)}`,
      };
    }
  }
}

/** Oráculo de mecanismo: cada assertion é avaliada independentemente contra
 * as requisições cruas que o stub capturou e o envelope final — nunca
 * contra a resposta final do provedor real, que `evaluateOutcome` julga. */
export function evaluateMechanism(
  assertions: readonly MechanismAssertion[],
  requests: readonly CapturedRequest[],
  envelope: unknown,
): readonly MechanismResult[] {
  return assertions.map((assertion) => evaluateOne(assertion, requests, envelope));
}

/** Oráculo de resultado: regex declarada em `outcome.expect` contra o texto
 * de saída do envelope. `"no-signal"` quando o turno não produziu saída
 * (erro, timeout) — nunca um `false` positivo silencioso. */
export function evaluateOutcome(
  outcome: { readonly question: string; readonly expect: string },
  output: string | null,
): OutcomeResult {
  if (output === null) return { question: outcome.question, verdict: "no-signal" };
  let pattern: RegExp;
  try {
    pattern = new RegExp(outcome.expect, "su");
  } catch (error) {
    throw new Error(`eval: outcome.expect não é uma regex válida: ${String(error)}`, {
      cause: error,
    });
  }
  return { question: outcome.question, verdict: pattern.test(output) ? "pass" : "fail" };
}
