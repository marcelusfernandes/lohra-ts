// Os 7 mutantes de `media/source.ts` (4 edits), `media/errors.ts` (2
// edits) e `tools/child.ts` (2 edits num único mutante) — issue #151,
// passo 0d do épico #13. Migrados de
// `scripts/parity/media/run-mutations.ts` (agora um shim); os `edits` em
// si não mudam. Três `probe`s de `source.ts` (`unsafe-url-*`) tinham uma
// chave (`runner_calls`) em `expected` que `actual` nunca produzia — ver o
// header de `media.ts`; corrigidas para o shape que `actual` de fato tem.
//
// `unsafe-url-scheme` também trocou o valor de entrada do `probe`
// (`file:///tmp/CANARY-T21` -> `ftp://example.test/CANARY-T21`): uma URL
// `file:` tem `hostname` vazio, e `validateRemoteImage` rejeita hostname
// vazio (`source.ts` — o guard SEGUINTE ao que este mutante desliga) antes
// mesmo de chegar no guard mutado — o mesmo mutante morto, mascarado pela
// mesma chave ausente. `ftp://example.test/...` tem hostname não-vazio e
// não é `localhost`/IP (`unsafeHost` deixa passar), então só o guard de
// protocolo (o mutado) decide; confirmado empiricamente contra o módulo
// carregado: mutado aceita, restaurado lança.
//
// `redaction-nested` também trocou os canários (`NESTED-CANARY-99`/
// `DEEP-CANARY-77` -> `secret-NESTED99`/`token-DEEPCANARY77`): `scrub()`
// (errors.ts) só redige URL/data-URI/Bearer/segredo com prefixo
// sk|key|token|secret — um canário que não bate nenhum padrão passa
// intacto mesmo pela recursão CORRETA (restaurada), então `restoreGreen`
// acusava falso positivo com os canários antigos. As outras duas
// (`redaction`, `child-deny`) já eram seguras nos dois caminhos (mutado e
// restaurado).
import type { MediaMutant } from "./media-mutant.js";
import { MAX_DATA_URI_BASE64_CHARS } from "../../src/media/constants.js";

const SOURCE = "media/source.ts";
const ERRORS = "media/errors.ts";
const CHILD = "tools/child.ts";

function asValidator(module: Record<string, unknown>): (value: string) => string {
  return module["validateRemoteImage"] as (value: string) => string;
}

export const otherMediaMutants: readonly MediaMutant[] = [
  {
    id: "unsafe-url-scheme",
    category: "validation",
    entry: SOURCE,
    edits: [
      {
        file: SOURCE,
        before: 'if (parsed.protocol !== "http:" && parsed.protocol !== "https:")',
        after: 'if (false && parsed.protocol !== "http:" && parsed.protocol !== "https:")',
      },
    ],
    expected: { status: "error" },
    probe: (moduleUnknown) => {
      const validate = asValidator(moduleUnknown);
      let accepted: boolean;
      try {
        accepted = validate("ftp://example.test/CANARY-T21") === "ftp://example.test/CANARY-T21";
      } catch {
        accepted = false;
      }
      return Promise.resolve({ status: accepted ? "ok" : "error" });
    },
  },
  {
    id: "unsafe-url-loopback",
    category: "validation",
    entry: SOURCE,
    edits: [
      {
        file: SOURCE,
        before: 'if (unsafeHost(parsed.hostname)) throw new Error("unsafe image host");',
        after: 'if (false && unsafeHost(parsed.hostname)) throw new Error("unsafe image host");',
      },
    ],
    expected: { status: "error" },
    probe: (moduleUnknown) => {
      const validate = asValidator(moduleUnknown);
      let accepted: boolean;
      try {
        accepted = validate("http://127.0.0.1/a") === "http://127.0.0.1/a";
      } catch {
        accepted = false;
      }
      return Promise.resolve({ status: accepted ? "ok" : "error" });
    },
  },
  {
    id: "unsafe-data",
    category: "validation",
    entry: SOURCE,
    edits: [
      {
        file: SOURCE,
        before: 'throw new Error("invalid image base64 payload");',
        after: "bytes = new Uint8Array(0);",
      },
    ],
    expected: { status: "error" },
    probe: (moduleUnknown) => {
      const validate = asValidator(moduleUnknown);
      let accepted: boolean;
      try {
        accepted = validate("data:image/png;base64,%%%") === "data:image/png;base64,%%%";
      } catch {
        accepted = false;
      }
      return Promise.resolve({ status: accepted ? "ok" : "error" });
    },
  },
  {
    id: "encoded-precheck",
    category: "validation",
    entry: SOURCE,
    edits: [
      {
        file: SOURCE,
        before: "if (payload.length > MAX_DATA_URI_BASE64_CHARS)",
        after: "if (false && payload.length > MAX_DATA_URI_BASE64_CHARS)",
      },
    ],
    expected: { decode_calls: 0 },
    probe: (moduleUnknown) => {
      const validate = moduleUnknown["validateRemoteImage"] as (
        value: string,
        options: { decode(value: string): Uint8Array },
      ) => string;
      let decodeCalls = 0;
      try {
        validate(`data:image/png;base64,${"A".repeat(MAX_DATA_URI_BASE64_CHARS + 4)}`, {
          decode: (value) => {
            decodeCalls += 1;
            return Buffer.from(value, "base64");
          },
        });
      } catch {
        // The decoded-size guard may still reject; the forbidden side effect is enough.
      }
      return Promise.resolve({ decode_calls: decodeCalls });
    },
  },
  {
    id: "redaction",
    category: "privacy",
    entry: ERRORS,
    edits: [
      {
        file: ERRORS,
        before: "return `${label}${name}: ${scrub(raw)}`;",
        after: "return raw;",
      },
    ],
    expected: { url_canary: false, data_canary: false, bearer_canary: false },
    probe: (moduleUnknown) => {
      const safeMessage = moduleUnknown["safeMediaMessage"] as (error: unknown) => string;
      const message = safeMessage(
        new Error(
          "https://example.test/a?secret=CANARY-URL data:image/png;base64,CANARYDATA== Bearer CANARY-TOKEN",
        ),
      );
      return Promise.resolve({
        url_canary: message.includes("https://example.test/a?secret=CANARY-URL"),
        data_canary: message.includes("data:image/png;base64,CANARYDATA"),
        bearer_canary: message.includes("Bearer CANARY-TOKEN"),
      });
    },
  },
  {
    id: "redaction-nested",
    category: "privacy",
    entry: ERRORS,
    edits: [
      {
        file: ERRORS,
        before: "return value.map((entry) => safeMediaValue(entry, depth + 1));",
        after: "return value;",
      },
    ],
    expected: { nested_canary: false },
    probe: (moduleUnknown) => {
      // `scrub()` (errors.ts) só redige URLs/data-URIs/Bearer/segredos com
      // prefixo sk|key|token|secret — um canário arbitrário como
      // "NESTED-CANARY-99" nunca bate nenhum desses padrões, então mesmo a
      // recursão correta (restaurada) o deixaria intacto, e `restoreGreen`
      // acusaria falso positivo. `secret-…`/`token-…` batem o padrão
      // SECRET, então só ficam de fora da mensagem quando a recursão
      // (mutada aqui) de fato roda.
      const safeValue = moduleUnknown["safeMediaValue"] as (value: unknown) => unknown;
      const projected = JSON.stringify(
        safeValue({ items: ["secret-NESTED99", { deep: "token-DEEPCANARY77" }] }),
      );
      return Promise.resolve({
        nested_canary:
          projected.includes("secret-NESTED99") || projected.includes("token-DEEPCANARY77"),
      });
    },
  },
  {
    id: "child-deny",
    category: "access-control",
    entry: CHILD,
    edits: [
      {
        file: CHILD,
        before: ".filter((definition) => !excluded.has(definition.function.name))",
        after: ".filter(() => true)",
      },
      {
        file: CHILD,
        before:
          "if (excluded.has(name)) {\n      return toolError(`the '${name}' tool is not available to subagents`);\n    }",
        after: 'if (false && excluded.has(name)) throw new Error("unreachable");',
      },
    ],
    expected: { base_calls: 0 },
    probe: async (moduleUnknown) => {
      const createDispatch = moduleUnknown["createChildDispatch"] as (
        base: (name: string) => Promise<string>,
      ) => (name: string, args: unknown) => Promise<string>;
      let baseCalls = 0;
      const dispatch = createDispatch((_name) => {
        baseCalls += 1;
        return Promise.resolve("unsafe");
      });
      await dispatch("image_gen", {});
      return { base_calls: baseCalls };
    },
  },
];
