// Issue #457 (dashboard mirror of #440/PR #455): `src/commands/dashboard.ts`
// discarded an explicit `--provider` in subscription mode in total silence
// while `--model` still reached the Codex Responses transport. Fixed with
// the same guard `chat.ts:172-179` already used for #440, extracted to
// `src/commands/subscription-guard.ts` so the refusal message is
// byte-identical between the two commands.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/dashboard-subscription-provider-flag.test.ts"],
} satisfies Declaracao;
