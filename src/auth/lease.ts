// Lease curta de arquivo para a renovação do token OAuth (issue #354).
// `LockRepository` (src/state/locks.ts) resolve o mesmo problema (reler →
// renovar se ainda expirando → gravar, um processo de cada vez) mas está
// amarrado a uma instância `Database.Database` do better-sqlite3 — reusá-lo
// aqui acoplaria `src/auth/` a `src/state/` sem necessidade. A exclusão
// mútua vem do próprio SO: `open(path, "wx")` falha com `EEXIST` se o
// arquivo já existe, e essa falha É a lease ocupada.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

interface LeaseRecord {
  readonly holder: string;
  readonly expiresAt: number;
}

function isLeaseRecord(value: unknown): value is LeaseRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).holder === "string" &&
    typeof (value as Record<string, unknown>).expiresAt === "number"
  );
}

function readLeaseRecord(path: string): LeaseRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isLeaseRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function createLeaseFile(path: string, record: LeaseRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "wx", 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify(record), "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
  } finally {
    closeSync(descriptor);
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Tenta adquirir a lease exclusiva de arquivo em `path` (ex.:
 * `<tokens>.lock`), por `holder`, válida por `ttlSeconds` a partir de `now`
 * (segundos, `Date.now() / 1000` por padrão). `open(path, "wx")` é a
 * exclusão mútua: falha com `EEXIST` se o arquivo já existe. Uma lease
 * encontrada já expirada (processo dono morto sem passar pelo `finally` de
 * `releaseFileLease`) é removida e a criação é retentada exatamente uma
 * vez — nem essa segunda tentativa nem a leitura do registro existente
 * lançam por conta própria; qualquer falha de leitura (arquivo corrompido,
 * removido entre o `EEXIST` e o `readFileSync`) é tratada como "sem lease
 * viva conhecida", não como erro fatal, porque o próximo `open` decide o
 * resultado de qualquer forma.
 */
export function acquireFileLease(
  path: string,
  holder: string,
  ttlSeconds: number,
  now = Date.now() / 1000,
): boolean {
  try {
    createLeaseFile(path, { holder, expiresAt: now + ttlSeconds });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const existing = readLeaseRecord(path);
  if (existing !== null && existing.expiresAt > now) return false;
  unlinkIfExists(path);
  try {
    createLeaseFile(path, { holder, expiresAt: now + ttlSeconds });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Libera a lease em `path` só se ainda pertencer a `holder` — um dono
 * atrasado (ex.: passou do TTL antes de chegar ao `finally`) não pode
 * apagar a lease de quem já tomou seu lugar depois de expirada. Sem essa
 * checagem, `releaseFileLease` do dono original removeria a lease VIVA do
 * novo dono, e um terceiro entraria sem exclusão nenhuma.
 */
export function releaseFileLease(path: string, holder: string): void {
  const existing = readLeaseRecord(path);
  if (existing === null || existing.holder !== holder) return;
  unlinkIfExists(path);
}

/**
 * Espera até a lease em `path` sumir (liberada por quem a detinha) ou até
 * o próprio TTL registrado nela vencer, sondando a cada `pollMs`
 * (5 ms por padrão). Bounded por `maxWaitMs`: desiste sem lançar se a
 * lease nunca aparecer livre — o dono pode ter morrido sem nunca chegar a
 * `releaseFileLease` E sem que ninguém ainda tenha tomado a lease de volta
 * (isso só acontece na próxima `acquireFileLease`). Quem chama sempre relê
 * o arquivo protegido depois de esperar, então uma desistência aqui não
 * trava ninguém — só faz o chamador decidir com o que encontrar.
 */
export async function waitForFileLease(
  path: string,
  options: {
    readonly maxWaitMs: number;
    readonly pollMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const pollMs = options.pollMs ?? 5;
  const now = options.now ?? (() => Date.now() / 1000);
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const deadline = Date.now() + options.maxWaitMs;
  for (;;) {
    const existing = readLeaseRecord(path);
    if (existing === null || existing.expiresAt <= now()) return;
    if (Date.now() >= deadline) return;
    await sleep(pollMs);
  }
}
