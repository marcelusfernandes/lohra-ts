import { CACHE_MISS } from "./engine-contract.js";
import {
  applyCheckpointAnswer,
  asRecord,
  renderValue,
  resolveCheckpoint,
  strictResolve,
} from "./engine-utils.js";
import type { FlowDeps } from "./flow-strategies.js";
import { ESCALATED_PAUSE, MAX_ESCALATE_SUMMARY } from "./nodes.js";
import { evaluatePredicate, type Predicate } from "./predicates.js";
import { findRefs } from "./refs.js";
import type { Node } from "./types.js";

/**
 * The `escalate` node (épico #976, issue #981): stops the run for a person only when `when`
 * holds, and carries a `kind` and a `summary` for the reviewer. It is the conditional sibling of
 * `checkpoint`: the answer comes by the same channel (`checkpoint_answers[node_id]`, scoped
 * inside a nested `workflow`, `ANSWER_NODE_TYPES`), but it has no `default` — nothing makes it
 * resume on its own — and it spawns nothing at all.
 *
 * - **When it does not hold.** `{escalated: false}`: no leaf, no cell, no lookup, no fault, and
 *   the run goes on. `when` is read again on every run, so a condition that stopped holding
 *   after an answer was recorded does not ask again either.
 * - **When it holds and nothing answers.** The run ends `paused` with `pause_reason:
 *   "escalated"` and the payload `{node_id, kind, summary}` (`node_id` scoped like a
 *   checkpoint's, plus `rename_hint` when that scoped key is itself a dead end). The node is
 *   `null`, nothing after it runs, and the pause is the fault that names it.
 * - **When it holds and an answer comes.** `{escalated: true, kind, summary, answer}`, stored
 *   in the node's cell, so a later run replays it and never asks again. A falsy answer (`""`,
 *   `0`, `false`, `null`) is an answer. A collision (a root or sibling id that owns the same
 *   key) is refused and named, exactly as for a checkpoint.
 * - **Cell.** `[id, "escalate", kind, summary]`, written only once there is an answer. The
 *   summary is in the identity (rendered): when the case in front of the reviewer changes, it
 *   is another question. `when` is not — it is read before the lookup.
 * - **Failure.** A root of `when` that failed (`null`), or a `summary` that reads one, is
 *   `<id>: upstream null` and the node is `null` without a pause. A rendered summary longer
 *   than `MAX_ESCALATE_SUMMARY` is cut with a trailing `…`, never silently dropped.
 * - **Budget.** Zero leaves: nothing to gate or charge.
 */
export function runEscalate(
  deps: FlowDeps,
  node: Node,
  context: Readonly<Record<string, unknown>>,
): unknown {
  const when = asRecord(node.fields.when);
  const { kind, summary: template } = node.fields;
  if (when === null || typeof kind !== "string" || typeof template !== "string")
    throw new Error(
      `escalate '${node.id}' has no valid 'when', 'kind' or 'summary': validateEscalate refuses it`,
    );

  if (readsDeadUpstream(when, context)) {
    deps.recordFault(`${node.id}: upstream null`);
    return null;
  }
  if (!evaluatePredicate(when as unknown as Predicate, context)) return NOT_ESCALATED;

  const resolved = strictResolve(template, context);
  if (resolved === null) {
    deps.recordFault(`${node.id}: upstream null`);
    return null;
  }
  const summary = clamp(renderValue(resolved));
  const hash = deps.cell([node.id, "escalate", kind, summary]);
  const cached = deps.cacheGet(hash);
  if (cached !== CACHE_MISS) return cached;

  const answer = resolveCheckpoint(deps.checkpointAnswers, deps.nodeScope, node.id);
  if (answer.matched)
    return applyCheckpointAnswer(
      deps.cache,
      deps.runId,
      hash,
      answer.scoped,
      Object.freeze({ escalated: true, kind, summary, answer: answer.answer }),
    );
  deps.pause(
    ESCALATED_PAUSE,
    answer.collision === "none"
      ? `${node.id}: escalated for review (${kind}) — waiting for an answer`
      : answer.message,
    Object.freeze({
      node_id: answer.scoped,
      kind,
      summary,
      ...(answer.collision === "scoped"
        ? {
            rename_hint:
              `resuming with node_id '${answer.scoped}' will collide again — it is a ROOT ` +
              `checkpoint or escalate's own literal id; rename one of the two ids in the spec`,
          }
        : {}),
    }),
  );
  return null;
}

/**
 * Whether `output` is the answer of an `escalate` whose `when` did not hold — it ran, and there
 * was nothing to replay or to pay. The preview (`cache-preview.ts`) reports that as `no_leaves`.
 */
export function escalateDidNotFire(node: Node, output: unknown): boolean {
  return node.type === "escalate" && asRecord(output)?.escalated === false;
}

const NOT_ESCALATED: unknown = Object.freeze({ escalated: false });

const ELLIPSIS = "…";

/**
 * The summary as the reviewer gets it: at most `MAX_ESCALATE_SUMMARY` characters, cut visibly.
 * A cut that would split a surrogate pair drops the orphaned half instead of keeping it.
 */
function clamp(text: string): string {
  if (text.length <= MAX_ESCALATE_SUMMARY) return text;
  const cut = text.slice(0, MAX_ESCALATE_SUMMARY - ELLIPSIS.length);
  const last = cut.charCodeAt(cut.length - 1);
  const orphaned = last >= 0xd800 && last <= 0xdbff;
  return `${orphaned ? cut.slice(0, -1) : cut}${ELLIPSIS}`;
}

/**
 * Whether some path of `when` starts at a node that failed. Every path of a validated predicate
 * is exactly one `${ref}` (operands carry none), so the refs found in it are its paths, `not.of`
 * included. A root absent from the context counts as `null`, as in `switch` and `loop`.
 */
function readsDeadUpstream(
  when: Readonly<Record<string, unknown>>,
  context: Readonly<Record<string, unknown>>,
): boolean {
  return findRefs(when).some((reference) => {
    const root = reference.split(".", 1)[0] ?? reference;
    return (Object.hasOwn(context, root) ? context[root] : null) === null;
  });
}
