#!/usr/bin/env node
// Stub (issue #151, test(red)): a mecânica B (cpSync(src) + import
// dinâmico em processo + comparador) do runner de mídia antigo
// (`scripts/parity/media/run-mutations.ts`, agora um shim) ainda não
// migrou para cá. `mediaMutants` fica vazio até o commit verde.
import type { MediaMutant } from "./media-mutant.js";
import { otherMediaMutants } from "./media-catalog-other.js";
import { persistenceMutants } from "./media-catalog-persistence.js";

export const mediaMutants: readonly MediaMutant[] = Object.freeze([
  ...persistenceMutants,
  ...otherMediaMutants,
]);

export function runMediaMutations(): Promise<never> {
  throw new Error("not implemented");
}
