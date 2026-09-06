// Compat shim: a implementação foi movida para
// scripts/mutations/media-comparator.ts (issue #151, passo 0d do épico
// #13; `git mv` preserva o histórico). Este arquivo existe só para não
// quebrar scripts/parity/media/run-all.ts (histórico, fora de escopo da
// #151 — depende do oráculo Python retirado) sem tocá-lo: reexporta a
// fonte única, não duplica o comparador.
export * from "../../mutations/media-comparator.js";
