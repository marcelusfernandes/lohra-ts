#!/usr/bin/env node
// Shim: a implementação foi movida para scripts/mutations/media.ts (issue
// #151, passo 0d do épico #13; `mutations:t21` em package.json aponta
// para lá). Este arquivo mantém as assinaturas que
// scripts/parity/media/run-all.ts (histórico, fora de escopo da #151 —
// depende do oráculo Python retirado) ainda importa, para não precisar
// editá-lo, mas falha alto em vez de rodar mutantes duplicados: a fonte
// única dos 20 mutantes de mídia agora é scripts/mutations/media.ts.
import process from "node:process";

export interface MutationResult {
  readonly id: string;
  readonly killed: boolean;
  readonly observation: string;
}

const MOVED_MESSAGE =
  "scripts/parity/media/run-mutations.ts foi movido para scripts/mutations/media.ts (issue #151); use `npm run mutations:t21`.";

export function runMutations(): Promise<readonly MutationResult[]> {
  throw new Error(MOVED_MESSAGE);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1])) {
  process.stderr.write(`${MOVED_MESSAGE}\n`);
  process.exitCode = 1;
}
