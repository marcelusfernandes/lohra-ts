#!/usr/bin/env node
// `npm run prova -- <slug>` — o harness real (issue #42).
//
// Contrato: `prova/<slug>.ts` faz `export default` de
// `{ unit: string[], check?: boolean }` (`Declaracao`, `tipos.ts`). `unit`
// nomeia os arquivos de teste (caminhos relativos à raiz, precisam
// existir); `check` (default `false`) também roda `npm run typecheck`.
//
// Escreve `.prova/<slug>/resumo.json` (`{ok, total, falhas}`) e
// `.prova/<slug>/vitest.json` — ou, com `LOHRA_PROVA_OUT`, sob
// `<LOHRA_PROVA_OUT>/<slug>/` em vez de `.prova/<slug>/` (evita corrida
// entre execuções concorrentes do MESMO slug; o hook Stop, #46, ignora essa
// variável e sempre lê `.prova/<slug>/resumo.json` — ela é para rodadas
// paralelas fora do caminho que o hook observa, não para redirecioná-lo).
//
// Antes de rodar o vitest, `vitest.json`/`resumo.json` de uma execução
// anterior do MESMO slug são apagados: sem isso, um vitest que trava antes
// de escrever relatório (config quebrada, OOM, sinal) deixaria o relatório
// velho no lugar, e `existsSync` sozinho não distingue "relatório desta
// execução" de "relatório de uma execução anterior" — falha silenciosa
// (CLAUDE.md, invariante 2).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import type { Declaracao, Falha, Resumo } from "./tipos.js";
import { normalizarRelatorioVitest } from "./vitest-relatorio.js";
import { montarResumo } from "./resumo.js";

const SLUG_RE = /^[a-z0-9-]+$/;

function falhaFechada(mensagem: string): never {
  process.stderr.write(`${mensagem}\n`);
  process.exit(1);
}

function validarDeclaracao(valor: unknown, declaracaoPath: string): Declaracao {
  if (typeof valor !== "object" || valor === null) {
    falhaFechada(`prova: ${declaracaoPath} não faz "export default" de um objeto`);
  }
  const bruto = valor as { unit?: unknown; check?: unknown };
  if (!Array.isArray(bruto.unit) || !bruto.unit.every((item) => typeof item === "string")) {
    falhaFechada(`prova: ${declaracaoPath} — "unit" precisa ser string[]`);
  }
  if (bruto.check !== undefined && typeof bruto.check !== "boolean") {
    falhaFechada(`prova: ${declaracaoPath} — "check" precisa ser boolean`);
  }
  const unit = bruto.unit;
  return bruto.check === undefined ? { unit } : { unit, check: bruto.check };
}

function resolverVitestEntry(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("vitest/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin?: Record<string, string> | string;
  };
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vitest;
  if (binRel === undefined) {
    falhaFechada("prova: não foi possível localizar o executável do vitest");
  }
  return resolve(dirname(pkgPath), binRel);
}

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (slug === undefined || slug === "") {
    falhaFechada("usage: npm run prova -- <slug>");
  }
  if (!SLUG_RE.test(slug)) {
    falhaFechada(`prova: slug inválido "${slug}" (esperado /${SLUG_RE.source}/)`);
  }

  const root = process.cwd();
  const declaracaoRelPath = join("prova", `${slug}.ts`);
  const declaracaoPath = resolve(root, declaracaoRelPath);
  if (!existsSync(declaracaoPath)) {
    falhaFechada(`prova: nenhuma declaração em ${declaracaoRelPath}`);
  }

  const modulo: unknown = await import(pathToFileURL(declaracaoPath).href);
  const default_ = (modulo as { default?: unknown }).default;
  const declaracao = validarDeclaracao(default_, declaracaoRelPath);

  const ausentes = declaracao.unit.filter((arquivo) => !existsSync(resolve(root, arquivo)));
  if (ausentes.length > 0) {
    falhaFechada(`prova: arquivo declarado não existe: ${ausentes.join(", ")}`);
  }

  const provaOutEnv = process.env["LOHRA_PROVA_OUT"];
  const outDir =
    provaOutEnv !== undefined && provaOutEnv !== ""
      ? resolve(root, provaOutEnv, slug)
      : resolve(root, ".prova", slug);
  mkdirSync(outDir, { recursive: true });

  const vitestJsonPath = join(outDir, "vitest.json");
  const resumoJsonPath = join(outDir, "resumo.json");
  // Apaga o que uma execução anterior do MESMO slug deixou. Sem isso, um
  // vitest que morre antes de escrever relatório (config quebrada, sinal)
  // deixaria `existsSync(vitestJsonPath)` enganosamente `true` — o
  // relatório de uma corrida passada, não desta.
  rmSync(vitestJsonPath, { force: true });
  rmSync(resumoJsonPath, { force: true });

  const falhasExtras: Falha[] = [];

  if (declaracao.check === true) {
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    const checkResult = spawnSync(npmBin, ["run", "typecheck"], { cwd: root, stdio: "inherit" });
    if (checkResult.status !== 0) {
      falhasExtras.push({
        nome: "npm run typecheck",
        motivo: `exit code ${String(checkResult.status)}`,
      });
    }
  }

  const vitestEntry = resolverVitestEntry();
  const vitestResult = spawnSync(
    process.execPath,
    [vitestEntry, "run", ...declaracao.unit, "--reporter=json", `--outputFile=${vitestJsonPath}`],
    { cwd: root, stdio: "inherit" },
  );

  const causaProcesso =
    vitestResult.error !== undefined
      ? `: ${vitestResult.error.message}`
      : vitestResult.signal !== null
        ? ` (encerrado pelo sinal ${vitestResult.signal})`
        : ` (exit code ${String(vitestResult.status)})`;

  if (!existsSync(vitestJsonPath)) {
    falhaFechada(
      `prova: o vitest não produziu relatório em ${relative(root, vitestJsonPath)}${causaProcesso}`,
    );
  }

  const bruto: unknown = JSON.parse(readFileSync(vitestJsonPath, "utf8"));
  const resultado = normalizarRelatorioVitest(root, bruto);
  const resumoBase = montarResumo(declaracao.unit, resultado);
  let resumo: Resumo =
    falhasExtras.length === 0
      ? resumoBase
      : { ok: false, total: resumoBase.total, falhas: [...falhasExtras, ...resumoBase.falhas] };

  // O vitest saiu com exit != 0 (ou por sinal) mas ainda assim escreveu UM
  // relatório novo (existsSync acima já garante que não é o antigo). Se
  // esse relatório, lido honestamente, disser "ok" mesmo assim, o processo
  // sabe de algo que o relatório não capturou (ex.: crash logo após
  // escrever um relatório parcial) — isso nunca pode virar `ok:true`
  // silenciosamente (CLAUDE.md, invariante 2). Um teste vermelho de verdade
  // já deixa `resumo.ok` `false` por conta própria, então esta checagem não
  // duplica nada nesse caso comum.
  const processoFalhou = vitestResult.status !== 0;
  if (processoFalhou && resumo.ok) {
    resumo = {
      ok: false,
      total: resumo.total,
      falhas: [...resumo.falhas, { nome: "vitest run", motivo: `processo falhou${causaProcesso}` }],
    };
  }

  writeFileSync(join(outDir, "resumo.json"), `${JSON.stringify(resumo, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(resumo, null, 2)}\n`);
  process.exit(resumo.ok ? 0 : 1);
}

main().catch((error: unknown) => {
  falhaFechada(`prova: erro inesperado: ${String(error)}`);
});
