// Reexporta o módulo migrado para tests/support/parity/gateway/ (issue
// #166): os consumidores de scripts/parity/gateway/** continuam com o
// caminho relativo curto de sempre, para não empurrar run-joint-gate.ts e
// run-scenarios.ts (já > 800 linhas na base) para além do limite só por
// causa do tamanho do caminho novo. Some junto com o resto de
// scripts/parity/ em #167.
export * from "../../../tests/support/parity/gateway/raw-http-client.js";
