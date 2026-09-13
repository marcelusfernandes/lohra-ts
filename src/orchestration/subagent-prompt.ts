import { buildSystemPrompt, DEFAULT_IDENTITY, DOCTRINE_CORE } from "../context/index.js";

/**
 * Byte-measured against evidence-s01-child-real.json's child_system_full
 * (and confirmed unchanged across an idle-steer resurrection by
 * evidence-s02-steer.json) — no memory/user-profile/skills sections, since a
 * subagent has no access to those stores. Issue #579 (épico #575, P3) added
 * DOCTRINE_CORE as a fourth static paragraph between this one and the date;
 * the byte-exact contract moved from a hardcoded literal to
 * `tests/orchestration-subagent-prompt.test.ts` composing DOCTRINE_CORE in.
 */
const SUBAGENT_ISOLATION =
  "You are an isolated subagent spawned to complete one specific task. You " +
  "have no access to the parent conversation, its memory, or its skills, " +
  "and you cannot delegate further. Use the available tools to complete " +
  "the task, then end with a concise summary of what you did and the " +
  "outcome.";

/**
 * The subagent's system prompt text. Captured once at spawn by
 * OrchestrationCore's buildSubagentPrompt (decision 25) and reused verbatim
 * for every later turn of that child — this function itself has no memory of
 * past calls and must never be invoked again mid-session to "refresh" it.
 * No today override reuses buildSystemPrompt's own default so the pending
 * T09 UTC-vs-local-date fix on that shared file is inherited automatically
 * rather than duplicated here.
 */
export function buildSubagentSystemPrompt(overrides: { readonly today?: string } = {}): string {
  return buildSystemPrompt({
    identity: `${DEFAULT_IDENTITY}\n\n${SUBAGENT_ISOLATION}`,
    // Issue #579 (épico #575, P3): sempre o núcleo universal, nunca a
    // extensão — este call site (`orchestration/chat-wiring.ts`) não tem o
    // perfil do provedor pai disponível para decidir a faixa
    // (`resolveDoctrineTier`), e essa fiação está fora dos `Files` desta
    // issue. #583 (P7, "prompt do subagente com ambiente, tools e contrato
    // de retorno") é quem estende este call site com mais contexto.
    doctrine: DOCTRINE_CORE,
    ...(overrides.today === undefined ? {} : { today: overrides.today }),
  }).text;
}
