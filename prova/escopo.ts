// Issue #49: check `escopo` — o diff da PR precisa caber nos globs de
// `## Files` da issue (mais `authorised:` na PR). `tests/ci-escopo.test.ts`
// cobre as funções puras (`globs.ts`, `escopo/lib.ts`) e `run.ts` em
// subprocesso (modo dry-run).
export default {
  unit: ["tests/ci-escopo.test.ts"],
};
