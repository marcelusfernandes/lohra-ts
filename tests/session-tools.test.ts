// Cobre a composição de ferramentas de sessão (issue #153, passo 0f do
// épico #13): `composeSessionTools` precisa substituir o handler de
// fail-safe de `run_workflow` (registrado em `createBuiltinRegistry`) pelo
// `WorkflowTool` real construído a partir do `WorkflowService` da sessão --
// sem isso, todo run_workflow devolveria sempre a mesma mensagem de
// fail-safe, silenciosamente, em vez de rodar workflows de verdade.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { composeSessionTools, createSessionToolBase } from "../src/commands/session-tools.js";
import { openStateDatabase, SessionRepository } from "../src/state/index.js";
import { WorkflowService, type ChildRuntime } from "../src/workflow/index.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function neverSpawningRuntime(): ChildRuntime {
  return {
    spawn: () => {
      throw new Error("unexpected spawn: this test never reaches a real leaf");
    },
    collect: () => {
      throw new Error("unexpected collect: this test never reaches a real leaf");
    },
    steer: () => {
      throw new Error("unexpected steer: this test never reaches a real leaf");
    },
    cancel: () => {
      throw new Error("unexpected cancel: this test never reaches a real leaf");
    },
  };
}

function setup(): { readonly tools: ReturnType<typeof composeSessionTools> } {
  const root = mkdtempSync(join(tmpdir(), "lohra-session-tools-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const sessions = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
  const base = createSessionToolBase(connection.database, {});
  const workflowService = new WorkflowService({ runtime: neverSpawningRuntime() });
  const tools = composeSessionTools({
    base,
    home: root,
    cwd: root,
    environment: {},
    sessions,
    workflowService,
    orchestrationHandlers: {},
    visionRunner: {
      complete: () => Promise.reject(new Error("unused in this test")),
      close: () => {},
    },
    visionModel: "vision-model",
    supportsVision: false,
  });
  return { tools };
}

describe("composeSessionTools", () => {
  it("wires run_workflow to the real WorkflowService, not the fail-safe placeholder", async () => {
    const { tools } = setup();
    const raw = await tools.dispatch("run_workflow", {});
    const parsed = JSON.parse(raw) as { readonly error?: string };
    // O handler de fail-safe (src/tools/builtins.ts) devolve "workflow tools
    // must be intercepted with a session WorkflowService" -- se
    // `composeSessionTools` deixar de espalhar `workflowToolHandlers(...)`,
    // é essa mensagem que volta em vez da validação real do WorkflowTool.
    expect(parsed.error, "MUTATION_CAUSE:T22-hotspot-workflow-handler").toBe(
      "run_workflow needs a 'spec' object (with meta + nodes)",
    );
  });
});
