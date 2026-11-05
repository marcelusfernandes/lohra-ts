import { CACHE_MISS } from "./engine-contract.js";
import {
  asRecord,
  renderValue,
  routingIdentity,
  stoppedByControl,
  strictResolve,
} from "./engine-utils.js";
import type { FlowStrategy } from "./flow-strategies.js";
import { bodyKnobCellParts, makeBodyLeafRunner } from "./leaf-options.js";
import { MAX_LOOP_ROUNDS } from "./nodes.js";
import { isEmptyOutput } from "./output-validation.js";
import { evaluatePredicate, type Predicate } from "./predicates.js";
import { findRefs } from "./refs.js";

/**
 * The `loop` node (épico #976, issue #980): runs its `body` once per round and stops at the
 * first round where `until` holds, or at `max_rounds`. The cap is mandatory (1 to
 * `MAX_LOOP_ROUNDS`) — there is no default and no way to spell "forever".
 *
 * - **Locals.** Round `r` renders `body.prompt` with `${round}` (= `r`) and `${so_far}` (the
 *   outputs of the rounds before it, in order). `until` is evaluated right after the round
 *   with the same two and `${last}`, the output of the round that just ran. `last` exists
 *   nowhere else — `validateLoop` and `validateRefTargets` (`schema-nodes.ts`) keep it out of
 *   every other field.
 * - **Output.** `{last, rounds, until_met}`: the output of the final round, how many rounds
 *   ran, and whether `until` held. At the cap it is `until_met: false` with a fault that names
 *   the node and the cap (the run ends `degraded`, never silently complete); the last output
 *   is still returned, because it is the best the loop produced.
 * - **Failure.** A dead round (no output) is a fault naming the round and a `null` node; an
 *   empty answer is a fault too and is never cached. A run that is pausing or cancelling makes
 *   a round come back without an output as well — that is `null` with no fault of the loop's
 *   own (the pause or cancel already recorded its cause), and a resume carries on.
 * - **Upstream.** An `until` path whose ROOT is a node that failed (`null`) is
 *   `<id>: upstream null` before any round runs: the loop would otherwise pay for
 *   `max_rounds` leaves to test a condition that can never hold. A root that is there but lacks
 *   the field is only a value. The body prompt is guarded by `strictResolve`, round by round.
 * - **Cells.** One per round: `[id, "loop", round, prompt, schema, routing, body knobs]`. The
 *   round is in the identity because a body that never reads the state would otherwise be the
 *   same cell every round; `until` and `max_rounds` are not, so a resume may tighten the first
 *   or raise the second and still replay every round already paid for. A resume therefore
 *   replays rounds `0..k-1` without a spawn and runs on from `k`.
 * - **Budget.** `checkFanout(max_rounds)` before round 0 (a `FanoutRejected` is caught by
 *   `WorkflowEngine.run`, counted as a cap trip and named); each round's leaf then goes
 *   through the gate every leaf passes (`collectLeaf`). Progress is `items {done, total}` with
 *   `total = max_rounds`, reported at the start and after every round, replayed ones included.
 */
export const runLoopUntil: FlowStrategy = async (deps, node, context) => {
  const body = asRecord(node.fields.body);
  const until = asRecord(node.fields.until);
  const maxRounds = node.fields.max_rounds;
  if (body === null || until === null || !isRoundCap(maxRounds))
    throw new Error(
      `loop '${node.id}' has no valid 'body', 'until' or 'max_rounds': validateLoop refuses it`,
    );

  if (readsDeadUpstream(until, context)) {
    deps.recordFault(`${node.id}: upstream null`);
    return null;
  }
  deps.budget.checkFanout(maxRounds);

  const schema = deps.schemaOf(body);
  const runBody = makeBodyLeafRunner(deps, node, body);
  const earlier: unknown[] = [];
  let last: unknown = null;
  deps.noteItems(node.id, 0, maxRounds);
  for (let round = 0; round < maxRounds; round += 1) {
    const locals = Object.freeze({ ...context, round, so_far: Object.freeze([...earlier]) });
    const prompt = strictResolve(body.prompt, locals);
    if (prompt === null) {
      deps.recordFault(`${node.id}: upstream null`);
      return null;
    }
    const rendered = renderValue(prompt);
    const hash = deps.cell([
      node.id,
      "loop",
      round,
      rendered,
      schema,
      ...routingIdentity(node, deps.tiers),
      ...bodyKnobCellParts(body),
    ]);
    const cached = deps.cacheGet(hash);
    if (cached !== CACHE_MISS) {
      last = cached;
    } else {
      const leaf = await runBody(rendered, schema, {
        role: "loop.round",
        cellId: hash,
        attempt: round,
      });
      if (leaf.output === null) {
        if (!stoppedByControl(deps.control))
          deps.recordFault(`${node.id}: round ${String(round)} dead`);
        return null;
      }
      if (isEmptyOutput(leaf.output)) {
        deps.recordFault(`${node.id}: round ${String(round)} returned an empty output`);
        return null;
      }
      deps.cachePut(hash, node.id, leaf.output, leaf.usage);
      last = leaf.output;
    }
    deps.noteItems(node.id, round + 1, maxRounds);
    if (evaluatePredicate(until as unknown as Predicate, Object.freeze({ ...locals, last })))
      return outcome(last, round + 1, true);
    earlier.push(last);
  }
  deps.recordFault(`${node.id}: reached max_rounds (${String(maxRounds)}) without 'until' holding`);
  return outcome(last, maxRounds, false);
};

const isRoundCap = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_LOOP_ROUNDS;

const outcome = (last: unknown, rounds: number, untilMet: boolean): unknown =>
  Object.freeze({ last, rounds, until_met: untilMet });

/** The roots `until` reads that the loop itself provides: they are never an upstream node. */
const LOOP_LOCALS: ReadonlySet<string> = new Set(["round", "so_far", "last"]);

/**
 * Whether some path of `until` starts at a node that failed. Every path of a validated
 * predicate is exactly one `${ref}` (operands carry none), so the refs found in it are its
 * paths, `not.of` included. A root absent from the context counts as `null`, as in `switch`.
 */
function readsDeadUpstream(
  until: Readonly<Record<string, unknown>>,
  context: Readonly<Record<string, unknown>>,
): boolean {
  return findRefs(until).some((reference) => {
    const root = reference.split(".", 1)[0] ?? reference;
    return !LOOP_LOCALS.has(root) && (Object.hasOwn(context, root) ? context[root] : null) === null;
  });
}
