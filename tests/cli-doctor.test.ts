import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { enable, setPreference, writeTokens } from "../src/auth/index.js";
import { runCli } from "../src/cli.js";
import { CODEX_PROVIDER } from "../src/providers/index.js";
import { NativeChatHttpPort } from "../src/transports/index.js";

const temporaryDirectories: string[] = [];

function environment(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "lohra-cli-test-"));
  temporaryDirectories.push(home);
  return { HOME: home, PATH: "/usr/bin:/bin", COLUMNS: "80" };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("lohra CLI bootstrap", () => {
  it("keeps version and no-command Unicode contracts distinct", async () => {
    const version: string[] = [];
    expect(
      await runCli(["--version"], {
        environment: environment(),
        stdout: (v) => version.push(v),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(version.join("")).toBe("lohra 0.0.11\n");

    const hint: string[] = [];
    expect(
      await runCli([], {
        environment: environment(),
        stdout: (v) => hint.push(v),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(hint.join("")).toBe("lohra 0.0.11 — see `lohra --help`\n");
  });

  it("emits invalid Unicode profile as UTF-8-direct JSON and raw UTF-8 stderr (issue #71)", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await runCli(["doctor", "--profile", "café", "--json"], {
        environment: environment(),
        stdout: (v) => stdout.push(v),
        stderr: (v) => stderr.push(v),
      }),
    ).toBe(2);
    // docs/adr/0003-native-wire-format.md item 2: no more \uXXXX escaping in
    // JSON output -- stdout carries the same literal UTF-8 as stderr now.
    expect(stdout.join("")).not.toContain("caf\\u00e9");
    expect(stdout.join("")).toContain("café");
    expect(stderr.join("")).toContain("café");
  });

  it("emits a compact, UTF-8-direct doctor payload without writing (issue #71)", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const env = environment();
    expect(
      await runCli(["doctor", "--json"], {
        environment: env,
        stdout: (v) => stdout.push(v),
        stderr: (v) => stderr.push(v),
        probeOllama: () => Promise.resolve(false),
      }),
    ).toBe(2);
    expect(stdout.join("")).toMatch(/^\{"checks":\[/);
    expect(stdout.join("")).not.toContain("\\u2014");
    expect(stdout.join("")).toContain("—");
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      environment: { interactive: false, stderr_tty: false, stdin_tty: false },
      exit_code: 2,
      ok: false,
    });
    expect(stderr).toEqual([]);
  });

  it("distinguishes a live Ollama with models from a live empty daemon", async () => {
    const withModels: string[] = [];
    const empty: string[] = [];
    const env = environment();
    expect(
      await runCli(["doctor", "--json"], {
        environment: env,
        stdout: (value) => withModels.push(value),
        stderr: () => undefined,
        probeOllama: () =>
          Promise.resolve({
            alive: true,
            detail: "",
            models: ["stub-coder:1b"],
            url: "http://localhost:11434/api/tags",
          }),
      }),
    ).toBe(0);
    expect(
      await runCli(["doctor", "--json"], {
        environment: env,
        stdout: (value) => empty.push(value),
        stderr: () => undefined,
        probeOllama: () =>
          Promise.resolve({
            alive: true,
            detail: "",
            models: [],
            url: "http://localhost:11434/api/tags",
          }),
      }),
    ).toBe(2);
    expect(JSON.parse(withModels.join(""))).toMatchObject({
      environment: { ollama: { alive: true, models: ["stub-coder:1b"] }, usable: true },
      exit_code: 0,
      ok: true,
    });
    expect(JSON.parse(empty.join(""))).toMatchObject({
      environment: { ollama: { alive: true, models: [] }, usable: true },
      exit_code: 2,
      ok: false,
    });
  });

  it("advertises all 13 behavioral help subcommands", async () => {
    const stdout: string[] = [];
    expect(
      await runCli(["--help"], {
        environment: environment(),
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
      }),
    ).toBe(0);

    for (const command of [
      "init",
      "doctor",
      "chat",
      "dashboard",
      "serve",
      "cron",
      "workflow",
      "models",
      "tiers",
      "profile",
      "auth",
      "skill",
      "update",
    ]) {
      expect(stdout.join("")).toContain(command);
    }
  });

  it("update is wired and exposes its no-side-effect help boundary", async () => {
    const stdout: string[] = [];
    expect(
      await runCli(["update", "--help"], {
        environment: environment(),
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(stdout.join("")).toContain("--check");
    expect(stdout.join("")).toContain("--reinstall");
  });

  it("requires a read-only workflow action", async () => {
    const stderr: string[] = [];
    expect(
      await runCli(["workflow"], {
        environment: environment(),
        stdout: () => undefined,
        stderr: (value) => stderr.push(value),
      }),
    ).toBe(2);
    expect(stderr.join("")).toContain("missing required argument: workflow_cmd");
  });

  it("chat --help lists its options with a description, exit 0", async () => {
    const stdout: string[] = [];
    expect(
      await runCli(["chat", "--help"], {
        environment: environment(),
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
      }),
    ).toBe(0);
    const output = stdout.join("");
    expect(output).toContain("usage: lohra chat [options]");
    expect(output).toMatch(/^\s+--model\s+\S/mu);
    expect(output).toMatch(/^\s+--provider\s+\S/mu);
  });

  it("tiers --help lists its sub-actions with a description, exit 0", async () => {
    const stdout: string[] = [];
    expect(
      await runCli(["tiers", "--help"], {
        environment: environment(),
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
      }),
    ).toBe(0);
    const output = stdout.join("");
    expect(output).toContain("usage: lohra tiers [options]");
    expect(output).toMatch(/^\s+list\s+\S/mu);
    expect(output).toMatch(/^\s+suggest\s+\S/mu);
  });

  it("dashboard is wired (T12) -- exits 2 with the same no-provider boundary as chat when unconfigured, not the stub message", async () => {
    const stderr: string[] = [];
    const code = await runCli(["dashboard"], {
      environment: environment(),
      stdout: () => undefined,
      stderr: (value) => stderr.push(value),
    });
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("no provider configured — there are three ways in:");
    expect(stderr.join("")).not.toContain("not implemented in the TypeScript bootstrap");
  });

  it("cron now takes the real command boundary, not the stub -- documents the T18 change", async () => {
    const stderr: string[] = [];
    const code = await runCli(["cron"], {
      environment: environment(),
      stdout: () => undefined,
      stderr: (value) => stderr.push(value),
    });
    expect(code).toBe(2);
    expect(stderr.join("")).not.toContain("not implemented in the TypeScript bootstrap");
    // `cron` with no action at all is the "required argument missing" class
    // (byte-exact: "missing required argument: action"), a DIFFERENT error
    // class from "invalid value" -- an explicitly-provided-but-wrong value
    // (e.g. `cron frobnicate`) is what produces "invalid value", exercised
    // separately in tests/commands-cron.test.ts and the T18 cli-bilateral harness.
    expect(stderr.join("")).toContain("missing required argument: action");
  });
});

describe("doctor × chat contract (issue #604): 'usable' significa a mesma coisa nos dois", () => {
  function closeServer(server: Server): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      server.close((error) => {
        if (error === undefined) resolvePromise();
        else reject(error);
      });
    });
  }

  it("home com chave fictícia e stub local: doctor usable:true, chat sem --provider completa", async () => {
    // `anthropic` is one of `doctor`'s own known providers
    // (`src/doctor/providers.ts`'s table, not the registry) -- unlike a
    // freshly `registerProvider`-ed name, it is what `checks.ts`'s
    // `environment.providers.find(...)` can actually match, so `doctor`'s
    // own pass/fail check (not just `usable`) agrees too. Redirected to the
    // local stub via `LOHRA_PROVIDER_BASE_URL`, same seam `chat.ts:239` and
    // `dashboard.ts:240` already read.
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = JSON.stringify({
          id: "msg_t604_doctor",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
        });
        response.end(text);
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const env = {
        ...environment(),
        ANTHROPIC_API_KEY: "sk-t604-fake",
        LOHRA_PROVIDER_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
      };

      const doctorStdout: string[] = [];
      const doctorCode = await runCli(["doctor", "--json"], {
        environment: env,
        stdout: (value) => doctorStdout.push(value),
        stderr: () => undefined,
        probeOllama: () => Promise.resolve(false),
      });
      expect(doctorCode).toBe(0);
      const doctorReport = JSON.parse(doctorStdout.join("")) as {
        environment: { usable: boolean; detected_provider: string | null };
      };
      expect(doctorReport.environment.usable).toBe(true);
      expect(doctorReport.environment.detected_provider).toBe("anthropic");

      const chatStdout: string[] = [];
      const chatCode = await runCli(["chat", "--json", "--no-input", "--no-tools", "oi"], {
        environment: env,
        stdout: (value) => chatStdout.push(value),
        stderr: () => undefined,
      });
      const envelope = JSON.parse(chatStdout.join("")) as {
        error: string | null;
        api_calls: number;
        completed: boolean;
      };
      expect(chatCode).toBe(0);
      expect(envelope.error).toBeNull();
      expect(envelope.api_calls).toBeGreaterThanOrEqual(1);
      expect(envelope.completed).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("home vazio: os dois concordam -- doctor usable:false, chat cai na fronteira de sempre", async () => {
    const env = environment();

    const doctorStdout: string[] = [];
    const doctorCode = await runCli(["doctor", "--json"], {
      environment: env,
      stdout: (value) => doctorStdout.push(value),
      stderr: () => undefined,
      probeOllama: () => Promise.resolve(false),
    });
    expect(doctorCode).toBe(2);
    const doctorReport = JSON.parse(doctorStdout.join("")) as {
      environment: { usable: boolean; detected_provider: string | null };
    };
    expect(doctorReport.environment.usable).toBe(false);
    expect(doctorReport.environment.detected_provider).toBeNull();

    const chatStdout: string[] = [];
    const chatCode = await runCli(["chat", "--json", "--no-input", "oi"], {
      environment: env,
      stdout: (value) => chatStdout.push(value),
      stderr: () => undefined,
    });
    expect(chatCode).toBe(2);
    const envelope = JSON.parse(chatStdout.join("")) as { error: string | null };
    expect(envelope.error).toBe(
      "no provider configured — run `lohra init` (or `lohra doctor`); details on stderr",
    );
  });
});

describe("doctor × chat, só Ollama vivo (issue #631): usable diz sim, chat cai na fronteira", () => {
  function closeServer(server: Server): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      server.close((error) => {
        if (error === undefined) resolvePromise();
        else reject(error);
      });
    });
  }

  const aliveOllama = {
    alive: true,
    detail: "",
    models: ["stub-coder:1b"],
    url: "http://localhost:11434/api/tags",
  };

  it("doctor --json: usable true, detected_provider null, chat_default_provider null (asserção cruzada com chat)", async () => {
    const env = environment();

    const doctorStdout: string[] = [];
    const doctorCode = await runCli(["doctor", "--json"], {
      environment: env,
      stdout: (value) => doctorStdout.push(value),
      stderr: () => undefined,
      probeOllama: () => Promise.resolve(aliveOllama),
    });
    expect(doctorCode).toBe(0);
    const doctorReport = JSON.parse(doctorStdout.join("")) as {
      environment: {
        usable: boolean;
        detected_provider: string | null;
        chat_default_provider: string | null;
      };
    };
    expect(doctorReport.environment.usable).toBe(true);
    expect(doctorReport.environment.detected_provider).toBeNull();
    expect(doctorReport.environment.chat_default_provider).toBeNull();

    // Mesma home, mesmo ambiente: o que `chat` sem `--provider` de fato faz
    // -- a asserção cruzada que prova que `chat_default_provider: null`
    // significa exatamente "chat vai cair na fronteira", não uma promessa
    // que o `chat` não cumpre.
    const chatStdout: string[] = [];
    const chatCode = await runCli(["chat", "--json", "--no-input", "oi"], {
      environment: env,
      stdout: (value) => chatStdout.push(value),
      stderr: () => undefined,
    });
    expect(chatCode).toBe(2);
    const envelope = JSON.parse(chatStdout.join("")) as { error: string | null };
    expect(envelope.error).toBe(
      "no provider configured — run `lohra init` (or `lohra doctor`); details on stderr",
    );
  });

  it("doctor (texto): instrui --provider ollama / LOHRA_PROVIDER=ollama quando usable só vem do Ollama", async () => {
    const stdout: string[] = [];
    const code = await runCli(["doctor"], {
      environment: environment(),
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      probeOllama: () => Promise.resolve(aliveOllama),
    });
    expect(code).toBe(0);
    const report = stdout.join("");
    expect(report).toContain("--provider ollama");
    expect(report).toContain("LOHRA_PROVIDER=ollama");
  });

  it("home com chave: chat_default_provider concorda com detected_provider, e chat sem --provider não faz nenhuma requisição ao Ollama", async () => {
    const chatServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = JSON.stringify({
          id: "msg_t631_doctor",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
        });
        response.end(text);
      });
    });
    let ollamaCalls = 0;
    const ollamaServer = createServer((_request, response) => {
      ollamaCalls += 1;
      response.writeHead(500);
      response.end("t631: chat with an API key must never probe Ollama");
    });
    await new Promise<void>((resolvePromise) => chatServer.listen(0, "127.0.0.1", resolvePromise));
    await new Promise<void>((resolvePromise) =>
      ollamaServer.listen(0, "127.0.0.1", resolvePromise),
    );
    const originalConnect = process.env.LOHRA_OLLAMA_CONNECT_URL;
    try {
      const chatAddress = chatServer.address();
      const ollamaAddress = ollamaServer.address();
      if (
        chatAddress === null ||
        typeof chatAddress === "string" ||
        ollamaAddress === null ||
        typeof ollamaAddress === "string"
      )
        throw new Error("missing test port");
      process.env.LOHRA_OLLAMA_CONNECT_URL = `http://127.0.0.1:${String(ollamaAddress.port)}/api/tags`;
      const env = {
        ...environment(),
        ANTHROPIC_API_KEY: "sk-t631-fake",
        LOHRA_PROVIDER_BASE_URL: `http://127.0.0.1:${String(chatAddress.port)}`,
      };

      const doctorStdout: string[] = [];
      // `probeOllama: false` isolates the doctor call itself from
      // `ollamaCalls` -- doctor is SUPPOSED to probe Ollama (that is its
      // job); the counter below exists to catch `chat`, which is not.
      const doctorCode = await runCli(["doctor", "--json"], {
        environment: env,
        stdout: (value) => doctorStdout.push(value),
        stderr: () => undefined,
        probeOllama: () => Promise.resolve(false),
      });
      expect(doctorCode).toBe(0);
      const doctorReport = JSON.parse(doctorStdout.join("")) as {
        environment: { detected_provider: string | null; chat_default_provider: string | null };
      };
      expect(doctorReport.environment.detected_provider).toBe("anthropic");
      expect(doctorReport.environment.chat_default_provider).toBe("anthropic");
      expect(ollamaCalls).toBe(0);

      // `chat` never calls `probeOllamaDown` (`detectChatProvider` only
      // resolves against environment variables) -- `LOHRA_OLLAMA_CONNECT_URL`
      // still points at the stub above, so any future probe added to the
      // api_key/no-`--provider` path would move `ollamaCalls`.
      const chatStdout: string[] = [];
      const chatCode = await runCli(["chat", "--json", "--no-input", "--no-tools", "oi"], {
        environment: env,
        stdout: (value) => chatStdout.push(value),
        stderr: () => undefined,
      });
      expect(chatCode).toBe(0);
      const envelope = JSON.parse(chatStdout.join("")) as { error: string | null };
      expect(envelope.error).toBeNull();
      expect(ollamaCalls).toBe(0);
    } finally {
      if (originalConnect === undefined) delete process.env.LOHRA_OLLAMA_CONNECT_URL;
      else process.env.LOHRA_OLLAMA_CONNECT_URL = originalConnect;
      await closeServer(chatServer);
      await closeServer(ollamaServer);
    }
  });
});

describe("doctor × chat, chat_default_provider respeita a rota (issue #633)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assinatura ativa + chave no .env: chat_default_provider é o provedor que chat realmente usa nessa rota", async () => {
    const base = mkdtempSync(join(tmpdir(), "lohra-cli-test-t633-"));
    temporaryDirectories.push(base);
    const env: Record<string, string> = { HOME: base, PATH: "/usr/bin:/bin", COLUMNS: "80" };
    const home = join(base, ".lohra");
    enable(home);
    writeTokens(home, {
      accessToken: "fresh-access-t633",
      refreshToken: "fresh-refresh-t633",
      accountId: "acct-t633",
      expiresAt: Date.now() / 1000 + 999_999, // far from expiring: no refresh POST
    });
    // "chave no .env": presente mas irrelevante -- a rota subscription tem
    // precedência sobre qualquer chave de API (chat.ts:184-238 nunca chama
    // `detectChatProvider` nesse ramo).
    const envWithKey = { ...env, ANTHROPIC_API_KEY: "sk-t633-fake" };

    // A rota subscription fala com chatgpt.com por um client Node https
    // direto (não o `LOHRA_PROVIDER_BASE_URL` que a rota api_key aceita) --
    // interceptar o `NativeChatHttpPort` é o único jeito de manter isso
    // fora da rede real (mesma técnica de
    // tests/chat-subscription-provider-flag.test.ts).
    const postSpy = vi
      .spyOn(NativeChatHttpPort.prototype, "post")
      .mockRejectedValue(new Error("t633: no real network call in tests"));

    const chatStdout: string[] = [];
    const chatCode = await runCli(["chat", "--json", "--no-input", "--no-tools", "oi"], {
      environment: envWithKey,
      stdout: (value) => chatStdout.push(value),
      stderr: () => undefined,
    });
    // A prova de que `chat` de fato tentou a rota subscription (Codex),
    // e não a chave do `.env`: o client Responses foi acionado.
    expect(postSpy).toHaveBeenCalled();
    expect(chatCode).not.toBe(0);

    const doctorStdout: string[] = [];
    const doctorCode = await runCli(["doctor", "--json"], {
      environment: envWithKey,
      stdout: (value) => doctorStdout.push(value),
      stderr: () => undefined,
      probeOllama: () => Promise.resolve(false),
    });
    expect(doctorCode).toBe(0);
    const doctorReport = JSON.parse(doctorStdout.join("")) as {
      environment: { auth_route: string; chat_default_provider: string | null };
    };
    expect(doctorReport.environment.auth_route).toBe("subscription");
    // `CODEX_PROVIDER.name` ("openai-codex") é o mesmo nome que
    // `chat.ts:230` (`profile = CODEX_PROVIDER`) usa para essa chamada --
    // não "anthropic", mesmo com a chave presente no ambiente.
    expect(doctorReport.environment.chat_default_provider).toBe(CODEX_PROVIDER.name);
  });

  it("route.error (preferência subscription inativa): chat_default_provider é null e o warn ollama-sem-chave não emite", async () => {
    const base = mkdtempSync(join(tmpdir(), "lohra-cli-test-t633-"));
    temporaryDirectories.push(base);
    const env: Record<string, string> = { HOME: base, PATH: "/usr/bin:/bin", COLUMNS: "80" };
    const home = join(base, ".lohra");
    // `preference=subscription` sem `enable()`: subscriptionActive fica
    // false (authMode continua "api_key"), então `routeFor` devolve
    // `{ mode: "api_key", error: PREFER_SUB_ERROR }` (credentials.ts:157) --
    // a mesma rota que `chat.ts:157-158` recusa antes de chamar
    // `detectChatProvider`. Uma chave de API está presente de propósito: é
    // o que discrimina o bug -- antes desta issue, `chat_default_provider`
    // vinha de `detectChatProvider` incondicionalmente e reportaria
    // `"anthropic"` aqui, mesmo `chat` nunca chegando perto dela nesse
    // ramo (a chave só importaria na rota `api_key` sem erro).
    setPreference(home, "subscription");
    const envWithKey = { ...env, ANTHROPIC_API_KEY: "sk-t633-route-error" };

    const doctorStdout: string[] = [];
    const doctorCode = await runCli(["doctor", "--json"], {
      environment: envWithKey,
      stdout: (value) => doctorStdout.push(value),
      stderr: () => undefined,
      // Ollama vivo (com modelo) para provar que o warn não emite mesmo
      // quando as outras duas condições da issue #631 valeriam.
      probeOllama: () =>
        Promise.resolve({
          alive: true,
          detail: "",
          models: ["stub-coder:1b"],
          url: "http://localhost:11434/api/tags",
        }),
    });
    const doctorReport = JSON.parse(doctorStdout.join("")) as {
      environment: { auth_route: string; chat_default_provider: string | null };
      checks: readonly { name: string }[];
    };
    expect(doctorCode).toBe(2);
    expect(doctorReport.environment.auth_route).toBe("unusable");
    expect(doctorReport.environment.chat_default_provider).toBeNull();
    expect(doctorReport.checks.find((check) => check.name === "ollama-sem-chave")).toBeUndefined();
  });
});
