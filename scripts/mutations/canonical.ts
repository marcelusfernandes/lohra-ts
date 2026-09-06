// Cópia do `canonical.ts` legado de paridade (issue #148): `scripts/mutations/**`
// não importa nada da árvore legada de paridade, então o pouco que é
// realmente compartilhado — serialização JSON com chaves ordenadas e hash —
// vem junto em vez de virar uma dependência cruzada entre os dois diretórios.
import { createHash } from "node:crypto";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
