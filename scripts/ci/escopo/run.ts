#!/usr/bin/env node
// `escopo` (issue #49, épico #34): o diff da PR precisa caber nos globs que
// a `## Files` da issue linkada por `Closes #N` declara, mais o que a PR
// autorizar com `authorised:` (só o orquestrador escreve essa linha).
//
// Dois modos:
//   - CI (sem `--files-file`): lê o payload do evento `pull_request`
//     (`GITHUB_EVENT_PATH`) para o corpo da PR e o base/head SHA, faz o
//     diff com `git`, e busca o corpo da issue linkada com `gh issue view`
//     (`GH_TOKEN` do workflow — nunca hardcoded aqui).
//   - Dry-run (`prova/escopo`, testes): `--files-file`, `--issue-body-file`,
//     `--pr-body-file` — sem `gh`/`git`, sem environment (`npm run prova`:
//     "todo argumento tem padrão").
//
// Uma PR sem "Closes #N" no corpo (e sem `--issue-body-file`) é um erro de
// quem abriu a PR, não uma exceção do programa: `falhaLimpa` escreve uma
// mensagem e sai com 1, nunca deixa um stack trace de `throw` não pego
// chegar ao topo (skill `worktree-segura`; precedente Apollo #28/#29).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { appendSummary } from "../lib/summary.js";
import { checarEscopo, globsAutorizados, globsDaIssue } from "./lib.js";

function falhaLimpa(mensagem: string): never {
  process.stderr.write(`escopo: ${mensagem}\n`);
  appendSummary(["## escopo", "", `**FAILED** — ${mensagem}`].join("\n"));
  process.exit(1);
}

/** Parser de flags mínimo: `--flag valor` (sem dependência nova). */
function parseArgs(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const chave = arg.slice(2);
    const proximo = argv[i + 1];
    if (proximo !== undefined && !proximo.startsWith("--")) {
      out.set(chave, proximo);
      i++;
    } else {
      out.set(chave, "true");
    }
  }
  return out;
}

function linhasNaoVazias(texto: string): string[] {
  return texto
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0);
}

function ghIssueBody(numero: string): string {
  const r = spawnSync("gh", ["issue", "view", numero, "--json", "body", "-q", ".body"], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`gh issue view ${numero} falhou: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function gitDiffNames(base: string, head: string): string[] {
  const r = spawnSync("git", ["diff", "--no-renames", "--name-only", `${base}...${head}`], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git diff ${base}...${head} falhou: ${r.stderr}`);
  }
  return linhasNaoVazias(r.stdout);
}

interface EventoPullRequest {
  readonly pull_request?: {
    readonly body?: string;
    readonly base?: { readonly sha?: string };
    readonly head?: { readonly sha?: string };
  };
}

function lerEventoPullRequest(): EventoPullRequest | null {
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  if (eventPath === undefined || eventPath === "" || !existsSync(eventPath)) return null;
  return JSON.parse(readFileSync(eventPath, "utf8")) as EventoPullRequest;
}

export function main(argv: readonly string[]): void {
  const args = parseArgs(argv);
  const filesFile = args.get("files-file");

  let files: string[];
  let evento: EventoPullRequest | null = null;
  if (filesFile !== undefined) {
    files = linhasNaoVazias(readFileSync(filesFile, "utf8"));
  } else {
    evento = lerEventoPullRequest();
    const base = evento?.pull_request?.base?.sha;
    const head = evento?.pull_request?.head?.sha;
    if (base === undefined || head === undefined) {
      falhaLimpa(
        "sem --files-file, e sem GITHUB_EVENT_PATH de um evento pull_request com base/head",
      );
    }
    files = gitDiffNames(base, head);
  }
  const dryRun = filesFile !== undefined;

  const prBodyFile = args.get("pr-body-file");
  const prBody =
    prBodyFile !== undefined
      ? readFileSync(prBodyFile, "utf8")
      : (evento?.pull_request?.body ?? "");

  const issueBodyFile = args.get("issue-body-file");
  let issueBody: string;
  if (issueBodyFile !== undefined) {
    issueBody = readFileSync(issueBodyFile, "utf8");
  } else {
    const closesMatch = /\bcloses\s+#(\d+)/i.exec(prBody);
    const issueNumero = closesMatch?.[1];
    if (issueNumero === undefined) {
      falhaLimpa('a PR não declara "Closes #N" no corpo — não dá para achar a issue linkada');
    }
    if (dryRun) {
      falhaLimpa(
        `modo dry-run precisa de --issue-body-file (achei "Closes #${issueNumero}", mas dry-run não chama gh)`,
      );
    }
    issueBody = ghIssueBody(issueNumero);
  }

  const issueGlobs = globsDaIssue(issueBody);
  const authorised = globsAutorizados(prBody);
  const resultado = checarEscopo({ files, issueGlobs, authorised });
  const todosGlobs = [...issueGlobs, ...authorised];

  process.stdout.write(
    `${JSON.stringify({ ok: resultado.ok, fora: resultado.fora, globs: todosGlobs }, null, 2)}\n`,
  );

  appendSummary(
    [
      "## escopo",
      "",
      resultado.ok
        ? `${String(files.length)} arquivo(s), todos dentro dos globs da issue.`
        : "**FAILED** — fora dos globs da issue:",
      ...(resultado.ok ? [] : resultado.fora.map((f) => `- \`${f}\``)),
      "",
      `Globs: ${todosGlobs.map((g) => `\`${g}\``).join(", ") || "(nenhum)"}`,
    ].join("\n"),
  );

  if (!resultado.ok) {
    process.stderr.write(
      `escopo: ${String(resultado.fora.length)} arquivo(s) fora dos globs da issue:\n${resultado.fora
        .map((f) => `  - ${f}`)
        .join("\n")}\n`,
    );
    process.exit(1);
  }
}

function ehEntryPoint(): boolean {
  const invocado = process.argv[1];
  if (invocado === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(invocado)).href;
}

if (ehEntryPoint()) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`escopo: erro inesperado: ${String(error)}\n`);
    process.exit(1);
  }
}
