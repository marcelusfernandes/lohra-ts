#!/usr/bin/env node
// `npm run ci:controle-negativo -- --base <sha> --head <sha> [--slug <s>] [--root <dir>]`
// (issue #48) — prova que os testes novos de uma PR reprovam contra a base
// da PR, para que "teste primeiro" seja verificado por máquina, não só
// prometido no commit.
//
// Mecânica: `git worktree add --detach <tmp> <base>`, overlay só dos
// arquivos de teste do diff (`tests/**/*.test.ts`, `prova/**` —
// `lib.ts#arquivosDeTeste`) copiados do HEAD por cima da base, roda
// `npm run -s prova -- <slug>` NA BASE (o próprio código de produção da
// base, sem a implementação que os testes novos exigem), lê o
// `.prova/<slug>/resumo.json` que sobrar lá e classifica.
//
// Os quatro desfechos (`lib.ts#classificar`) — só o último reprova:
//   assertion-red   — alguma falha é uma asserção real (não estrutural).
//                     PASS: o teste é vermelho por um motivo de verdade.
//   structural-red  — toda falha é estrutural (import/coleta/tipo — a
//                     base não tem sequer o módulo). PASS SÓ SE o último
//                     commit da PR que tocou os testes for `test(red):`
//                     (worktree-segura §7); senão, FAIL explícito
//                     ("estrutural sem test(red)") — uma falha estrutural
//                     sozinha não distingue "PR rejeitada de propósito" de
//                     "overlay quebrado por acidente".
//   empty-red       — `resumo.json` diz `ok:false` sem nenhuma falha
//                     normalizada (ex.: `{ok:false,total:0,falhas:[]}`).
//                     PASS: `ok` é autoritativo mesmo sem detalhe.
//   vacuous-pass    — a prova passa NA BASE, sem a implementação. FAIL: o
//                     teste não prova nada.
//
// Sem `prova/<slug>.ts` no HEAD → FAIL explícito citando o caminho (PR de
// feature sem prova declarada, issue #42). Base sem `scripts.prova` no
// `package.json` (o harness #42 ainda não existia naquele commit) → PASS
// logado, não há como rodar (`lib.ts#semHarnessNaBase`).
//
// O worktree temporário é sempre removido (`finally`), inclusive quando o
// check reprova — nada aqui usa `process.exit()` dentro do `try`, que
// pularia o `finally` (mesma lição de `scripts/prova/run.ts`).
import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { parseArgs } from "./lib.js";

function falhaFechada(mensagem: string): never {
  process.stderr.write(`${mensagem}\n`);
  process.exit(1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  void args;
  throw new Error("not implemented: controle-negativo run.ts main()");
}

// Só roda `main()` quando este arquivo é o entry point — nunca quando um
// teste importa os símbolos acima diretamente (mesmo padrão de
// `scripts/prova/run.ts`).
function ehEntryPoint(): boolean {
  const invocado = process.argv[1];
  if (invocado === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(invocado)).href;
}

if (ehEntryPoint()) {
  try {
    main();
  } catch (error) {
    falhaFechada(`controle-negativo: erro inesperado: ${String(error)}`);
  }
}
