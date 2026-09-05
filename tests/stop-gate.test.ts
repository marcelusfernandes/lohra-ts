// Bancada do hook Stop `.claude/hooks/stop-gate.sh` (issue #43, sub-issue de #33).
//
// Cada caso invoca o hook em subprocesso num diretório temporário que faz o papel
// da raiz do repositório (o payload leva `cwd`; sem `.git`, o hook usa o próprio
// `cwd`). `LOHRA_BENCH=1` é o único portão que habilita as seams `LOHRA_STOP_*`
// (branch, último commit, comando do tsc, comando da prova) — sem ele, o hook
// ignora todas e roda tsc/prova de verdade. A prova real não roda aqui: o caso
// "sem bench" só prova que a seam é ignorada; a invocação real é a do próprio
// turno do agente.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(new URL("../.claude/hooks/stop-gate.sh", import.meta.url));

interface HookRun {
  readonly status: number | null;
  readonly stderr: string;
}

function limparAmbiente(): Record<string, string> {
  const limpo: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Só o portão e as quatro seams saem; LOHRA_STOP_GATE_ACTIVE fica — é a guarda
    // de reentrância, e apagá-la aqui deixaria um caso futuro sem bench recursar.
    if (k === "LOHRA_BENCH" || (k.startsWith("LOHRA_STOP_") && k !== "LOHRA_STOP_GATE_ACTIVE"))
      continue;
    limpo[k] = v;
  }
  return limpo;
}

function rodarHook(root: string, env: Record<string, string>): HookRun {
  const r = spawnSync("sh", [HOOK], {
    input: JSON.stringify({ hook_event_name: "Stop", cwd: root }),
    encoding: "utf8",
    env: { ...limparAmbiente(), ...env },
  });
  return { status: r.status, stderr: r.stderr };
}

function bench(extra: Record<string, string> = {}): Record<string, string> {
  return {
    LOHRA_BENCH: "1",
    LOHRA_STOP_TSC_CMD: "true",
    LOHRA_STOP_BRANCH: "feat/1-x",
    LOHRA_STOP_LAST_COMMIT_MSG: "feat: x",
    LOHRA_STOP_PROVA_CMD: "true",
    ...extra,
  };
}

describe("stop-gate.sh", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "stop-gate-"));
    mkdirSync(path.join(root, "prova"));
    writeFileSync(path.join(root, "prova", "x.ts"), "export default { unit: [] };\n");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("existe e é executável por sh", () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  it("branch fora do padrão <type>/<n>-<slug>: só tsc, exit 0", () => {
    const r = rodarHook(root, bench({ LOHRA_STOP_BRANCH: "main" }));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/fora do padrão/u);
  });

  it("prova vermelha: exit 2 e menciona o slug", () => {
    const r = rodarHook(root, bench({ LOHRA_STOP_PROVA_CMD: "false" }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/prova.*x.*reprovou/u);
  });

  it("prova vermelha com resumo.json: cola o resumo no stderr", () => {
    mkdirSync(path.join(root, ".prova", "x"), { recursive: true });
    writeFileSync(
      path.join(root, ".prova", "x", "resumo.json"),
      '{"ok":false,"total":3,"falhas":[{"nome":"t","motivo":"m"}]}',
    );
    const r = rodarHook(root, bench({ LOHRA_STOP_PROVA_CMD: "false" }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('"falhas"');
  });

  it("último commit test(red): pula a prova, exit 0", () => {
    const r = rodarHook(
      root,
      bench({ LOHRA_STOP_PROVA_CMD: "false", LOHRA_STOP_LAST_COMMIT_MSG: "test(red): x" }),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/test\(red\)/u);
  });

  it("sem prova/<slug>.ts: avisa e não bloqueia", () => {
    rmSync(path.join(root, "prova", "x.ts"));
    const r = rodarHook(root, bench({ LOHRA_STOP_PROVA_CMD: "false" }));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/nenhum prova/u);
  });

  it("tsc vermelho: exit 2 antes de qualquer prova", () => {
    const r = rodarHook(root, bench({ LOHRA_STOP_TSC_CMD: "false" }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/tsc/u);
    expect(r.stderr).not.toMatch(/reprovou/u);
  });

  it("prova verde: exit 0", () => {
    expect(rodarHook(root, bench()).status).toBe(0);
  });

  it("sem LOHRA_BENCH, nenhuma seam LOHRA_STOP_* é lida", () => {
    // Se a seam fosse honrada, TSC_CMD=false daria exit 2. Sem bench, o hook procura
    // o tsc real (ausente no diretório temporário → avisa e segue) e a branch real
    // (não é repositório git → fora do padrão) e sai 0.
    const r = rodarHook(root, {
      LOHRA_STOP_TSC_CMD: "false",
      LOHRA_STOP_BRANCH: "feat/1-x",
      LOHRA_STOP_PROVA_CMD: "false",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/reprovou/u);
  });

  it("reentrância: LOHRA_STOP_GATE_ACTIVE=1 sem bench sai 0 sem rodar nada", () => {
    const r = rodarHook(root, { LOHRA_STOP_GATE_ACTIVE: "1", LOHRA_STOP_TSC_CMD: "false" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/reentrante/u);
  });

  it("reentrância: com bench a marca é ignorada e a seam decide", () => {
    const r = rodarHook(
      root,
      bench({ LOHRA_STOP_GATE_ACTIVE: "1", LOHRA_STOP_PROVA_CMD: "false" }),
    );
    expect(r.status).toBe(2);
  });

  it("hermeticidade: o filho da prova vê só LOHRA_STOP_GATE_ACTIVE, nenhuma outra LOHRA_STOP_*", () => {
    const envFile = path.join(root, "env.txt");
    const r = rodarHook(root, bench({ LOHRA_STOP_PROVA_CMD: `env > "${envFile}"` }));
    expect(r.status).toBe(0);
    const vistas = readFileSync(envFile, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("LOHRA_STOP_"))
      .sort();
    expect(vistas).toEqual(["LOHRA_STOP_GATE_ACTIVE=1"]);
  });
});
