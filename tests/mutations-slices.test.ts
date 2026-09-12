// Teste da issue #154 (passo 0 do épico #13): `scripts/mutations/slices.json`
// é o mapa declarado `src/**` -> fatia -> script -> catálogo que o passo 11
// de `orquestracao.md` hoje decide de cabeça. Este teste prova:
//
//   1. o schema básico de cada entrada;
//   2. todo catálogo de dado puro sob `scripts/mutations/` aparece em algum
//      `catalog` do JSON — descoberta por CONTEÚDO (`export const
//      ...Mutants`), não por nome de arquivo (issue #195: o padrão antigo
//      `*-mutants.ts$`/`catalog.*\.ts$` não casava `orchestration.ts` nem
//      `workflow-durability-{guard,named}.ts`), com um allowlist explícito
//      dos RUNNERS que reexportam um `Mutants` agregado sem serem, eles
//      mesmos, o catálogo — um catálogo novo, de qualquer nome, sem entrada
//      em `slices.json` reprova aqui;
//   3. os `catalog` do JSON batem, como conjunto, com os dez catálogos de
//      dado puro importados abaixo — um `catalog` novo no JSON sem import
//      correspondente aqui (ou vice-versa) reprova, o que impede o número
//      da contagem de driftar silenciosamente do JSON;
//   4. todo `script` de cada entrada existe em `package.json#scripts`;
//   5. todo `focusFiles[]` existe em disco, e (exceto `media`, que não tem
//      conceito de teste focal, e `workflow-executor`, que roda a mesma
//      bateria inteira para cada mutante em vez de afunilar por `focus`)
//      bate exatamente com a união dos `focus.file` dos mutantes do(s)
//      catálogo(s) da fatia;
//   6. a contagem total de mutantes é a soma exata dos catálogos — os dez
//      arquivos de dado puro (issue #186: `workflow-executor-mutants.ts`
//      entrou nessa lista, extraído do runner que antes embutia o
//      catálogo) são importados de verdade (`import` estático, sem efeito
//      colateral: nenhum chama `main()` no escopo do módulo) e somados via
//      o mapa `CATALOGOS`;
//   7. todo diretório de primeiro nível de `src/` está coberto por algum
//      `srcGlobs` de alguma fatia OU está na lista `SEM_FATIA` abaixo, com
//      motivo não-vazio e diretório que ainda existe -- um diretório novo
//      sem entrada em nenhum dos dois reprova, e uma entrada morta em
//      `SEM_FATIA` (diretório apagado ou motivo vazio) também reprova
//      (mesma convenção de "sem entrada morta" de
//      `tests/mutations-directory-pin.test.ts`).
//   8. (issue #195, achados das PRs #185/#193) `srcGlobs` cobre todo
//      `edits[].file` (normalizado para caminho relativo à raiz do repo)
//      dos catálogos de cada fatia sob `src/` -- `src/<dir>/**` casa por
//      prefixo, `src/<arquivo>.ts` casa só esse arquivo de topo (mesma
//      forma aceita por `scripts/github/mutations-matrix.ts`). Um
//      `edits[].file` normalizado que não está sob `src/` precisa estar no
//      allowlist explícito `FORA_DE_SRC` (fixtures de `scripts/mutations/`,
//      que não precisam de `srcGlobs` -- mudar `scripts/mutations/**` já
//      seleciona toda fatia) ou o teste lança -- fail-closed: nenhum
//      `edits[].file` sai da checagem por um filtro silencioso.
//   9. descoberta de catálogo por CONTEÚDO (`export const ...Mutants`), não
//      por nome de arquivo -- um catálogo com naming fora do padrão antigo
//      (`orchestration.ts`, `workflow-durability-guard.ts`) ou um catálogo
//      novo qualquer sem entrada em `slices.json` reprova; os RUNNERS que
//      reexportam um `Mutants` agregado (`media.ts`, `workflow-durability.ts`)
//      são a única exceção explícita.
//  10. contagem por catálogo (`CONTAGEM_POR_CATALOGO`) além da soma 173 --
//      uma troca compensatória entre dois catálogos (um ganha o que o outro
//      perde, soma preservada) reprova aqui mesmo sem mudar o total.
//
// Catálogos que são pura estrutura de dado (sem `main()` de topo) e por
// isso seguros para `import` estático dentro deste arquivo de teste:
// `workflow-durability-guard.ts`, `workflow-durability-named.ts`,
// `orchestration.ts` e `workflow-executor-mutants.ts` (nenhum importa
// `node:child_process`), mais os cinco que casam com o padrão
// `*-mutants.ts`/`*catalog*.ts`. Os seis RUNNERS de verdade
// (`workflow-executor.ts`, `workflow-durability.ts`,
// `workflow-audit-live.ts`, `web-tools.ts`, `media.ts`, `self-update.ts`)
// não entram neste arquivo de teste — desde a issue #186 todos exportam
// `main` atrás de uma guarda de entry-point (`ehEntryPoint`,
// `scripts/mutations/harness.ts`) e `tests/mutations-runner-guard.test.ts`
// prova que importá-los nunca dispara `main()`. Dois deles (`media.ts`,
// `workflow-durability.ts`) exportam um `Mutants` AGREGADO (união dos
// catálogos reais, só para o próprio runner rodar) — `NAO_CATALOGO` abaixo
// é o que os exclui da descoberta por conteúdo (item 2 do cabeçalho), não a
// ausência de um export `Mutants` (issue #195, achado da PR #193: nenhum
// dos dois é, ele mesmo, um `catalog` de `slices.json`).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { mutants as authMutants } from "../scripts/mutations/auth-mutants.js";
import { combinedMutants, guardMutants } from "../scripts/mutations/workflow-durability-guard.js";
import { contextWindowMutants } from "../scripts/mutations/context-window.js";
import { otherMediaMutants } from "../scripts/mutations/media-catalog-other.js";
import { persistenceMutants } from "../scripts/mutations/media-catalog-persistence.js";
import { orchestrationMutants } from "../scripts/mutations/orchestration.js";
import { mutants as selfUpdateMutants } from "../scripts/mutations/self-update-mutants.js";
import { supervisionMutants } from "../scripts/mutations/supervision-mutants.js";
import { mutants as auditLiveMutants } from "../scripts/mutations/workflow-audit-live-mutants.js";
import { auditProducersMutants } from "../scripts/mutations/workflow-audit-producers-mutants.js";
import { namedMutants } from "../scripts/mutations/workflow-durability-named.js";
import { webToolsMutants } from "../scripts/mutations/web-tools-mutants.js";
import {
  executorMutants,
  focalTests as executorFocalTests,
} from "../scripts/mutations/workflow-executor-mutants.js";

const repoRoot = resolve(import.meta.dirname, "..");
const slicesPath = resolve(repoRoot, "scripts/mutations/slices.json");
const mutationsDir = resolve(repoRoot, "scripts/mutations");

/** Arquivos de `scripts/mutations/` que reexportam um `export const
 * ...Mutants` AGREGADO (união de catálogos já declarados em `slices.json`,
 * só para uso do próprio runner) ou são harness/tipo/auxiliar sem catálogo
 * próprio -- não entram na descoberta por conteúdo do item 2 do cabeçalho
 * (issue #195, pino 2). `media.ts` (`mediaMutants`) e
 * `workflow-durability.ts` (`durabilityMutants`) são os dois casos reais de
 * agregação; os demais não exportam nenhum `Mutants` (ver grep no PR). */
const NAO_CATALOGO = new Set([
  "all.ts",
  "canonical.ts",
  "harness.ts",
  "types.ts",
  "media.ts",
  "media-comparator.ts",
  "media-mutant.ts",
  "self-update.ts",
  "supervision.ts",
  "web-tools.ts",
  "workflow-audit-live.ts",
  "workflow-durability.ts",
  "workflow-executor.ts",
  "auth.ts",
]);

const CATALOG_EXPORT_PATTERN = /export const [A-Za-z_]*[Mm]utants\b/;

/** Descobre, por CONTEÚDO (não por nome de arquivo), quais entradas de
 * `scripts/mutations/` são catálogos de dado puro: um `.ts` de primeiro
 * nível fora de `NAO_CATALOGO` que exporta `export const ...Mutants` (ou o
 * `mutants` literal de `self-update-mutants.ts`/`workflow-audit-live-mutants.ts`).
 * Pura -- não lê disco -- para caber num teste com um catálogo fabricado só
 * na memória (issue #195, AC 2: "mutação manual colada"). */
function discoverCatalogNames(
  files: readonly { readonly name: string; readonly contents: string }[],
): readonly string[] {
  return files
    .filter((file) => !NAO_CATALOGO.has(file.name))
    .filter((file) => CATALOG_EXPORT_PATTERN.test(file.contents))
    .map((file) => file.name);
}

/** Os catálogos descobertos por conteúdo que NÃO estão em `declared` --
 * vazio quando tudo bate. A mesma checagem roda contra o disco real e
 * contra um catálogo fabricado só na memória (issue #195, AC 2). */
function catalogosSemFatia(
  files: readonly { readonly name: string; readonly contents: string }[],
  declared: ReadonlySet<string>,
): readonly string[] {
  return discoverCatalogNames(files).filter((name) => !declared.has(`scripts/mutations/${name}`));
}

/** Um mutante genérico o bastante para cobrir `Mutant` (tem `focus`) e
 * `MediaMutant` (não tem): só o que este teste precisa ler. `edits` é comum
 * aos dois tipos (issue #195, pino 1: `srcGlobs` contra `edits[].file`). */
interface CatalogEntry {
  readonly id: string;
  readonly focus?: { readonly file: string };
  readonly edits: readonly { readonly file: string }[];
}

/** Os doze catálogos de dado puro, chave = caminho relativo à raiz do repo
 * igual ao que aparece em `slices.json#catalog` -- a checagem de item 3 do
 * cabeçalho acima compara as CHAVES deste mapa contra a união dos
 * `catalog` do JSON, então um `catalog` novo no JSON sem entrada aqui (ou
 * uma entrada aqui sem uso no JSON) reprova antes mesmo de chegar na soma. */
function asCatalog(entries: readonly CatalogEntry[]): readonly CatalogEntry[] {
  return entries;
}

const CATALOGOS: ReadonlyMap<string, readonly CatalogEntry[]> = new Map<
  string,
  readonly CatalogEntry[]
>([
  [
    "scripts/mutations/workflow-durability-guard.ts",
    asCatalog([...guardMutants, ...combinedMutants]),
  ],
  ["scripts/mutations/workflow-durability-named.ts", asCatalog(namedMutants)],
  ["scripts/mutations/orchestration.ts", asCatalog(orchestrationMutants)],
  ["scripts/mutations/workflow-audit-live-mutants.ts", asCatalog(auditLiveMutants)],
  ["scripts/mutations/workflow-audit-producers-mutants.ts", asCatalog(auditProducersMutants)],
  ["scripts/mutations/web-tools-mutants.ts", asCatalog(webToolsMutants)],
  ["scripts/mutations/media-catalog-other.ts", asCatalog(otherMediaMutants)],
  ["scripts/mutations/media-catalog-persistence.ts", asCatalog(persistenceMutants)],
  ["scripts/mutations/self-update-mutants.ts", asCatalog(selfUpdateMutants)],
  ["scripts/mutations/workflow-executor-mutants.ts", asCatalog(executorMutants)],
  ["scripts/mutations/context-window.ts", asCatalog(contextWindowMutants)],
  ["scripts/mutations/auth-mutants.ts", asCatalog(authMutants)],
  ["scripts/mutations/supervision-mutants.ts", asCatalog(supervisionMutants)],
]);

interface Slice {
  readonly slice: string;
  readonly script: string;
  readonly catalog: readonly string[];
  readonly srcGlobs: readonly string[];
  readonly focusFiles: readonly string[];
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readSlices(): readonly Slice[] {
  const raw: unknown = JSON.parse(readFileSync(slicesPath, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error("slices.json: esperava um array no topo");
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`slices.json[${String(index)}]: esperava um objeto`);
    }
    const candidate = entry as Record<string, unknown>;
    const { slice, script, catalog, srcGlobs, focusFiles } = candidate;
    if (typeof slice !== "string" || slice === "") {
      throw new Error(`slices.json[${String(index)}]: "slice" precisa ser string não-vazia`);
    }
    if (typeof script !== "string" || script === "") {
      throw new Error(`slices.json[${String(index)}] (${slice}): "script" precisa ser string`);
    }
    if (!isStringArray(catalog)) {
      throw new Error(`slices.json[${String(index)}] (${slice}): "catalog" precisa ser string[]`);
    }
    if (!isStringArray(srcGlobs)) {
      throw new Error(`slices.json[${String(index)}] (${slice}): "srcGlobs" precisa ser string[]`);
    }
    if (!isStringArray(focusFiles)) {
      throw new Error(
        `slices.json[${String(index)}] (${slice}): "focusFiles" precisa ser string[]`,
      );
    }
    return { slice, script, catalog, srcGlobs, focusFiles };
  });
}

/** Diretórios de primeiro nível de `src/` sem fatia de mutação hoje —
 * cobertura de mutação nessas áreas é trabalho futuro, fora do escopo da
 * issue #154 (que só mapeia as seis fatias já migradas pelo passo 0 do
 * épico #13). Uma entrada aqui precisa continuar SEM cobertura em
 * `srcGlobs`; o teste abaixo reprova se as duas listas se sobrepõem. */
const SEM_FATIA: ReadonlyMap<string, string> = new Map([
  ["agent", "sem catálogo de mutantes ainda"],
  ["config", "sem catálogo de mutantes ainda"],
  ["core", "sem catálogo de mutantes ainda"],
  ["cron", "sem catálogo de mutantes ainda"],
  ["doctor", "sem catálogo de mutantes ainda"],
  ["events", "sem catálogo de mutantes ainda"],
  ["memory", "sem catálogo de mutantes ainda"],
  ["onboarding", "sem catálogo de mutantes ainda"],
  ["pricing", "sem catálogo de mutantes ainda"],
  ["serialization", "sem catálogo de mutantes ainda"],
  ["server", "sem catálogo de mutantes ainda"],
  ["skills", "sem catálogo de mutantes ainda"],
]);

const DIR_GLOB = /^src\/([^/]+)\/\*\*$/;
const FILE_GLOB = /^src\/[^/]+\.ts$/;

/** Extrai o nome do diretório de primeiro nível de um glob `src/<dir>/**`;
 * `null` para a forma literal de arquivo de topo `src/<arquivo>.ts` (issue
 * #195, pino 1) -- um arquivo de topo não é, ele mesmo, um diretório de
 * primeiro nível, então não entra em `coveredDirs` abaixo. Qualquer outra
 * forma continua lançando (fail-closed, mesma regra de
 * `scripts/github/mutations-matrix.ts`). */
function globDirName(glob: string): string | null {
  const match = DIR_GLOB.exec(glob);
  const dir = match?.[1];
  if (dir !== undefined) return dir;
  if (FILE_GLOB.test(glob)) return null;
  throw new Error(
    `srcGlobs: formato inesperado (esperava "src/<dir>/**" ou "src/<arquivo>.ts"): ${glob}`,
  );
}

/** Casa um `edits[].file` (relativo à raiz do repo) contra um `srcGlobs`:
 * `src/<dir>/**` casa por prefixo, `src/<arquivo>.ts` casa só esse arquivo
 * exato (issue #195, pino 1). */
function matchesSrcGlob(file: string, glob: string): boolean {
  const dir = DIR_GLOB.exec(glob)?.[1];
  if (dir !== undefined) return file.startsWith(`src/${dir}/`);
  if (FILE_GLOB.test(glob)) return file === glob;
  throw new Error(
    `srcGlobs: formato inesperado (esperava "src/<dir>/**" ou "src/<arquivo>.ts"): ${glob}`,
  );
}

/** `edits[].file` de catálogos da mecânica B (mídia) é relativo à raiz de
 * `src/`, não à raiz do repo (ex.: `media/source.ts` = `src/media/source.ts`)
 * -- normaliza pela existência em disco, igual às checagens de
 * `focusFiles`/`catalog` acima. Lança se nenhuma das duas formas existir. */
function normalizeEditFile(file: string): string {
  if (existsSync(resolve(repoRoot, file))) return file;
  const guess = `src/${file}`;
  if (existsSync(resolve(repoRoot, guess))) return guess;
  throw new Error(`edits[].file não existe em disco: "${file}" (nem "${guess}")`);
}

/** `edits[].file` (já normalizado) fora de `src/` que legitimamente não
 * precisa de `srcGlobs` -- mudar `scripts/mutations/**` já roda a fatia
 * inteira (`mutations-matrix.ts`), então esses arquivos não têm buraco a
 * fechar. Allowlist explícito (não um filtro silencioso por prefixo): um
 * `edits[].file` fora de `src/` e fora daqui reprova em vez de sumir sem
 * aviso (issue #195, achado do revisor -- "falha nunca é silenciosa"). */
const FORA_DE_SRC = new Set([
  "scripts/mutations/fixtures/normalize-evidence.mjs",
  "scripts/mutations/fixtures/t15-chat-workflow.json",
  "scripts/mutations/fixtures/candidate-chat.mjs",
]);

describe("scripts/mutations/slices.json", () => {
  it("existe", () => {
    expect(existsSync(slicesPath)).toBe(true);
  });

  it("tem as nove fatias, cada uma com o schema esperado", () => {
    const slices = readSlices();
    expect(slices.map((entry) => entry.slice).sort()).toEqual(
      [
        "auth",
        "context-window",
        "media",
        "self-update",
        "supervision",
        "web-tools",
        "workflow-audit-live",
        "workflow-durability",
        "workflow-executor",
      ].sort(),
    );
  });

  it("todo catálogo de dado puro (por conteúdo, não por nome) está em algum slice", () => {
    const slices = readSlices();
    const declared = new Set(slices.flatMap((entry) => entry.catalog));
    const arquivos = readdirSync(mutationsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => ({
        name: entry.name,
        contents: readFileSync(resolve(mutationsDir, entry.name), "utf8"),
      }));
    expect(discoverCatalogNames(arquivos).length).toBeGreaterThan(0);
    expect(catalogosSemFatia(arquivos, declared)).toEqual([]);
  });

  it("catálogo novo fabricado só na memória (mutação manual colada) reprova a descoberta (AC 2)", () => {
    const slices = readSlices();
    const declared = new Set(slices.flatMap((entry) => entry.catalog));
    const arquivosReais = readdirSync(mutationsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => ({
        name: entry.name,
        contents: readFileSync(resolve(mutationsDir, entry.name), "utf8"),
      }));
    const fabricado = {
      name: "foo.ts",
      contents: "export const fooMutants: readonly unknown[] = [];\n",
    };
    // A mesma checagem do teste acima, contra o disco real (sem o catálogo
    // fabricado), continua vazia -- o que muda de vermelho pra verde abaixo
    // é só a adição do "foo.ts" na memória, nunca commitado ao repo.
    expect(catalogosSemFatia(arquivosReais, declared)).toEqual([]);
    expect(catalogosSemFatia([...arquivosReais, fabricado], declared)).toEqual(["foo.ts"]);
  });

  it("todo script existe em package.json#scripts", () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = packageJson.scripts ?? {};
    const slices = readSlices();
    for (const entry of slices) {
      expect(
        Object.prototype.hasOwnProperty.call(scripts, entry.script),
        `slice ${entry.slice}: script "${entry.script}" não existe em package.json`,
      ).toBe(true);
    }
  });

  it("todo focusFiles existe em disco", () => {
    const slices = readSlices();
    for (const entry of slices) {
      for (const file of entry.focusFiles) {
        expect(
          existsSync(resolve(repoRoot, file)),
          `slice ${entry.slice}: focusFiles "${file}" não existe`,
        ).toBe(true);
      }
    }
  });

  it("todo catalog existe em disco", () => {
    const slices = readSlices();
    for (const entry of slices) {
      for (const file of entry.catalog) {
        expect(
          existsSync(resolve(repoRoot, file)),
          `slice ${entry.slice}: catalog "${file}" não existe`,
        ).toBe(true);
      }
    }
  });

  it("os catalog do JSON batem, como conjunto, com CATALOGOS", () => {
    const slices = readSlices();
    const declared = new Set(slices.flatMap((entry) => entry.catalog));
    const known = new Set(CATALOGOS.keys());

    const declaredSemImport = [...declared].filter((path) => !known.has(path));
    expect(
      declaredSemImport,
      `catalog em slices.json sem import correspondente em CATALOGOS: ${declaredSemImport.join(", ")}`,
    ).toEqual([]);

    const importadoSemUsoNoJson = [...known].filter((path) => !declared.has(path));
    expect(
      importadoSemUsoNoJson,
      `CATALOGOS importa um catálogo que nenhum slice.catalog referencia: ${importadoSemUsoNoJson.join(", ")}`,
    ).toEqual([]);
  });

  it("focusFiles bate com a união de focus.file dos catálogos da fatia (exceto media/workflow-executor, sem foco por mutante)", () => {
    const slices = readSlices();
    for (const entry of slices) {
      if (entry.slice === "media") {
        // `MediaMutant` (scripts/mutations/media-mutant.ts) não tem
        // `focus`: "aqui não existe um teste focal -- o oráculo é o
        // `expected` do próprio mutante" (mecânica B: cópia de `src/` +
        // `probe` in-process, não vitest em subprocesso contra um teste
        // focal). `focusFiles: []` é o valor correto, não um buraco.
        expect(entry.focusFiles).toEqual([]);
        continue;
      }
      if (entry.slice === "workflow-executor") {
        // t15 não afunila num foco por mutante -- a mesma bateria de
        // `focalTests` (importada de `workflow-executor-mutants.ts`, issue
        // #186) roda inteira para cada um dos 44 mutantes, então
        // `focusFiles` bate com `focalTests`, não com uma união de
        // `focus.file` (nenhum mutante do catálogo tem `focus`).
        expect(new Set(entry.focusFiles)).toEqual(new Set(executorFocalTests));
        continue;
      }
      const catalogs = entry.catalog.map((path) => {
        const found = CATALOGOS.get(path);
        if (found === undefined) throw new Error(`catálogo não importado: ${path}`);
        return found;
      });
      const derived = new Set(
        catalogs.flatMap((mutants) =>
          mutants.filter((m) => m.focus !== undefined).map((m) => m.focus?.file),
        ),
      );
      expect(new Set(entry.focusFiles), `slice ${entry.slice}`).toEqual(derived);
    }
  });

  it("srcGlobs cobre todo edits[].file dos catálogos da fatia, sob src/ (issue #195, pino 1)", () => {
    const slices = readSlices();
    for (const entry of slices) {
      const catalogs = entry.catalog.map((path) => {
        const found = CATALOGOS.get(path);
        if (found === undefined) throw new Error(`catálogo não importado: ${path}`);
        return found;
      });
      const normalizedFiles = new Set(
        catalogs
          .flatMap((mutants) => mutants.flatMap((m) => m.edits.map((edit) => edit.file)))
          .map((file) => normalizeEditFile(file)),
      );
      for (const file of normalizedFiles) {
        if (!file.startsWith("src/") && !FORA_DE_SRC.has(file)) {
          throw new Error(
            `edits[].file "${file}" (fatia ${entry.slice}) não está sob src/ nem em FORA_DE_SRC -- ` +
              "declare-o lá se legitimamente não precisa de srcGlobs",
          );
        }
      }
      const editedFiles = [...normalizedFiles].filter((file) => file.startsWith("src/"));
      for (const file of editedFiles) {
        const covered = entry.srcGlobs.some((glob) => matchesSrcGlob(file, glob));
        expect(
          covered,
          `slice ${entry.slice}: edits[].file "${file}" não casa nenhum srcGlobs`,
        ).toBe(true);
      }
    }
  });

  it("a contagem total de mutantes é 256 (soma dos treze catálogos importados)", () => {
    // Os doze catálogos de dado puro, importados de verdade via CATALOGOS:
    // nenhum destes módulos chama `main()` no escopo do arquivo -- todos
    // exportam só arrays literais (mais, no caso da mídia, `expected`/
    // `probe`). `workflow-executor-mutants.ts` (issue #186) foi o nono: antes
    // vivia dentro do runner (que chama `main()` incondicionalmente), então
    // a contagem era lida do texto fonte por regex em vez de importada.
    // `context-window.ts` (issue #293) é o décimo: catálogo e runner no
    // mesmo arquivo (atrás da mesma guarda de entry-point), porque o `Files`
    // da issue só autoriza um script novo. `auth-mutants.ts` (issue #354) é
    // o décimo primeiro: 188 + 8 = 196. `workflow-audit-producers-mutants.ts`
    // (issue #370) é o décimo segundo, estendendo a fatia
    // `workflow-audit-live` aos produtores do M7: 196 + 18 = 214. A mesma
    // issue #370 deixou quatro lacunas de oráculo/mutante que #383 fecha (7
    // mutantes: R6, L4, W1, M1, W2, T3, PD): 214 + 7 = 221. A issue #356
    // (fail-closed do lock ilegível, releitura do dono sob a lease, deadline
    // do perdedor, rodada 1; `waitForFileLease` concordando com
    // `acquireFileLease` sobre lock ilegível, rodada 2) estendeu
    // `auth-mutants.ts` de 8 para 13, +5: 221 + 5 = 226. A issue #418
    // acrescenta `Q1-quota-guard-removed` a `workflow-executor-mutants.ts`
    // (a guarda de quota de `fault_kinds`, `engine-utils.ts:490`): 226 + 1 =
    // 227. A issue #451 (milestone 14, follow-up de M10/épico #421)
    // acrescenta o décimo terceiro catálogo, `supervision-mutants.ts` (fatia
    // nova `supervision`): 19 mutantes dedicados ao código novo de M10
    // (steer-tool, leaf-read-tool, route-faults, route-override,
    // MAX_PENDING_STEERS_PER_LEAF em core.ts, o guard de `dead_turn` em
    // child-runner.ts e o vocabulário em transports/error-kinds.ts): 227 + 19
    // = 246. A issue #452 (pivô de rota em sub-workflow por ref) mergeou em
    // paralelo (PR #472) e acrescentou `overrideNestedSpec` a
    // route-override.ts/engine.ts — mais 1 mutante (O5, morto por
    // tests/workflow-route-override-nested.test.ts): 246 + 1 = 247. A issue
    // #484 (milestone 15, achado dos vereditos das PRs #478/#482) acrescenta
    // mutantes a `supervision-mutants.ts` para dois módulos sem mutante
    // nenhum até então. Rodada 1 (PR #497) trouxe 5 de
    // `src/workflow/cache-preview.ts` (#462, P1-P5) e 3 de
    // `src/workflow/templates.ts` (#464, T1-T3): 247 + 8 = 255. Rodada 2
    // (veredito da PR #497: a justificativa de "código morto" para omitir o
    // mutante de `put()` era falsa — `engine.ts:480`'s `runParallel` chama
    // `cache.put(...)` mesmo com `branches: []`, sem spawnar nenhum leaf)
    // acrescenta P6, ancorado em
    // `tests/workflow-cache-preview-writes.test.ts` (arquivo novo — a suíte
    // principal está no teto de 800 linhas): 255 + 1 = 256. A issue #502
    // (non_blocking 4, veredito da PR #497) acrescenta P7/P8 —
    // `estimated_tokens_to_repay`/`estimate_basis` não tinham mutante
    // nenhum: 256 + 2 = 258.
    const importedCount = [...CATALOGOS.values()].reduce((sum, mutants) => sum + mutants.length, 0);
    const TOTAL_MUTANTS = 258;
    expect(importedCount).toBe(TOTAL_MUTANTS);
  });

  it("contagem por catálogo bate com uma tabela pinada (issue #195, pino 3: sem troca compensatória)", () => {
    // Números literais, não derivados de CATALOGOS -- se fossem derivados
    // (`CATALOGOS.get(path).length`), uma troca compensatória entre dois
    // catálogos (um ganha o que o outro perde, soma preservada) passaria
    // despercebida. Contagem = `mutants.length` de cada catálogo importado
    // (não `grep -c 'id: "'`, que conta objetos internos como os
    // `CONJUNCTS` de `workflow-durability-guard.ts` e sobre-conta) -- ver
    // PR #206 (issue #195) para a corrida que produziu estes números.
    const CONTAGEM_POR_CATALOGO: Readonly<Record<string, number>> = {
      "scripts/mutations/workflow-durability-guard.ts": 14,
      "scripts/mutations/workflow-durability-named.ts": 41,
      "scripts/mutations/orchestration.ts": 5,
      "scripts/mutations/workflow-audit-live-mutants.ts": 32,
      "scripts/mutations/workflow-audit-producers-mutants.ts": 25,
      "scripts/mutations/web-tools-mutants.ts": 9,
      "scripts/mutations/media-catalog-other.ts": 7,
      "scripts/mutations/media-catalog-persistence.ts": 13,
      "scripts/mutations/self-update-mutants.ts": 8,
      "scripts/mutations/workflow-executor-mutants.ts": 45,
      "scripts/mutations/context-window.ts": 15,
      "scripts/mutations/auth-mutants.ts": 13,
      "scripts/mutations/supervision-mutants.ts": 31,
    };
    expect(new Set(Object.keys(CONTAGEM_POR_CATALOGO))).toEqual(new Set(CATALOGOS.keys()));
    for (const [path, mutants] of CATALOGOS) {
      expect(mutants.length, `catálogo ${path}`).toBe(CONTAGEM_POR_CATALOGO[path]);
    }
    const somaTabela = Object.values(CONTAGEM_POR_CATALOGO).reduce((sum, n) => sum + n, 0);
    expect(somaTabela).toBe(258);
  });

  it("todo diretório de primeiro nível de src/ está em algum srcGlobs ou em SEM_FATIA, nunca nos dois", () => {
    const slices = readSlices();
    const coveredDirs = new Set(
      slices
        .flatMap((entry) => entry.srcGlobs)
        .map((glob) => globDirName(glob))
        .filter((dir): dir is string => dir !== null),
    );

    const overlap = [...coveredDirs].filter((dir) => SEM_FATIA.has(dir));
    expect(
      overlap,
      `diretórios em srcGlobs E em SEM_FATIA (motivo obsoleto): ${overlap.join(", ")}`,
    ).toEqual([]);

    const topLevelDirs = readdirSync(resolve(repoRoot, "src"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    const uncovered = topLevelDirs.filter((dir) => !coveredDirs.has(dir) && !SEM_FATIA.has(dir));
    expect(
      uncovered,
      `diretório(s) de src/ sem fatia e sem motivo em SEM_FATIA: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  it("SEM_FATIA não tem entrada morta (diretório existe, motivo não é vazio)", () => {
    const topLevelDirNames = new Set(
      readdirSync(resolve(repoRoot, "src"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
    for (const [dir, motivo] of SEM_FATIA) {
      expect(topLevelDirNames.has(dir), `SEM_FATIA: "${dir}" não existe mais em src/`).toBe(true);
      expect(motivo.trim().length > 0, `SEM_FATIA: motivo vazio para "${dir}"`).toBe(true);
    }
  });
});
