import { CACHE_MISS } from "./engine-contract.js";
import { asRecord, renderValue, routingIdentity, strictResolve } from "./engine-utils.js";
import type { FlowStrategy } from "./flow-strategies.js";
import { bodyKnobCellParts, makeBodyLeafRunner } from "./leaf-options.js";
import { isEmptyOutput } from "./output-validation.js";
import { pathRef } from "./predicates.js";
import { readPath } from "./refs.js";
import type { Node } from "./types.js";

/**
 * The `switch` node (épico #976, issue #979): reads one field of the state, picks the case
 * whose name is that value, and runs exactly that case's leaf. The other cases do not exist
 * at run time — no spawn, no cell, no cache key, no event, and their prompts are never
 * resolved. A `null` case is a branch that runs nothing (stop here, or reuse the answer).
 *
 * - **Value.** `node.fields.value` is exactly one `${ref}` (`validateSwitch`), read with
 *   `readPath`, so it sees what a prompt would render: a JSON string and an array index are
 *   traversed, and an absent field is `null`. A string, a finite number or a boolean names a
 *   case by its string form; anything else (null, a list, an object) names none. An inherited
 *   name (`constructor`) is not a case.
 * - **Output.** `{case, matched, output}`: the case that ran, whether the value named it
 *   (`false` when `otherwise` caught it), and the leaf's output (`null` for a `null` case).
 * - **Failure.** The ROOT of `value` being `null` means the upstream failed: `<id>: upstream
 *   null`. That is not the same as a root that is there but lacks the field, which is only a
 *   value that matches nothing. A value that matches nothing without `otherwise` is a fault
 *   that names the value; a case prompt that reads a `null` is `upstream null` as well.
 * - **Cell.** Identity is `[id, "switch", case, prompt, schema, routing, body knobs]`: the
 *   same value replays it, another case is another cell (`cache.missed{identity_changed}`),
 *   and a value that lands on the same case through `otherwise` replays it too.
 * - **Budget.** One leaf, through the gate every leaf passes (`collectLeaf`); a `null` case
 *   costs nothing.
 */
export const runSwitch: FlowStrategy = async (deps, node, context) => {
  const reference = pathRef(node.fields.value);
  const cases = asRecord(node.fields.cases);
  if (reference === null || cases === null)
    throw new Error(
      `switch '${node.id}' has no valid 'value' or 'cases': validateSwitch refuses it`,
    );

  const root = reference.split(".", 1)[0] ?? reference;
  if ((Object.hasOwn(context, root) ? context[root] : null) === null) {
    deps.recordFault(`${node.id}: upstream null`);
    return null;
  }

  const found = readPath(reference, context);
  const picked = pick(node, cases, found);
  if (picked === null) {
    deps.recordFault(`${node.id}: no case matches ${shown(found)} and the switch has no otherwise`);
    return null;
  }

  const body = cases[picked.name];
  if (body === null) return outcome(picked, null);
  const caseBody = asRecord(body);
  if (caseBody === null)
    throw new Error(`switch '${node.id}' case '${picked.name}' is neither null nor an object`);

  const prompt = strictResolve(caseBody.prompt, context);
  if (prompt === null) {
    deps.recordFault(`${node.id}: upstream null`);
    return null;
  }
  const rendered = renderValue(prompt);
  const schema = deps.schemaOf(caseBody);
  const hash = deps.cell([
    node.id,
    "switch",
    picked.name,
    rendered,
    schema,
    ...routingIdentity(node, deps.tiers),
    ...bodyKnobCellParts(caseBody),
  ]);
  const cached = deps.cacheGet(hash);
  if (cached !== CACHE_MISS) return outcome(picked, cached);

  const runCase = makeBodyLeafRunner(deps, node, caseBody);
  const leaf = await runCase(rendered, schema, {
    role: "switch.case",
    cellId: hash,
    itemIndex: Object.keys(cases).indexOf(picked.name),
  });
  if (leaf.output === null) return null;
  if (isEmptyOutput(leaf.output)) {
    deps.recordFault(`${node.id}: case ${picked.name} returned an empty output`);
    return null;
  }
  deps.cachePut(hash, node.id, leaf.output, leaf.usage);
  return outcome(picked, leaf.output);
};

/**
 * Whether `output` is a `switch` that took a `null` case — it ran, and there was nothing to
 * replay or to pay. The preview (`cache-preview.ts`) reports that as `no_leaves`.
 */
export function switchTakesNoLeaf(node: Node, output: unknown): boolean {
  if (node.type !== "switch") return false;
  const cases = asRecord(node.fields.cases);
  const name = asRecord(output)?.case;
  return cases !== null && typeof name === "string" && Object.hasOwn(cases, name)
    ? cases[name] === null
    : false;
}

interface Picked {
  readonly name: string;
  readonly matched: boolean;
}

const outcome = (picked: Picked, output: unknown): unknown =>
  Object.freeze({ case: picked.name, matched: picked.matched, output });

/** The case a scalar value names, by its string form; anything else names none. */
function caseName(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function pick(node: Node, cases: Readonly<Record<string, unknown>>, value: unknown): Picked | null {
  const name = caseName(value);
  if (name !== null && Object.hasOwn(cases, name)) return { name, matched: true };
  const otherwise = node.fields.otherwise;
  if (typeof otherwise === "string" && Object.hasOwn(cases, otherwise))
    return { name: otherwise, matched: false };
  return null;
}

const SHOWN_CHARACTERS = 60;

/** A value for a fault message: a string quoted, anything else as JSON, both bounded. */
function shown(value: unknown): string {
  const text = typeof value === "string" ? JSON.stringify(value) : renderValue(value);
  return text.length > SHOWN_CHARACTERS ? `${text.slice(0, SHOWN_CHARACTERS)}…` : text;
}
