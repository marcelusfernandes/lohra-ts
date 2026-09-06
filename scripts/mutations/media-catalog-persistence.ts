// Stub (issue #151, test(red)): os 13 mutantes de `media/persistence.ts`
// ainda não migraram do runner antigo — `mutations-t21-catalog.test.ts`
// fica vermelho por uma asserção real (0 mutantes, não 20) até o commit
// verde preencher este catálogo.
import type { MediaMutant } from "./media-mutant.js";

export const persistenceMutants: readonly MediaMutant[] = [];
