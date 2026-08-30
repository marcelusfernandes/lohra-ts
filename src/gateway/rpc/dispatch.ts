import type { GatewaySessionRegistry } from "../session-service.js";

// The 39 RPCs documented in docs/reference/specs/04-gateway-protocol.md that
// do not exist on the wire at this oracle commit (T12 baseline L22,
// evidence-s10-doc-gap.json.documented_rpc). Named literally -- a candidate
// that treats a family (config.*, model.*, tools.*, reload.*, plugins.*,
// skills.*) as covered by one sample test does not satisfy the contract.
// session.steer is this ticket's /v1/runs-class trap: it must NEVER be
// implemented, even though the ticket's own prose mentions "steer between
// iterations" -- that surface belongs to T13's orchestration inbox, not the
// gateway WS.
export const DOCUMENTED_AND_ABSENT_RPC_METHODS: readonly string[] = [
  "session.most_recent",
  "session.resume",
  "session.delete",
  "session.title",
  "session.usage",
  "session.status",
  "session.cwd.set",
  "session.undo",
  "session.compress",
  "session.branch",
  "session.steer",
  "prompt.background",
  "clarify.respond",
  "sudo.respond",
  "secret.respond",
  "approval.respond",
  "clipboard.paste",
  "image.attach",
  "pdf.attach",
  "file.attach",
  "terminal.resize",
  "config.set",
  "config.get",
  "config.show",
  "model.options",
  "model.save_key",
  "model.disconnect",
  "tools.list",
  "tools.show",
  "tools.configure",
  "toolsets.list",
  "setup.status",
  "reload.mcp",
  "reload.env",
  "plugins.list",
  "plugins.manage",
  "cron.manage",
  "skills.manage",
  "skills.reload",
];

export interface SessionDefaults {
  readonly model: string;
  readonly systemPrompt: string;
  readonly cwd: string;
}

export type SyncRpcOutcome =
  | { readonly kind: "result"; readonly result: unknown; readonly emitSessionInfoFor?: string }
  | { readonly kind: "error"; readonly code: number; readonly message: string }
  // Not a synchronous RPC (prompt.submit) -- the WS layer drives it, streaming
  // events over the same socket instead of returning a single result.
  | { readonly kind: "unhandled" };

function stringParam(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

// Dispatches the four synchronous real RPCs (session.create/list/history/
// interrupt). prompt.submit is intentionally routed back to the caller as
// "unhandled" -- it drives an async streaming turn over the WS socket, which
// this pure/sync dispatcher has no access to. Any method not in the sync set
// and not prompt.submit is -32601, covering both the 39 documented-and-absent
// RPCs and any other unrecognized method name.
export function dispatchSyncRpc(
  registry: GatewaySessionRegistry,
  method: string,
  params: Readonly<Record<string, unknown>>,
  sessionDefaults: SessionDefaults,
): SyncRpcOutcome {
  if (method === "session.create") {
    const { sessionId } = registry.createOrResurrect({
      ...(stringParam(params, "session_id") === undefined
        ? {}
        : { sessionId: stringParam(params, "session_id") as string }),
      model: sessionDefaults.model,
      systemPrompt: sessionDefaults.systemPrompt,
      cwd: sessionDefaults.cwd,
    });
    return { kind: "result", result: { session_id: sessionId }, emitSessionInfoFor: sessionId };
  }

  if (method === "session.list") {
    return { kind: "result", result: { sessions: registry.list() } };
  }

  if (method === "session.history") {
    return {
      kind: "result",
      result: { messages: registry.history(stringParam(params, "session_id")) },
    };
  }

  if (method === "session.interrupt") {
    return { kind: "result", result: registry.interrupt(stringParam(params, "session_id")) };
  }

  if (method === "prompt.submit") return { kind: "unhandled" };

  return { kind: "error", code: -32601, message: `unknown method: ${method}` };
}
