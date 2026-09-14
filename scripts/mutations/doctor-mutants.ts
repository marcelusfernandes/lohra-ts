// Catálogo de mutação da fatia `doctor` (issue #636, follow-up da QA de
// 846b0b7f e das PRs #629/#632/#634): `src/doctor/**` e
// `src/commands/provider-detectado.ts` mudaram três vezes (#604, #631, #633)
// sem nenhuma fatia de mutação cobrindo esse código -- os 11 mutantes abaixo
// fecham essa lacuna. Mecânica A (`harness.ts`), mesmo molde de
// `self-update-mutants.ts`: cada mutante morre por um teste focado já
// existente em `tests/**` (nenhum teste novo -- `tests/cli-doctor.test.ts`,
// `tests/doctor-checks-ollama.test.ts`, `tests/chat-provider-detectado.test.ts`
// e `tests/providers.test.ts` não estão no `Files` desta issue; só são
// citados como oráculo, nunca editados).
import type { Mutant } from "./types.js";

const snapshot = "src/doctor/snapshot.ts";
const checks = "src/doctor/checks.ts";
const providers = "src/doctor/providers.ts";
const providerDetectado = "src/commands/provider-detectado.ts";

const cliDoctorFocus = "tests/cli-doctor.test.ts";
const doctorChecksOllamaFocus = "tests/doctor-checks-ollama.test.ts";
const chatProviderDetectadoFocus = "tests/chat-provider-detectado.test.ts";
const providersFocus = "tests/providers.test.ts";

export const doctorMutants: readonly Mutant[] = [
  {
    id: "D1-route-error-ignored",
    category: "route-error-ignored",
    mechanism: "family-a",
    focus: {
      file: cliDoctorFocus,
      test: "route.error (preferência subscription inativa): chat_default_provider é null e o warn ollama-sem-chave não emite",
    },
    edits: [
      {
        file: snapshot,
        before:
          'const chatDefaultProvider = route.error\n    ? null\n    : route.mode === "subscription"',
        after: 'const chatDefaultProvider = route.mode === "subscription"',
      },
    ],
  },
  {
    id: "D2-subscription-as-api-key",
    category: "subscription-as-api-key",
    mechanism: "family-a",
    focus: {
      file: cliDoctorFocus,
      test: "assinatura ativa + chave no .env: chat_default_provider é o provedor que chat realmente usa nessa rota",
    },
    edits: [
      {
        file: snapshot,
        before: "      ? CODEX_PROVIDER.name\n      : detectChatProvider(environment).provider;",
        after: "      ? detectChatProvider(environment).provider\n      : CODEX_PROVIDER.name;",
      },
    ],
  },
  {
    id: "D3-usable-without-ollama-alive",
    category: "usable-without-ollama-alive",
    mechanism: "family-a",
    focus: {
      file: cliDoctorFocus,
      test: "doctor --json: usable true, detected_provider null, chat_default_provider null (asserção cruzada com chat)",
    },
    edits: [
      {
        file: snapshot,
        before:
          '      hasApiKey ||\n      ollama.alive ||\n      (route.mode === "subscription" && (own !== null || codex !== null)),',
        after:
          '      hasApiKey ||\n      (route.mode === "subscription" && (own !== null || codex !== null)),',
      },
    ],
  },
  {
    id: "D4-usable-without-has-api-key",
    category: "usable-without-has-api-key",
    mechanism: "family-a",
    focus: {
      file: cliDoctorFocus,
      test: "home com chave fictícia e stub local: doctor usable:true, chat sem --provider completa",
    },
    edits: [
      {
        file: snapshot,
        before:
          '      hasApiKey ||\n      ollama.alive ||\n      (route.mode === "subscription" && (own !== null || codex !== null)),',
        after:
          '      ollama.alive ||\n      (route.mode === "subscription" && (own !== null || codex !== null)),',
      },
    ],
  },
  {
    id: "D5-ollama-ready-or",
    category: "ollama-ready-or",
    mechanism: "family-a",
    focus: {
      file: doctorChecksOllamaFocus,
      test: "é false sem modelos, mesmo vivo; true com pelo menos um modelo",
    },
    edits: [
      {
        file: checks,
        before: "  return ollama.alive && ollama.models.length > 0;",
        after: "  return ollama.alive || ollama.models.length > 0;",
      },
    ],
  },
  {
    id: "D6-keyless-gap-ignores-auth-route",
    category: "keyless-gap-ignores-auth-route",
    mechanism: "family-a",
    focus: {
      file: cliDoctorFocus,
      test: "route.error (preferência subscription inativa): chat_default_provider é null e o warn ollama-sem-chave não emite",
    },
    edits: [
      {
        file: checks,
        before:
          '  const ollamaKeylessGap: Check | null =\n    environment.auth_route === "api_key" &&\n    ollamaReady &&\n    environment.chat_default_provider === null',
        after:
          "  const ollamaKeylessGap: Check | null =\n    ollamaReady &&\n    environment.chat_default_provider === null",
      },
    ],
  },
  {
    id: "D7-keyless-gap-inverted-provider-check",
    category: "keyless-gap-inverted-provider-check",
    mechanism: "family-a",
    focus: {
      file: doctorChecksOllamaFocus,
      test: "Ollama vivo com um modelo, sem chave: provider é ok, ollama-sem-chave emite (não-regressão #631)",
    },
    edits: [
      {
        file: checks,
        before: "    environment.chat_default_provider === null",
        after: "    environment.chat_default_provider !== null",
      },
    ],
  },
  {
    id: "D8-keyless-gap-remedy-drops-flag",
    category: "keyless-gap-remedy-drops-flag",
    mechanism: "family-a",
    focus: {
      file: doctorChecksOllamaFocus,
      test: "com modelos: o warn ollama-sem-chave recomenda --provider ollama",
    },
    edits: [
      {
        file: checks,
        before: 'remedy: "lohra chat --provider ollama   # ou: export LOHRA_PROVIDER=ollama",',
        after: 'remedy: "export LOHRA_PROVIDER=ollama",',
      },
    ],
  },
  {
    id: "D9-detect-configured-provider-leaks-auto",
    category: "detect-configured-provider-leaks-auto",
    mechanism: "family-a",
    focus: {
      file: chatProviderDetectadoFocus,
      test: "sem nenhuma variável configurada, devolve provider: null, detail: null",
    },
    edits: [
      {
        file: providers,
        before:
          "    return resolved === AUTO_PROVIDER\n      ? { provider: null, error: null }\n      : { provider: resolved, error: null };",
        after: "    return { provider: resolved, error: null };",
      },
    ],
  },
  {
    id: "D10-detail-discarded-fail-open",
    category: "detail-discarded-fail-open",
    mechanism: "family-a",
    focus: {
      file: chatProviderDetectadoFocus,
      test: "LOHRA_PROVIDER apontando para um nome desconhecido vira 'detail', nunca engolido em silêncio",
    },
    edits: [
      {
        file: providerDetectado,
        before:
          "  const detection = detectConfiguredProvider(environment);\n  return { provider: detection.provider, detail: detection.error };",
        after:
          "  const detection = detectConfiguredProvider(environment);\n  return { provider: detection.provider, detail: null };",
      },
    ],
  },
  {
    id: "D11-provider-origin-none-as-api-key",
    category: "provider-origin-none-as-api-key",
    mechanism: "family-a",
    focus: {
      file: providersFocus,
      test: "exercises whitespace key and invalid provider through doctor",
    },
    edits: [
      {
        file: snapshot,
        before: 'detected === null ? "none" :',
        after: 'detected === null ? "api-key" :',
      },
    ],
  },
];
