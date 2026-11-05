import { CACHE_MISS } from "./engine-contract.js";
import { applyCheckpointAnswer, asRecord, renderValue, resolveCheckpoint } from "./engine-utils.js";
import type { FlowDeps } from "./flow-strategies.js";
import { ESCALATED_PAUSE, MAX_ESCALATE_SUMMARY } from "./nodes.js";
import { evaluatePredicate, type Predicate } from "./predicates.js";
import { findRefs, readPath, resolveValue } from "./refs.js";
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
 *   summary is in the identity (as the reviewer sees it): when the case in front of the
 *   reviewer changes, it is another question. `when` is not — it is read before the lookup.
 * - **Fails closed.** A node that exists to put a person in front of a decision never lets a
 *   failure skip the person. A `when` that cannot be evaluated because the root of a path is a
 *   dead node (or has no value at all) is treated as holding: the run pauses, the summary opens
 *   with `[condition not evaluated: …]`, and the faults carry `<id>: upstream null` plus the
 *   pause fault that names the dead nodes. A `summary` that reads a value that is not there
 *   goes out as the raw template behind `[unrendered]`, and one that renders blank behind
 *   `[empty summary]`; the pause fault names the `${ref}` that is missing, or says it is empty.
 *   A rendered summary longer than `MAX_ESCALATE_SUMMARY` is cut with a trailing `…`. (A path
 *   whose root is there but lacks the field is only a value, as everywhere else: `gte` on
 *   nothing does not hold.)
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

  const dead = deadRoots(when, context);
  if (dead.length === 0 && !evaluatePredicate(when as unknown as Predicate, context))
    return NOT_ESCALATED;

  const rendered = renderSummary(template, context);
  const unevaluated = dead.length > 0;
  const named = dead.map((root) => `'${root}'`).join(", ");
  const summary = clamp(
    unevaluated
      ? `[condition not evaluated: ${named} has no value] ${rendered.text}`
      : rendered.text,
  );
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
  if (unevaluated) deps.recordFault(`${node.id}: upstream null`);
  const notes = [
    ...(unevaluated
      ? [`'when' could not be evaluated: ${named} has no value (upstream null)`]
      : []),
    ...rendered.notes,
  ];
  deps.pause(
    ESCALATED_PAUSE,
    [
      answer.collision === "none"
        ? `${node.id}: escalated for review (${kind}) — waiting for an answer`
        : answer.message,
      ...notes,
    ].join("; "),
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

const UNRENDERED = "[unrendered]";
const EMPTY_SUMMARY = "[empty summary]";

interface RenderedSummary {
  /** What goes in the payload (before the cut): the rendered text, or the raw template, marked. */
  readonly text: string;
  /** Why it is not the rendered text, for the pause fault; empty when it rendered. */
  readonly notes: readonly string[];
}

/**
 * The summary as the template says it, or — when it cannot be said — the template itself behind
 * a mark, never a blank and never a skipped review. A `${ref}` is missing when it reads `null`
 * the way a prompt would (`readPath`: a JSON string and an array index are traversed, an absent
 * field is `null`), and every missing one is named.
 */
function renderSummary(
  template: string,
  context: Readonly<Record<string, unknown>>,
): RenderedSummary {
  const missing = [...new Set(findRefs(template).filter((ref) => readPath(ref, context) === null))];
  if (missing.length > 0)
    return {
      text: `${UNRENDERED} ${template}`,
      notes: [
        `summary not rendered: no value for ${missing.map((ref) => `\${${ref}}`).join(", ")}`,
      ],
    };
  const text = renderValue(resolveValue(template, context));
  return text.trim() === ""
    ? { text: `${EMPTY_SUMMARY} ${template}`, notes: ["summary rendered empty"] }
    : { text, notes: [] };
}

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
 * The roots of `when`'s paths that hold no value — a node that failed (`null`), or a name the
 * context does not have — in order, once each. Every path of a validated predicate is exactly one
 * `${ref}` (operands carry none), so the refs found in it are its paths, `not.of` included. A root
 * that is there but lacks the field is not listed: that is only a value, as in `switch` and `loop`.
 */
function deadRoots(
  when: Readonly<Record<string, unknown>>,
  context: Readonly<Record<string, unknown>>,
): readonly string[] {
  const roots = findRefs(when)
    .map((reference) => reference.split(".", 1)[0] ?? reference)
    .filter((root) => (Object.hasOwn(context, root) ? context[root] : null) === null);
  return [...new Set(roots)];
}
