// Lease curta de arquivo para a renovação do token OAuth (issue #354).
// `LockRepository` (src/state/locks.ts) resolve o mesmo problema (reler →
// renovar se ainda expirando → gravar, um processo de cada vez) mas está
// amarrado a uma instância `Database.Database` do better-sqlite3 — reusá-lo
// aqui acoplaria `src/auth/` a `src/state/` sem necessidade. A exclusão
// mútua vem do próprio SO: `open(path, "wx")` falha com `EEXIST` se o
// arquivo já existe, e essa falha É a lease ocupada.
export function acquireFileLease(
  _path: string,
  _holder: string,
  _ttlSeconds: number,
  _now = Date.now() / 1000,
): boolean {
  throw new Error("not implemented: acquireFileLease");
}

export function releaseFileLease(_path: string, _holder: string): void {
  throw new Error("not implemented: releaseFileLease");
}

export function waitForFileLease(
  _path: string,
  _options: {
    readonly maxWaitMs: number;
    readonly pollMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  throw new Error("not implemented: waitForFileLease");
}
