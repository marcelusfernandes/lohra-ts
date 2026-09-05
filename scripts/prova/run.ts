#!/usr/bin/env node
// `npm run prova -- <slug>` — o harness real (issue #42).
//
// Contrato: `prova/<slug>.ts` faz `export default` de
// `{ unit: string[], check?: boolean }` (`Declaracao`, `tipos.ts`). `unit`
// nomeia os arquivos de teste (caminhos relativos à raiz, precisam
// existir); `check` (default `false`) também roda `npm run typecheck`.
//
// Escreve `.prova/<slug>/resumo.json` (`{ok, total, falhas}`) e
// `.prova/<slug>/vitest.json` — ou, com `LOHRA_PROVA_OUT`, sob esse
// diretório em vez do derivado do slug (evita corrida entre execuções
// concorrentes do mesmo slug).
process.stderr.write("prova: not implemented\n");
process.exit(2);
