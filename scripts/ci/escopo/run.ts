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
// STUB (test(red), issue #49): implementação real vem no commit seguinte.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function main(_argv: readonly string[]): Promise<void> {
  throw new Error("not implemented");
}

function ehEntryPoint(): boolean {
  const invocado = process.argv[1];
  if (invocado === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(invocado)).href;
}

if (ehEntryPoint()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`escopo: erro inesperado: ${String(error)}\n`);
    process.exit(1);
  });
}
