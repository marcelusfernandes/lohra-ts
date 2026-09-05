// Resolve o slug de prova (`prova/<slug>.ts`) a partir do nome da branch.
// Puro e sem I/O: quem decide se o arquivo existe é o chamador (`exists`),
// para ser testável sem tocar disco e reutilizável pelo stop-gate (#33) e
// pelo CI (#34).
//
// Convenção deste repo (`.claude/rules/git-workflow.md`): `<type>/<n>-<slug>`.
// Sem o prefixo `m0-` do Apollo — aqui o candidato é sempre único,
// `prova/<slug>.ts`.

const BRANCH_RE = /^[a-z]+\/[0-9]+-([a-z0-9-]+)$/;

/** `feat/12-workflow-store` → `"workflow-store"`; `main` → `null`. */
export function branchSlug(branch: string): string | null {
  throw new Error("not implemented");
}

/**
 * `null` se a branch não segue a convenção, ou se `prova/<slug>.ts` não
 * existir segundo `exists`.
 */
export function resolveProvaSlug(
  branch: string,
  exists: (path: string) => boolean,
): string | null {
  throw new Error("not implemented");
}
