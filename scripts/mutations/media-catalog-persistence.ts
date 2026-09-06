// Os 13 mutantes de `media/persistence.ts` (issue #151, passo 0d do épico
// #13) — migrados do runner de paridade aposentado desta área; os `edits`
// de todos os 13 são byte a byte os do runner antigo —
// só o oráculo (`expected`/`probe`) muda, nos casos abaixo (regra
// acrescentada ao AC 3 da issue #151 depois da rodada 1 da PR #176, que
// tinha um 4º edit sobre uma premissa refutada — ver `out-dir-symlink`).
//
// Cinco `probe`s mudaram (contagem exata — ver o header de `media.ts`, que
// soma os 9 do catálogo inteiro): `over-return`, `per-image-limit` e
// `batch-limit` não tratavam o `throw` do guard real (a árvore restaurada
// quebraria a função em vez de produzir um `actual` comparável) —
// encapsulado em try/catch, sem tocar os `edits`; `out-dir-symlink`, abaixo;
// `atomic-rename-primitive`, cujo `probe` checava uma string que o
// transpilador nunca produz literalmente (comentário inline no próprio
// mutante). Os outros oito já eram seguros nos dois caminhos.
//
// `out-dir-symlink`: `expected` tinha só `status`/`external_count` e o
// `probe` descartava a mensagem do `catch` — com a árvore restaurada,
// `actual` teria `returned_count` (chave que `expected` não declarava) e
// SEM ela `actual` nunca batia `expected`, mutado ou não (rodada 1,
// PR #176: revisor "seis checks verdes... 19/20 preservam os edits";
// achado de que os 3 edits eram "mortos" era o próprio bug — o defeito
// real era só a chave ausente). Reprodução (`git log -S`, saídas reais):
//
//   $ git log -S 'checkControlledRoot(plan);' --oneline -- src/media/persistence.ts
//   9879c7b fix(media): isolate publish hooks from staged bytes
//   $ git log -S 'out-dir-symlink' --oneline -- ':(glob)**/media/run-mutations.ts'
//   e7bf4f5 feat(media): add bounded vision and image generation
//
//   (9879c7b é POSTERIOR a e7bf4f5 — a defesa em profundidade dentro de
//   `assertRootIdentity`, persistence.ts:143, é mais nova que o mutante;
//   mas ela muda a MENSAGEM do erro, não faz o mutante parar de divergir.)
//
//   baseline  {"status":"error","external_count":0,"returned_count":0,"error_named":"output root changed after preflight"}
//   3 edits   {"status":"error","external_count":0,"returned_count":0,"error_named":"output root contains a symlink"}
//
// `error_named` diverge (a exceção migra de `persistence.ts:191-194`, o
// catch do preflight, para `checkControlledRoot(plan)` dentro de
// `assertRootIdentity`, persistence.ts:143→69, chamado via
// `runPublishHooks` — não tocado por nenhum dos 3 edits) — o mutante É
// observável, só não pelas chaves que o `probe` checava. Corrigido
// acrescentando `error_named` a `expected` e ao `probe` (mesmo padrão de
// `root-identity`, abaixo), sem tocar os `edits`.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_IMAGE_BATCH_BYTES, MAX_IMAGE_BYTES } from "../../src/media/constants.js";
import type { MediaMutant } from "./media-mutant.js";

const ENTRY = "media/persistence.ts";

interface PersistenceModule {
  createOutputPlan(path: string): unknown;
  persistGeneratedImages(options: Record<string, unknown>): Promise<readonly string[]>;
}

function persistence(module: Record<string, unknown>): PersistenceModule {
  return module as unknown as PersistenceModule;
}

export const persistenceMutants: readonly MediaMutant[] = Object.freeze([
  {
    id: "over-return",
    category: "limits",
    entry: ENTRY,
    edits: [
      {
        file: ENTRY,
        before: "if (options.payloads.length > options.requested)",
        after: "if (false && options.payloads.length > options.requested)",
      },
      {
        file: ENTRY,
        before: "if (options.payloads.length > MAX_IMAGES)",
        after: "if (false && options.payloads.length > MAX_IMAGES)",
      },
    ],
    expected: { status: "error", final_count: 0 },
    probe: async (moduleUnknown) => {
      const media = persistence(moduleUnknown);
      const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-over-return-"));
      try {
        const ids = Array.from({ length: 12 }, (_, index) => index.toString(16).padStart(32, "0"));
        let status = "ok";
        let count = 0;
        try {
          const paths = await media.persistGeneratedImages({
            plan: media.createOutputPlan(join(runtime, "images")),
            payloads: Array.from({ length: 12 }, () => "YQ=="),
            requested: 1,
            uuid: () => ids.shift() ?? "f".repeat(32),
          });
          count = paths.length;
        } catch {
          status = "error";
        }
        return { status, final_count: count };
      } finally {
        rmSync(runtime, { recursive: true, force: true });
      }
    },
  },
  {
    id: "per-image-limit",
    category: "limits",
    entry: ENTRY,
    edits: [
      {
        file: ENTRY,
        before: "if (bytes.byteLength > MAX_IMAGE_BYTES)",
        after: "if (false && bytes.byteLength > MAX_IMAGE_BYTES)",
      },
    ],
    expected: { status: "error", final_count: 0 },
    probe: async (moduleUnknown) => {
      const media = persistence(moduleUnknown);
      const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-item-"));
      try {
        let status = "ok";
        let count = 0;
        try {
          const paths = await media.persistGeneratedImages({
            plan: media.createOutputPlan(join(runtime, "images")),
            payloads: [Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64")],
            requested: 1,
            uuid: () => "a".repeat(32),
          });
          count = paths.length;
        } catch {
          status = "error";
        }
        return { status, final_count: count };
      } finally {
        rmSync(runtime, { recursive: true, force: true });
      }
    },
  },
  {
    id: "batch-limit",
    category: "limits",
    entry: ENTRY,
    edits: [
      {
        file: ENTRY,
        before: "if (batchBytes > MAX_IMAGE_BATCH_BYTES)",
        after: "if (false && batchBytes > MAX_IMAGE_BATCH_BYTES)",
      },
    ],
    expected: { status: "error", final_count: 0 },
    probe: async (moduleUnknown) => {
      const media = persistence(moduleUnknown);
      const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-batch-"));
      try {
        const chunk = Buffer.alloc(Math.floor(MAX_IMAGE_BATCH_BYTES / 4) + 1).toString("base64");
        const ids = ["a", "b", "c", "d"].map((value) => value.repeat(32));
        let status = "ok";
        let count = 0;
        try {
          const paths = await media.persistGeneratedImages({
            plan: media.createOutputPlan(join(runtime, "images")),
            payloads: [chunk, chunk, chunk, chunk],
            requested: 4,
            uuid: () => ids.shift() ?? "e".repeat(32),
          });
          count = paths.length;
        } catch {
          status = "error";
        }
        return { status, final_count: count };
      } finally {
        rmSync(runtime, { recursive: true, force: true });
      }
    },
  },
  {
    id: "out-dir-symlink",
    category: "path-safety",
    entry: ENTRY,
    edits: [
      {
        file: ENTRY,
        before: "try {\n    checkControlledRoot(options.plan);\n  } catch {",
        after: "try {\n    void options.plan;\n  } catch {",
      },
      {
        file: ENTRY,
        before:
          "mkdirSync(options.plan.outDir, { recursive: true });\n  checkControlledRoot(options.plan);",
        after: "mkdirSync(options.plan.outDir, { recursive: true });\n  void options.plan;",
      },
      {
        file: ENTRY,
        before: "    current.isSymbolicLink() ||\n    !current.isDirectory() ||",
        after: "    false ||\n    false ||",
      },
    ],
    expected: {
      status: "error",
      external_count: 0,
      returned_count: 0,
      error_named: "output root changed after preflight",
    },
    probe: async (moduleUnknown) => {
      const media = persistence(moduleUnknown);
      const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-root-"));
      const external = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-external-"));
      try {
        const outDir = join(runtime, "images");
        let paths: readonly string[] = [];
        let status = "ok";
        let errorName = "none";
        try {
          paths = await media.persistGeneratedImages({
            plan: media.createOutputPlan(outDir),
            payloads: ["YQ=="],
            requested: 1,
            uuid: () => "a".repeat(32),
            afterRootPreflight: () => {
              symlinkSync(external, outDir);
            },
          });
        } catch (error) {
          status = "error";
          errorName = error instanceof Error ? error.message : String(error);
        }
        return {
          status,
          external_count: readdirSync(external).length,
          returned_count: paths.length,
          error_named: errorName,
        };
      } finally {
        rmSync(runtime, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    },
  },
  {
    id: "direct-final-write",
    category: "atomicity",
    entry: ENTRY,
    edits: [
      {
        file: ENTRY,
        before: "const temp = join(options.plan.outDir, `.stage-${randomUUID()}.tmp`);",
        after: "const temp = final;",
      },
      {
        file: ENTRY,
        before: "cleanupFailures = removeOwnedPaths(owned);",
        after: "void owned;",
      },
    ],
    expected: { final_exists: false, final_bytes: 0 },
    probe: async (moduleUnknown) => {
      const media = persistence(moduleUnknown);
      const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-final-"));
      const final = join(runtime, "images", `${"a".repeat(32)}.png`);
      try {
        try {
          await media.persistGeneratedImages({
            plan: media.createOutputPlan(join(runtime, "images")),
            payloads: [Buffer.from("complete-image").toString("base64")],
            requested: 1,
            uuid: () => "a".repeat(32),
            faultAfterBytes: 7,
          });
        } catch {
          // The comparator observes the forbidden final, not the thrown fault.
        }
        return {
          final_exists: existsSync(final),
          final_bytes: existsSync(final) ? readFileSync(final).length : 0,
        };
      } finally {
        rmSync(runtime, { recursive: true, force: true });
      }
    },
  },
  {
    id: "hook-after-staging",
    category: "hook-timing",
    entry: ENTRY,
    edits: [
      {
        file: ENTRY,
        before:
          "  await runPublishHooks(options.plan, finals, rootIdentity, options.beforePublish);",
        after: "  void options.beforePublish;",
      },
      {
        file: ENTRY,
        before: "        fsyncSync(fd);",
        after: "        await options.beforePublish?.(index, final);\n        fsyncSync(fd);",
      },
    ],
    expected: { stages_visible_to_hook: 0 },
    probe: async (moduleUnknown) => {
      const media = persistence(moduleUnknown);
      const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-stage-"));
      try {
        const outDir = join(runtime, "images");
        let observedStages = -1;
        await media.persistGeneratedImages({
          plan: media.createOutputPlan(outDir),
          payloads: [Buffer.from("provider").toString("base64")],
          requested: 1,
          uuid: () => "a".repeat(32),
          beforePublish: () => {
            observedStages = readdirSync(outDir).filter((name) =>
              name.startsWith(".stage-"),
            ).length;
          },
        });
        return { stages_visible_to_hook: observedStages };
      } finally {
        rmSync(runtime, { recursive: true, force: true });
      }
    },
  },
  {
    id: "stage-mode",
    category: "permissions",
    entry: ENTRY,
    edits: [
      {
        file: ENTRY,
        before: "fchmodSync(fd, IMAGE_FILE_MODE);",
        after: "void IMAGE_FILE_MODE;",
      },
      {
        file: ENTRY,
        before: "chmodSync(temp, IMAGE_FILE_MODE);",
        after: "void IMAGE_FILE_MODE;",
      },
    ],
    expected: { status: "ok", final_mode: 0o644 },
    probe: async (moduleUnknown) => {
      const media = persistence(moduleUnknown);
      const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-mode-"));
      const outDir = join(runtime, "images");
      try {
        const final = join(outDir, `${"a".repeat(32)}.png`);
        let mode = -1;
        let status = "ok";
        try {
          const paths = await media.persistGeneratedImages({
            plan: media.createOutputPlan(outDir),
            payloads: [Buffer.from("provider").toString("base64")],
            requested: 1,
            uuid: () => "a".repeat(32),
          });
          mode = statSync(paths[0] ?? final).mode & 0o777;
        } catch {
          status = "error";
        }
        return { status, final_mode: mode };
      } finally {
        rmSync(runtime, { recursive: true, force: true });
      }
    },
  },
  {
    id: "write-fault-cleanup",
    category: "cleanup",
    entry: ENTRY,
    edits: [
      {
        file: ENTRY,
        before: "cleanupFailures = removeOwnedPaths(owned);",
        after: "void owned;",
      },
    ],
    expected: { status: "error", residue: 0 },
    probe: async (moduleUnknown) => {
      const media = persistence(moduleUnknown);
      const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-owned-"));
      const outDir = join(runtime, "images");
      try {
        let status = "ok";
        try {
          await media.persistGeneratedImages({
            plan: media.createOutputPlan(outDir),
            payloads: [Buffer.from("provider").toString("base64")],
            requested: 1,
            uuid: () => "a".repeat(32),
            faultAfterBytes: 7,
          });
        } catch {
          status = "error";
        }
        const residue = readdirSync(outDir).filter((name) => name.startsWith(".stage-")).length;
        return { status, residue };
      } finally {
        rmSync(runtime, { recursive: true, force: true });
      }
    },
  },
  {
    id: "root-identity",
    category: "root-identity",
    entry: ENTRY,
    edits: [
      {
        file: ENTRY,
        before: 'throw new Error("output root changed after publish hook");',
        after: "void 0;",
      },
    ],
    expected: {
      status: "error",
      error_named: "output root changed after publish hook",
      final_count: 0,
    },
    probe: async (moduleUnknown) => {
      const media = persistence(moduleUnknown);
      const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-rootid-"));
      try {
        const outDir = join(runtime, "images");
        const moved = join(runtime, "moved");
        const payload = Buffer.from("PRIVATE-PROVIDER-BYTES");
        let errorName = "none";
        try {
          await media.persistGeneratedImages({
            plan: media.createOutputPlan(outDir),
            payloads: [payload.toString("base64")],
            requested: 1,
            uuid: () => "d".repeat(32),
            beforePublish: () => {
              renameSync(outDir, moved);
              mkdirSync(outDir);
            },
          });
        } catch (error) {
          errorName = error instanceof Error ? error.message : String(error);
        }
        return {
          status: "error",
          error_named: errorName,
          final_count: existsSync(join(outDir, `${"d".repeat(32)}.png`)) ? 1 : 0,
        };
      } finally {
        rmSync(runtime, { recursive: true, force: true });
      }
    },
  },
  {
    id: "publish-hook-omitted",
    category: "root-identity",
    entry: ENTRY,
    edits: [
      {
        file: ENTRY,
        before:
          "  await runPublishHooks(options.plan, finals, rootIdentity, options.beforePublish);",
        after: "  void options.beforePublish;",
      },
    ],
    expected: { status: "error", hook_ran: true },
    probe: async (moduleUnknown) => {
      const media = persistence(moduleUnknown);
      const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-reloc-"));
      try {
        const outDir = join(runtime, "images");
        const moved = join(runtime, "moved");
        let status = "ok";
        try {
          await media.persistGeneratedImages({
            plan: media.createOutputPlan(outDir),
            payloads: [Buffer.from("PRIVATE-PROVIDER-BYTES").toString("base64")],
            requested: 1,
            uuid: () => "d".repeat(32),
            beforePublish: () => {
              renameSync(outDir, moved);
              mkdirSync(outDir);
            },
          });
        } catch {
          status = "error";
        }
        return { status, hook_ran: existsSync(moved) };
      } finally {
        rmSync(runtime, { recursive: true, force: true });
      }
    },
  },
  {
    id: "root-check-before-hook",
    category: "root-identity",
    entry: ENTRY,
    edits: [
      {
        file: ENTRY,
        before: "    await hook?.(index, final);\n    assertRootIdentity(plan, rootIdentity);",
        after: "    assertRootIdentity(plan, rootIdentity);\n    await hook?.(index, final);",
      },
      {
        file: ENTRY,
        before: "      assertRootIdentity(options.plan, rootIdentity);",
        after: "      void rootIdentity;",
      },
    ],
    expected: { status: "error", final_count: 0 },
    probe: async (moduleUnknown) => {
      const media = persistence(moduleUnknown);
      const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-check-order-"));
      try {
        const outDir = join(runtime, "images");
        const moved = join(runtime, "moved");
        let status = "ok";
        try {
          await media.persistGeneratedImages({
            plan: media.createOutputPlan(outDir),
            payloads: [Buffer.from("PRIVATE-PROVIDER-BYTES").toString("base64")],
            requested: 1,
            uuid: () => "d".repeat(32),
            beforePublish: () => {
              renameSync(outDir, moved);
              mkdirSync(outDir);
            },
          });
        } catch {
          status = "error";
        }
        return {
          status,
          final_count: readdirSync(outDir).filter((name) => name.endsWith(".png")).length,
        };
      } finally {
        rmSync(runtime, { recursive: true, force: true });
      }
    },
  },
  {
    id: "root-symlink-after-check",
    category: "root-identity",
    entry: ENTRY,
    edits: [
      {
        file: ENTRY,
        before: "    await hook?.(index, final);\n    assertRootIdentity(plan, rootIdentity);",
        after: "    assertRootIdentity(plan, rootIdentity);\n    await hook?.(index, final);",
      },
      {
        file: ENTRY,
        before: "      assertRootIdentity(options.plan, rootIdentity);",
        after: "      void rootIdentity;",
      },
    ],
    expected: { status: "error", external_payloads: 0 },
    probe: async (moduleUnknown) => {
      const media = persistence(moduleUnknown);
      const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-rootlink-"));
      const external = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-rootlink-external-"));
      try {
        const outDir = join(runtime, "images");
        const moved = join(runtime, "moved");
        let status = "ok";
        try {
          await media.persistGeneratedImages({
            plan: media.createOutputPlan(outDir),
            payloads: [Buffer.from("PRIVATE-PROVIDER-BYTES").toString("base64")],
            requested: 1,
            uuid: () => "d".repeat(32),
            beforePublish: () => {
              renameSync(outDir, moved);
              symlinkSync(external, outDir);
            },
          });
        } catch {
          status = "error";
        }
        return {
          status,
          external_payloads: readdirSync(external).filter((name) => name.endsWith(".png")).length,
        };
      } finally {
        rmSync(runtime, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    },
  },
  {
    id: "atomic-rename-primitive",
    category: "atomicity",
    entry: ENTRY,
    edits: [
      {
        file: ENTRY,
        before: "  renameSync,\n  rmSync,",
        after: "  linkSync,\n  rmSync,",
      },
      {
        file: ENTRY,
        before: "      renameSync(temp, final);",
        after: "      linkSync(temp, final);\n      rmSync(temp);",
      },
    ],
    expected: { primitive: "rename" },
    probe: (moduleUnknown) => {
      // `Function.prototype.toString()` reflete a fonte JÁ TRANSPILADA
      // (tsx/esbuild despe espaços: "renameSync(temp,final)", sem espaço
      // após a vírgula) — checar por substring sem espaço é frágil ao
      // formato do minificador; checar presença de `renameSync(` e
      // ausência de `linkSync(` não depende de como o transpilador
      // formata a chamada.
      const implementation = String(moduleUnknown["persistGeneratedImages"]);
      const usesRename =
        implementation.includes("renameSync(") && !implementation.includes("linkSync(");
      return Promise.resolve({
        primitive: usesRename ? "rename" : "other",
      });
    },
  },
]);
