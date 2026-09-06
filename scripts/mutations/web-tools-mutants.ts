// Catálogo de mutantes de `src/web/**` (issue #152, passo 0e do épico #13).
// Módulo de dados puro — sem efeito colateral no import, ao contrário de
// `web-tools.ts` (que roda o harness de verdade ao ser executado). O
// `tests/mutations-t20-catalog.test.ts` importa só este arquivo para pinar
// cada `before` contra o `src/web/**` de verdade, sem pagar o custo de rodar
// vitest em sandbox (mesmo padrão do catálogo de mutantes de
// workflow-durability, separado da orquestração).
//
// Os 9 mutantes são a migração do runner de paridade aposentado desta área
// (368 linhas, fora de escopo): alvos `src/web/connector.ts` ×3, `tool.ts`
// ×2, `fetch.ts` ×2, `search.ts`, `safety.ts`. Cada `focus` é um teste
// TypeScript já existente em `tests/web-*.test.ts` que a mutação vira
// vermelho — nenhum mutante foi afrouxado para caber num teste mais fraco.
import type { Mutant } from "./types.js";

const connector = "src/web/connector.ts";
const fetchFile = "src/web/fetch.ts";
const safety = "src/web/safety.ts";
const search = "src/web/search.ts";
const tool = "src/web/tool.ts";

const connectorTests = "tests/web-connector.test.ts";
const fetchTests = "tests/web-fetch.test.ts";
const safetyTests = "tests/web-safety.test.ts";
const searchTests = "tests/web-search.test.ts";
const toolTests = "tests/web-tool-chat.test.ts";

export const webToolsMutants: readonly Mutant[] = [
  {
    id: "a-peer-membership",
    category: "connector",
    mechanism:
      "peerVerdict para de checar se o peer pertence ao conjunto validado — todo peer público vira 'ok'",
    focus: { file: connectorTests, test: "pins the exact normative peer matrix" },
    edits: [
      {
        file: connector,
        before: '  if (memberAddressOf(peer, allowed) === null) return "not-in-validated-set";\n',
        after: "  void allowed;\n",
      },
    ],
  },
  {
    id: "b-connector-re-resolves",
    category: "connector",
    mechanism:
      "createPinnedConnector disca no hostname pedido em vez do endereço já validado — reintroduz a resolução que o pinning existe para evitar",
    focus: {
      file: connectorTests,
      test: "dials only the validated address without resolving and preserves host/sni/tls",
    },
    edits: [
      {
        file: connector,
        before: "        host: (allowed[0] as AddressRecord).address,\n",
        after: "        host: request.hostname,\n",
      },
    ],
  },
  {
    id: "c-reuse-first-hop-validation",
    category: "fetch",
    mechanism:
      "fetchUrl cacheia a primeira validação de URL num global e a reusa em todo hop seguinte — um redirect para um host diferente (ou não-público) nunca é revalidado",
    focus: {
      file: fetchTests,
      test: "follows relative, protocol-relative and cross-host redirects with per-hop validation",
    },
    edits: [
      {
        file: fetchFile,
        before:
          "    const validated = await validatePublicUrl(current, { resolver: deps.resolver });\n",
        after:
          "    const __t20Cache = globalThis as {\n      __t20Validation?: Awaited<ReturnType<typeof validatePublicUrl>>;\n    };\n    const validated = (__t20Cache.__t20Validation ??= await validatePublicUrl(current, {\n      resolver: deps.resolver,\n    }));\n",
      },
    ],
  },
  {
    id: "d-automatic-redirects",
    category: "fetch",
    mechanism:
      "fetchUrl passa a seguir redirects num laço interno que reusa o request original (sem revalidar) e trata Location ausente como string vazia em vez de recusar — perde a causa exata e a revalidação por hop",
    focus: {
      file: fetchTests,
      test: "follows four redirects to the body and fails the fifth after five requests",
    },
    edits: [
      {
        file: fetchFile,
        before: "    const response = await deps.connector.request(request);\n",
        after: "    let response = await deps.connector.request(request);\n",
      },
      {
        file: fetchFile,
        before:
          '    if (isRedirectStatus(response.status)) {\n      const location = response.headers["location"];\n      await response.stream.cancel();\n      if (location === undefined || location === "") {\n        throw new WebError("redirect response had no Location header");\n      }\n      current = new URL(location, current).href;\n      continue;\n    }\n',
        after:
          '    let followed = 0;\n    while (isRedirectStatus(response.status) && followed <= maxRedirects) {\n      followed += 1;\n      const location = response.headers["location"] ?? "";\n      await response.stream.cancel();\n      current = new URL(location, current).href;\n      response = await deps.connector.request({ ...request, url: current });\n    }\n    if (isRedirectStatus(response.status)) {\n      await response.stream.cancel();\n      throw new WebError(`too many redirects (more than ${String(maxRedirects)})`);\n    }\n',
      },
    ],
  },
  {
    id: "e-tls-verification-off",
    category: "connector",
    mechanism:
      "createPinnedConnector desliga a verificação do certificado TLS (rejectUnauthorized: false) — aceitaria qualquer certificado no host pinado",
    focus: {
      file: connectorTests,
      test: "dials only the validated address without resolving and preserves host/sni/tls",
    },
    edits: [
      {
        file: connector,
        before:
          "        servername: secure && !isIpLiteral(request.hostname) ? request.hostname : null,\n        rejectUnauthorized: true,",
        after:
          "        servername: secure && !isIpLiteral(request.hostname) ? request.hostname : null,\n        rejectUnauthorized: false,",
      },
    ],
  },
  {
    id: "f-userinfo-accepted",
    category: "safety",
    mechanism:
      "validatePublicUrl para de recusar URLs com credenciais embutidas (user:pass@host) — decision 1 do oráculo deixa de valer",
    // O título completo do teste tem "(decision 1)" no fim; `-t` do vitest
    // trata o padrão como regex e parênteses não escapados não casam com os
    // parênteses literais do título, então o foco usa só o prefixo — único
    // dentro do arquivo (conferido em tests/mutations-t20-catalog.test.ts).
    focus: { file: safetyTests, test: "refuses userinfo before any resolution" },
    edits: [
      {
        file: safety,
        before:
          '  if (authority.authority.includes("@")) {\n    throw new WebError("refusing URL with embedded credentials");\n  }\n',
        after: "  void authority;\n",
      },
    ],
  },
  {
    id: "g-max-results-11",
    category: "tool",
    mechanism:
      "coerceMaxResults aceita 11 resultados em vez de travar em MAX_SEARCH_RESULTS (10) — o teto do web_search fica frouxo em um",
    focus: { file: toolTests, test: "covers the full max_results coercion table" },
    edits: [
      {
        file: tool,
        before: "  return Math.max(1, Math.min(parsed, MAX_SEARCH_RESULTS));\n",
        after: "  return Math.max(1, Math.min(parsed, MAX_SEARCH_RESULTS + 1));\n",
      },
    ],
  },
  {
    id: "h-ddg-byte-cap-removed",
    category: "search",
    mechanism:
      "readBodyCapped para de aplicar o teto de 2_000_000 bytes na resposta do DuckDuckGo antes de decodificar/parsear — decision 3 do oráculo deixa de valer",
    // Mesmo motivo do foco de `f-userinfo-accepted`: o título completo tem
    // "(decision 3)", e parênteses não escapados quebram o `-t` do vitest.
    focus: {
      file: searchTests,
      test: "applies the byte cap before decode/parse",
    },
    edits: [
      {
        file: search,
        before:
          "    const space = maxBytes - total;\n    if (chunk.length > space) {\n      await response.stream.cancel();\n      return { bytes: Buffer.concat(chunks), exceeded: true };\n    }\n    chunks.push(Buffer.from(chunk));\n    total += chunk.length;\n    if (total > maxBytes) {\n      await response.stream.cancel();\n      return { bytes: Buffer.concat(chunks), exceeded: true };\n    }\n",
        after: "    chunks.push(Buffer.from(chunk));\n    total += chunk.length;\n",
      },
    ],
  },
  {
    id: "i-envelope-cause-removed",
    category: "tool",
    mechanism:
      "webFetchHandler troca a causa exata do WebError por um literal genérico ('fetch failed') — o envelope de erro perde a causa que o chamador precisa",
    focus: {
      file: toolTests,
      test: "delivers security causes as plain WebError envelopes",
    },
    edits: [
      {
        file: tool,
        before: "    if (error instanceof WebError) return toolError(error.message, { url });\n",
        after: '    if (error instanceof WebError) return toolError("fetch failed", { url });\n',
      },
    ],
  },
];
