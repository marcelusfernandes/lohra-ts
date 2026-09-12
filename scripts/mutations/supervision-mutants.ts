// Stub — issue #451 (milestone 14): a fatia `supervision` nasce como módulo
// novo em `scripts/mutations/`; o catálogo de verdade (19 mutantes) chega no
// commit seguinte (`test(mutations): ...`). Este stub lança se algo tentar
// usá-lo antes disso — não é importado por `tests/mutations-slices.test.ts`
// nem por nenhum runner neste commit (worktree-segura §7).
export function supervisionMutants(): never {
  throw new Error("not implemented: supervisionMutants");
}
