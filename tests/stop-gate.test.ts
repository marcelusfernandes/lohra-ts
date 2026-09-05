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

function rodarHook(
  root: string,
  env: Record<string, string>,
  payload: Record<string, unknown> = {},
): HookRun {
  const r = spawnSync("sh", [HOOK], {
    input: JSON.stringify({ hook_event_name: "Stop", cwd: root, ...payload }),
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

  it("payload ilegível: avisa e segue (não é silêncio)", () => {
    const r = spawnSync("sh", [HOOK], {
      input: "{nope",
      encoding: "utf8",
      env: { ...limparAmbiente(), ...bench({ LOHRA_STOP_BRANCH: "main" }) },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/payload ilegível/u);
  });

  it("reentrância: com bench a marca é ignorada e a seam decide", () => {
    const r = rodarHook(
      root,
      bench({ LOHRA_STOP_GATE_ACTIVE: "1", LOHRA_STOP_PROVA_CMD: "false" }),
    );
    expect(r.status).toBe(2);
  });

  it("hermeticidade: o filho da prova vê só LOHRA_STOP_GATE_ACTIVE — nem outra LOHRA_STOP_*, nem LOHRA_BENCH", () => {
    const envFile = path.join(root, "env.txt");
    const r = rodarHook(root, bench({ LOHRA_STOP_PROVA_CMD: `env > "${envFile}"` }));
    expect(r.status).toBe(0);
    const vistas = readFileSync(envFile, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("LOHRA_STOP_") || l.startsWith("LOHRA_BENCH="))
      .sort();
    expect(vistas).toEqual(["LOHRA_STOP_GATE_ACTIVE=1"]);
  });
  describe("teto de bloqueios (stop_hook_active, issue #61)", () => {
    const contador = (): string => path.join(root, ".prova", ".stop-gate-bloqueios");

    it("primeiro bloqueio: exit 2 e contador = 1", () => {
      const r = rodarHook(root, bench({ LOHRA_STOP_PROVA_CMD: "false" }));
      expect(r.status).toBe(2);
      expect(readFileSync(contador(), "utf8").trim()).toBe("1");
    });

    it("segundo bloqueio consecutivo (stop_hook_active): exit 2 e contador = 2", () => {
      mkdirSync(path.join(root, ".prova"), { recursive: true });
      writeFileSync(contador(), "1\n");
      const r = rodarHook(root, bench({ LOHRA_STOP_PROVA_CMD: "false" }), {
        stop_hook_active: true,
      });
      expect(r.status).toBe(2);
      expect(readFileSync(contador(), "utf8").trim()).toBe("2");
    });

    it("terceiro bloqueio consecutivo: libera o turno com aviso de teto e zera o contador", () => {
      mkdirSync(path.join(root, ".prova"), { recursive: true });
      writeFileSync(contador(), "2\n");
      const r = rodarHook(root, bench({ LOHRA_STOP_PROVA_CMD: "false" }), {
        stop_hook_active: true,
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/teto/u);
      expect(existsSync(contador())).toBe(false);
    });

    it("prova verde zera o contador", () => {
      mkdirSync(path.join(root, ".prova"), { recursive: true });
      writeFileSync(contador(), "2\n");
      expect(rodarHook(root, bench()).status).toBe(0);
      expect(existsSync(contador())).toBe(false);
    });

    it("sem stop_hook_active o contador reinicia (bloqueio de um turno novo)", () => {
      mkdirSync(path.join(root, ".prova"), { recursive: true });
      writeFileSync(contador(), "2\n");
      const r = rodarHook(root, bench({ LOHRA_STOP_PROVA_CMD: "false" }));
      expect(r.status).toBe(2);
      expect(readFileSync(contador(), "utf8").trim()).toBe("1");
    });
  });
});
