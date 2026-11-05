import { usage } from "../pricing/usage.js";
import { callDeadlineMs, isCallTool } from "./call-tools.js";
import { CACHE_MISS } from "./engine-contract.js";
import { asRecord, clampInteger, stoppedByControl } from "./engine-utils.js";
import type { FlowDeps, FlowStrategy } from "./flow-strategies.js";
import { DEFAULT_CALL_TIMEOUT_SECONDS, MAX_NODE_RETRIES } from "./nodes.js";
import { findRefs, readPath, resolveValue } from "./refs.js";
import type { CallToolRequest, CallToolResult } from "./runtime.js";
import type { Node } from "./types.js";

/**
 * The `call` node (épico #976, issue #982): runs ONE read-only tool with no model — `read_file`
 * or `web_fetch`, the allow-list of `CALL_TOOLS` — so the steps of a workflow that need no
 * judgement are cheap and predictable. It goes through the port `ChildRuntime.callTool` (#978),
 * which composes the very same sandbox, taint and fence a leaf's tool call gets: this file
 * decides when to call, how often and what a failure says, never whether a path or a host is
 * allowed.
 *
 * - **Args.** `args` (up to `MAX_CALL_ARGS` keys; a value may be a `${ref}`) is resolved against
 *   the state before anything is asked of the port. A `${ref}` that reads nothing — its root is
 *   a node that failed, or the field is not there — is `<id>: upstream null` plus a fault that
 *   names every ref with no value, and no call is made: a tool must never run on an argument
 *   that was not filled in. A falsy value (`0`, `false`, `""`) is a value.
 * - **Output.** The tool's own envelope, parsed (`{ok, data, truncated, path}` for `read_file`,
 *   `{ok, url, text, untrusted}` for `web_fetch`), so `${n.field}` reads it. An `ok` that is not
 *   a JSON object is a failed attempt, never a silent `null`.
 * - **Attempts.** `1 + retries` (`retries` 0 to `MAX_NODE_RETRIES`, none by default), each with
 *   `checkFanout(1)` + `charge()` and no tokens: an exhausted lifetime is a `FanoutRejected` the
 *   engine counts as a cap trip, and the failure before it is still named. `error` and `timeout`
 *   are retried; `denied` never is — the sandbox answered before any dispatch, and asking again
 *   cannot change the policy. Every attempt has its own `attempt` in the causal context, so the
 *   ledger's `tool.started`/`tool.completed` pair (and its synthetic `sub_id`) is unique.
 * - **Failure.** Once the attempts are spent (or on a denial), the node is `null` with one
 *   fault: `<id>: call <tool> <status> after <n> attempt(s): <cause>`. Nothing is cached.
 * - **Stopped run.** A run that is paused or cancelled makes no call, and none after an attempt
 *   that finds it so; that is `null` with no fault of the node's own (the pause or the cancel
 *   already recorded its cause) and a resume carries on. A call already in flight is awaited
 *   and kept.
 * - **Waiting.** The port's deadline is `unref()`'d, so a dispatch that held no handle would
 *   let the process leave before it fired and leave a `tool.*` pair open. The engine therefore
 *   holds a ref'd timer for as long as the call is pending, and always awaits the result.
 * - **Cell.** `[id, "call", tool, args-resolved]`, written with zero cost (no cost row, no
 *   tokens) only on success. `timeout` and `retries` are not in it: a resume may tighten or
 *   loosen them and still replay. A replayed cell never reaches the port, so it needs none.
 * - **No port.** A runtime without `callTool` is an engine fault, not a skip.
 */
export const runCall: FlowStrategy = async (deps, node, context) => {
  const { tool } = node.fields;
  const rawArgs = node.fields.args === undefined ? {} : asRecord(node.fields.args);
  if (typeof tool !== "string" || !isCallTool(tool) || rawArgs === null)
    throw new Error(`call '${node.id}' has no valid 'tool' or 'args': validateCall refuses it`);

  const empty = [
    ...new Set(findRefs(rawArgs).filter((reference) => readPath(reference, context) === null)),
  ];
  if (empty.length > 0) {
    deps.recordFault(`${node.id}: upstream null`);
    deps.recordFault(`${node.id}: no value for ${empty.map((ref) => `\${${ref}}`).join(", ")}`);
    return null;
  }

  const args = resolveValue(rawArgs, context) as Readonly<Record<string, unknown>>;
  const hash = deps.cell([node.id, "call", tool, args]);
  const cached = deps.cacheGet(hash);
  if (cached !== CACHE_MISS) return cached;

  const { runtime } = deps;
  if (runtime.callTool === undefined)
    throw new Error(
      `call '${node.id}': this runtime has no callTool port, so '${tool}' cannot be called without a model`,
    );
  const port = runtime.callTool.bind(runtime);
  const timeoutSeconds =
    typeof node.fields.timeout === "number" ? node.fields.timeout : DEFAULT_CALL_TIMEOUT_SECONDS;
  const attempts = 1 + clampInteger(node.fields.retries, 0, MAX_NODE_RETRIES);

  const attempt = async (made: number, previous: Failure | null): Promise<unknown> => {
    if (stoppedByControl(deps.control)) return null;
    gate(deps, node, previous);
    const request: CallToolRequest = {
      name: tool,
      args,
      timeoutSeconds,
      causalContext: deps.causal("call", hash, { attempt: made }),
    };
    const settled = interpret(await held(port, request));
    if ("envelope" in settled) {
      deps.cachePut(hash, node.id, settled.envelope, usage());
      return settled.envelope;
    }
    const failure: Failure = { ...settled, tool, attempts: made + 1 };
    if (failure.status === "denied" || failure.attempts >= attempts) {
      deps.recordFault(describe(node, failure));
      return null;
    }
    return attempt(made + 1, failure);
  };
  return attempt(0, null);
};

interface Failure {
  readonly tool: string;
  readonly status: "error" | "denied" | "timeout";
  readonly cause: string;
  readonly attempts: number;
}

type Interpreted = { readonly envelope: unknown } | Pick<Failure, "status" | "cause">;

/** The limits one attempt is charged to; a refusal after a failed attempt does not lose that failure. */
function gate(deps: FlowDeps, node: Node, previous: Failure | null): void {
  try {
    deps.budget.checkFanout(1);
  } catch (error) {
    if (previous !== null) deps.recordFault(describe(node, previous));
    throw error;
  }
  deps.budget.charge();
}

/** How long past the port's own deadline the ref'd timer below still holds the process. */
const HOLD_GRACE_MS = 1_000;

/**
 * Awaits the port while a ref'd timer — as long as the port's deadline plus a grace — keeps the
 * event loop alive: the port's own deadline timer is `unref()`'d, so without this a dispatch that
 * holds no handle could end the process before it fired, with the `tool.*` pair left open.
 */
async function held(
  port: (request: CallToolRequest) => CallToolResult | Promise<CallToolResult>,
  request: CallToolRequest,
): Promise<CallToolResult> {
  const hold = setTimeout(() => undefined, callDeadlineMs(request.timeoutSeconds) + HOLD_GRACE_MS);
  try {
    return await port(request);
  } finally {
    clearTimeout(hold);
  }
}

function interpret(result: CallToolResult): Interpreted {
  if (result.status !== "ok") return { status: result.status, cause: causeOf(result.output) };
  let envelope: unknown;
  try {
    envelope = JSON.parse(result.output);
  } catch {
    return { status: "error", cause: "the tool's ok envelope is not valid JSON" };
  }
  return asRecord(envelope) === null
    ? { status: "error", cause: "the tool's ok envelope is not a JSON object" }
    : { envelope };
}

const MAX_CAUSE_CHARACTERS = 300;

/** What the tool (or the sandbox) said, on one bounded line: its `error` field, or the text itself. */
function causeOf(output: string): string {
  let said = output;
  try {
    const error = asRecord(JSON.parse(output) as unknown)?.error;
    if (typeof error === "string") said = error;
  } catch {
    // not JSON: the text is the cause
  }
  const flat = said.replace(/\s+/gu, " ").trim();
  if (flat === "") return "(no detail)";
  const letters = Array.from(flat);
  return letters.length > MAX_CAUSE_CHARACTERS
    ? `${letters.slice(0, MAX_CAUSE_CHARACTERS - 1).join("")}…`
    : flat;
}

function describe(node: Node, failure: Failure): string {
  const count = `${String(failure.attempts)} attempt${failure.attempts === 1 ? "" : "s"}`;
  return `${node.id}: call ${failure.tool} ${failure.status} after ${count}: ${failure.cause}`;
}
