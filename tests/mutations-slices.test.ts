// Teste da issue #154 (passo 0 do épico #13): `scripts/mutations/slices.json`
// é o mapa declarado `src/**` -> fatia -> script -> catálogo que o passo 11
// de `orquestracao.md` hoje decide de cabeça. Este teste prova:
//
//   1. o schema básico de cada entrada;
//   2. todo catálogo de dado puro (`*-mutants.ts`/`*catalog*.ts` sob
//      `scripts/mutations/`) aparece em algum `catalog` do JSON — uma fatia
//      nova nesse padrão sem entrada reprova aqui;
//   3. os `catalog` do JSON (fora `workflow-executor.ts`) batem, como
//      conjunto, com os oito catálogos de dado puro importados abaixo —
//      um `catalog` novo no JSON sem import correspondente aqui (ou
//      vice-versa) reprova, o que impede o número da contagem (4) de
//      driftar silenciosamente do JSON;
//   4. todo `script` de cada entrada existe em `package.json#scripts`;
//   5. todo `focusFiles[]` existe em disco, e (exceto `media`, que não tem
//      conceito de teste focal) bate exatamente com a união dos
//      `focus.file` dos mutantes do(s) catálogo(s) da fatia;
//   6. a contagem total de mutantes é a soma exata dos catálogos — os oito
//      arquivos de dado puro são importados de verdade (`import` estático,
//      sem efeito colateral: nenhum chama `main()` no escopo do módulo) e
//      somados via o mapa `CATALOGOS`; `workflow-executor.ts` é o único
//      catálogo que TAMBÉM é um runner (chama `main()` incondicionalmente
//      na última linha — side effect real, dispara uma corrida de mutação
//      completa em subprocesso), então sua contagem é lida do texto fonte
//      por regex ancorada em vez de importado;
//   7. todo diretório de primeiro nível de `src/` está coberto por algum
//      `srcGlobs` de alguma fatia OU está na lista `SEM_FATIA` abaixo, com
//      motivo não-vazio e diretório que ainda existe -- um diretório novo
//      sem entrada em nenhum dos dois reprova, e uma entrada morta em
//      `SEM_FATIA` (diretório apagado ou motivo vazio) também reprova
//      (mesma convenção de "sem entrada morta" de
//      `tests/mutations-directory-pin.test.ts`).
//
// Catálogos que são pura estrutura de dado (sem `main()` de topo) e por
// isso seguros para `import` estático dentro deste arquivo de teste:
// `workflow-durability-guard.ts`, `workflow-durability-named.ts` e
// `orchestration.ts` (nenhum importa `node:child_process`; o comentário de
// `orchestration.ts` documenta isso), mais os cinco que casam com o padrão
// `*-mutants.ts`/`*catalog*.ts`. Os outros seis arquivos de
// `scripts/mutations/*.ts` são RUNNERS (`workflow-executor.ts`,
// `workflow-durability.ts`, `workflow-audit-live.ts`, `web-tools.ts`,
// `media.ts`, `self-update.ts`): `workflow-executor.ts`,
// `workflow-durability.ts` e `web-tools.ts` chamam `main()` incondicional
// na última linha; `workflow-audit-live.ts` e `self-update.ts` chamam
// `main()` dentro de um `try {}` de topo (também incondicional); só
// `media.ts` guarda a chamada atrás de um `import.meta.url` check e por
// isso não teria efeito colateral -- mesmo assim não é importado aqui, por
// uniformidade com os outros cinco runners (nenhum runner entra neste
// arquivo de teste, só catálogos).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { combinedMutants, guardMutants } from "../scripts/mutations/workflow-durability-guard.js";
import { otherMediaMutants } from "../scripts/mutations/media-catalog-other.js";
import { persistenceMutants } from "../scripts/mutations/media-catalog-persistence.js";
import { orchestrationMutants } from "../scripts/mutations/orchestration.js";
import { mutants as selfUpdateMutants } from "../scripts/mutations/self-update-mutants.js";
import { mutants as auditLiveMutants } from "../scripts/mutations/workflow-audit-live-mutants.js";
import { namedMutants } from "../scripts/mutations/workflow-durability-named.js";
import { webToolsMutants } from "../scripts/mutations/web-tools-mutants.js";

const repoRoot = resolve(import.meta.dirname, "..");
const slicesPath = resolve(repoRoot, "scripts/mutations/slices.json");
const mutationsDir = resolve(repoRoot, "scripts/mutations");
const EXECUTOR_CATALOG = "scripts/mutations/workflow-executor.ts";

/** Um mutante genérico o bastante para cobrir `Mutant` (tem `focus`) e
 * `MediaMutant` (não tem): só o que este teste precisa ler. */
interface CatalogEntry {
  readonly id: string;
  readonly focus?: { readonly file: string };
}

/** Os oito catálogos de dado puro, chave = caminho relativo à raiz do repo
 * igual ao que aparece em `slices.json#catalog` -- a checagem de item 3 do
 * cabeçalho acima compara as CHAVES deste mapa contra a união dos
 * `catalog` do JSON (menos `workflow-executor.ts`), então um `catalog`
 * novo no JSON sem entrada aqui (ou uma entrada aqui sem uso no JSON)
 * reprova antes mesmo de chegar na soma. */
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
  ["scripts/mutations/web-tools-mutants.ts", asCatalog(webToolsMutants)],
  ["scripts/mutations/media-catalog-other.ts", asCatalog(otherMediaMutants)],
  ["scripts/mutations/media-catalog-persistence.ts", asCatalog(persistenceMutants)],
  ["scripts/mutations/self-update-mutants.ts", asCatalog(selfUpdateMutants)],
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
  ["auth", "sem catálogo de mutantes ainda"],
  ["catalog", "sem catálogo de mutantes ainda"],
  ["config", "sem catálogo de mutantes ainda"],
  ["context", "sem catálogo de mutantes ainda"],
  ["conversation", "sem catálogo de mutantes ainda"],
  ["core", "sem catálogo de mutantes ainda"],
  ["cron", "sem catálogo de mutantes ainda"],
  ["doctor", "sem catálogo de mutantes ainda"],
  ["events", "sem catálogo de mutantes ainda"],
  ["memory", "sem catálogo de mutantes ainda"],
  ["onboarding", "sem catálogo de mutantes ainda"],
  ["pricing", "sem catálogo de mutantes ainda"],
  ["providers", "sem catálogo de mutantes ainda"],
  ["serialization", "sem catálogo de mutantes ainda"],
  ["server", "sem catálogo de mutantes ainda"],
  ["skills", "sem catálogo de mutantes ainda"],
  ["transports", "sem catálogo de mutantes ainda"],
]);

/** Extrai o nome do diretório de primeiro nível de um glob `src/<dir>/**`. */
function globDirName(glob: string): string {
  const match = /^src\/([^/]+)\/\*\*$/.exec(glob);
  if (match === null) {
    throw new Error(`srcGlobs: formato inesperado (esperava "src/<dir>/**"): ${glob}`);
  }
  const dir = match[1];
  if (dir === undefined) {
    throw new Error(`srcGlobs: não foi possível extrair o diretório de ${glob}`);
  }
  return dir;
}

describe("scripts/mutations/slices.json", () => {
  it("existe", () => {
    expect(existsSync(slicesPath)).toBe(true);
  });

  it("tem as seis fatias, cada uma com o schema esperado", () => {
    const slices = readSlices();
    expect(slices.map((entry) => entry.slice).sort()).toEqual(
      [
        "media",
        "self-update",
        "web-tools",
        "workflow-audit-live",
        "workflow-durability",
        "workflow-executor",
      ].sort(),
    );
  });

  it("todo catálogo *-mutants.ts/*catalog*.ts de scripts/mutations/ está em algum slice", () => {
    const slices = readSlices();
    const declared = new Set(slices.flatMap((entry) => entry.catalog));
    const catalogPattern = /(-mutants\.ts$|catalog.*\.ts$)/;
    const onDisk = readdirSync(mutationsDir).filter(
      (name) => catalogPattern.test(name) && name.endsWith(".ts"),
    );
    expect(onDisk.length).toBeGreaterThan(0);
    for (const name of onDisk) {
      const relPath = `scripts/mutations/${name}`;
      expect(declared.has(relPath), `${relPath} não está em nenhum "catalog" de slices.json`).toBe(
        true,
      );
    }
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

  it("os catalog do JSON (fora workflow-executor.ts) batem, como conjunto, com CATALOGOS", () => {
    const slices = readSlices();
    const declaredNonExecutor = new Set(
      slices.flatMap((entry) => entry.catalog).filter((path) => path !== EXECUTOR_CATALOG),
    );
    const known = new Set(CATALOGOS.keys());

    const declaredSemImport = [...declaredNonExecutor].filter((path) => !known.has(path));
    expect(
      declaredSemImport,
      `catalog em slices.json sem import correspondente em CATALOGOS: ${declaredSemImport.join(", ")}`,
    ).toEqual([]);

    const importadoSemUsoNoJson = [...known].filter((path) => !declaredNonExecutor.has(path));
    expect(
      importadoSemUsoNoJson,
      `CATALOGOS importa um catálogo que nenhum slice.catalog referencia: ${importadoSemUsoNoJson.join(", ")}`,
    ).toEqual([]);
  });

  it("focusFiles bate com a união de focus.file dos catálogos da fatia (exceto media, sem foco)", () => {
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
        // Catálogo não importado (ver "a contagem total…" abaixo); a
        // mesma fonte lida por regex ali confirma os cinco arquivos de
        // `focalTests` que já estão em `focusFiles`.
        const source = readFileSync(resolve(repoRoot, EXECUTOR_CATALOG), "utf8");
        const block = /const focalTests = \[([\s\S]*?)\] as const;/.exec(source);
        expect(block, "workflow-executor.ts: bloco focalTests não encontrado").not.toBeNull();
        const files = [...(block?.[1]?.matchAll(/"([^"]+)"/g) ?? [])].map((m) => m[1]);
        expect(new Set(entry.focusFiles)).toEqual(new Set(files));
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

  it("a contagem total de mutantes é 170 (soma dos catálogos, oito importados + um lido do texto)", () => {
    // Os oito catálogos de dado puro, importados de verdade via CATALOGOS:
    // nenhum destes módulos chama `main()` no escopo do arquivo -- todos
    // exportam só arrays literais (mais, no caso da mídia, `expected`/`probe`).
    const importedCount = [...CATALOGOS.values()].reduce((sum, mutants) => sum + mutants.length, 0);
    expect(importedCount).toBe(126);

    // `workflow-executor.ts` é o único catálogo que também é o runner:
    // chama `main()` incondicionalmente na última linha, então importá-lo
    // aqui disparava uma corrida de mutação real (proibitivamente lenta e
    // fora do que um `npm test` deve fazer). A contagem é lida do texto
    // fonte por regex ancorada na indentação real do array de mutantes
    // (`    id: "..."`, 4 espaços -- a mesma que classifica cada entrada de
    // `executorMutants`), não executada.
    const executorSource = readFileSync(resolve(repoRoot, EXECUTOR_CATALOG), "utf8");
    const executorIds = executorSource.match(/^ {4}id: "/gm) ?? [];
    expect(executorIds.length).toBe(44);

    const TOTAL_MUTANTS = 170;
    expect(importedCount + executorIds.length).toBe(TOTAL_MUTANTS);
  });

  it("todo diretório de primeiro nível de src/ está em algum srcGlobs ou em SEM_FATIA, nunca nos dois", () => {
    const slices = readSlices();
    const coveredDirs = new Set(
      slices.flatMap((entry) => entry.srcGlobs).map((glob) => globDirName(glob)),
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
