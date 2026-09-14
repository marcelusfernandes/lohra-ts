// Stub — issue #636: a fatia `doctor` nasce como módulo novo em
// `scripts/mutations/`; o catálogo de verdade (10 mutantes cobrindo
// `src/doctor/**` e `src/commands/provider-detectado.ts`) chega no commit
// seguinte (`test(mutations): ...`). Este stub lança se algo tentar usá-lo
// antes disso — não é importado por `tests/mutations-slices.test.ts` nem por
// nenhum runner neste commit (worktree-segura §7).
export function doctorMutants(): never {
  throw new Error("not implemented: doctorMutants");
}
