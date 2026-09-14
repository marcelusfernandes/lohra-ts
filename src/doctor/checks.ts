import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { readEnvFile } from "../config/env-file.js";
import { JsonFloat } from "../serialization/json-numbers.js";
import type { Check, DoctorEnvironment } from "./model.js";

const maxBytes = 256_000;

function formatLocalTime(epochSeconds: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochSeconds * 1000));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

function readBounded(path: string): string | null {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > maxBytes) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function jsonCheck(
  name: string,
  path: string,
  absent: string,
  summarize: (value: unknown) => string,
  absentRemedy = "",
): Check {
  const text = readBounded(path);
  if (text === null)
    return { name, state: "ok", detail: `${path} — ${absent}`, remedy: absentRemedy };
  try {
    return {
      name,
      state: "ok",
      detail: `${path} — ${summarize(JSON.parse(text) as unknown)}`,
      remedy: "",
    };
  } catch {
    return {
      name,
      state: "warn",
      detail: `${path} — invalid JSON`,
      remedy: `inspect it with a JSON validator, e.g. jq . ${path}`,
    };
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function countNamed(value: unknown, key: string, noun: string): string {
  const nested = object(value)?.[key];
  const target = nested ?? value;
  const count = Array.isArray(target)
    ? target.length
    : object(target) === null
      ? null
      : Object.keys(object(target) as Record<string, unknown>).length;
  return count === null ? "valid JSON" : `${String(count)} ${noun}`;
}

/**
 * Issue #633: a única definição de "Ollama pronto" deste arquivo. Antes,
 * `providerCheck` (abaixo) exigia `alive && models.length > 0` para tratar
 * Ollama como um provedor utilizável, enquanto o Check `ollama-sem-chave`
 * só olhava `alive` — um Ollama no ar sem nenhum modelo puxado acionava
 * `provider: fail` (a leitura forte, correta) e, ao mesmo tempo, um `warn`
 * recomendando `lohra chat --provider ollama` (a leitura fraca), comando
 * que falharia nesse mesmo estado por falta de modelo. As duas leituras
 * agora vêm desta função.
 */
export function isOllamaReady(ollama: DoctorEnvironment["ollama"]): boolean {
  return ollama.alive && ollama.models.length > 0;
}

export function runChecks(environment: DoctorEnvironment): readonly Check[] {
  const provider = environment.providers.find(
    (entry) => entry.provider === environment.detected_provider,
  );
  const ollamaReady = isOllamaReady(environment.ollama);
  const envKeys = Object.keys(readEnvFile(environment.env_file)).sort();
  const foundHarnesses = environment.harnesses.filter(
    (entry) => entry.installed === true || entry.home_present === true,
  );
  const workflowPolicy = join(environment.home, "workflow_policy.json");
  const subscriptionPath = join(environment.home, "auth.json");
  const providerCheck: Check =
    environment.auth_route === "unusable"
      ? {
          name: "provider",
          state: "fail",
          detail: `preference=${environment.auth_preference} but subscription mode is not usable`,
          remedy: "lohra auth login   # or take the key path: lohra auth prefer auto",
        }
      : environment.auth_route === "subscription"
        ? environment.lohra_oauth_present || environment.codex_auth_present
          ? {
              name: "provider",
              state: "ok",
              detail: "OpenAI/Codex subscription (opt-in, ToS-gray)",
              remedy: "",
            }
          : {
              name: "provider",
              state: "fail",
              detail: "subscription mode is enabled but there is no login to use",
              remedy: "lohra auth login   # or reuse the Codex CLI login: codex login",
            }
        : provider === undefined && !ollamaReady
          ? {
              name: "provider",
              state: "fail",
              detail: "none configured — no API key, no subscription, no local daemon",
              remedy:
                "lohra init   # or: export ANTHROPIC_API_KEY=... | lohra auth enable | ollama serve",
            }
          : provider === undefined
            ? {
                name: "provider",
                state: "ok",
                detail: `ollama (from keyless: ${environment.ollama.url}), model ${environment.ollama.models[0] as string}`,
                remedy: "",
              }
            : {
                name: "provider",
                state: "ok",
                detail: `${provider.provider} (from api-key: ${provider.present_vars[0] as string})`,
                remedy: "",
              };
  // Issue #631: `usable` conta `ollama.alive` (snapshot.ts:120-123) mesmo
  // quando `chat_default_provider` é `null` -- na rota `api_key`, sem chave
  // nem `LOHRA_PROVIDER`, `chat`/`dashboard` sem `--provider` ainda caem na
  // fronteira "no provider configured" (`chat-boundary.ts`), que já lista o
  // `--provider ollama` como opção 3 mas só quando o operador chega lá. Este
  // Check adianta a mesma instrução no relatório do `doctor`, no lugar exato
  // onde `providerCheck` (acima) já imprime "ollama (from keyless: ...)" —
  // um "ok" que, sozinho, sugere que basta rodar `ollama serve`.
  //
  // Issue #633: a condição usa `ollamaReady` (a mesma função de
  // `providerCheck` acima), não só `environment.ollama.alive` -- com Ollama
  // no ar mas nenhum modelo puxado, `ollamaReady` é `false` e este Check não
  // emite: recomendar `--provider ollama` nesse estado seria um remédio que
  // falha (sem modelo), e `providerCheck` já reporta `fail` por conta
  // própria, sem precisar de um segundo aviso.
  const ollamaKeylessGap: Check | null =
    environment.auth_route === "api_key" &&
    ollamaReady &&
    environment.chat_default_provider === null
      ? {
          name: "ollama-sem-chave",
          state: "warn",
          detail:
            "usable é true só pelo Ollama (keyless) -- chat/dashboard sem --provider ainda caem em 'no provider configured'",
          remedy: "lohra chat --provider ollama   # ou: export LOHRA_PROVIDER=ollama",
        }
      : null;
  const subscriptionCheck: Check = environment.subscription_active
    ? environment.auth_preference === "api_key"
      ? {
          name: "subscription",
          state: "ok",
          detail:
            "active, but preference=api_key — API keys are used (back: lohra auth prefer auto)",
          remedy: "",
        }
      : {
          name: "subscription",
          state: "ok",
          detail: `active (OpenAI/Codex) — ${subscriptionPath}`,
          remedy: "",
        }
    : {
        name: "subscription",
        state: "ok",
        detail: "off — API keys are used (enable: lohra auth enable)",
        remedy: "",
      };
  const loginCheck: Check = environment.lohra_oauth_present
    ? {
        name: "login",
        state: "ok",
        detail: `own OAuth token valid until ${formatLocalTime(environment.lohra_oauth_expires_at instanceof JsonFloat ? environment.lohra_oauth_expires_at.value : (environment.lohra_oauth_expires_at as number), environment.timezone)}`,
        remedy: "",
      }
    : {
        name: "login",
        state: "ok",
        detail: "no own login (subscription mode only: lohra auth login)",
        remedy: "",
      };
  const profileCheck: Check = environment.subscription_divergence
    ? {
        name: "profile",
        state: "warn",
        detail: `${environment.active_profile as string} has no subscription of its own — it bills a paid API key`,
        remedy: `lohra auth enable --profile ${environment.active_profile as string}`,
      }
    : {
        name: "profile",
        state: "ok",
        detail:
          environment.active_profile === null
            ? `none — shared home ${environment.base}`
            : `${environment.active_profile} — ${environment.home}`,
        remedy: "",
      };
  const policyText = readBounded(workflowPolicy);
  let policy: Check;
  if (policyText === null) {
    policy = {
      name: "workflow_policy.json",
      state: "warn",
      detail: `${workflowPolicy} not found — workflow leaves run deny-by-default (no fs, no egress)`,
      remedy: `printf '{"fs_allow": ["%s"], "egress_allow": []}\\n' "$PWD" > ${workflowPolicy}`,
    };
  } else {
    try {
      const parsed = object(JSON.parse(policyText) as unknown);
      const fsCount = Array.isArray(parsed?.fs_allow) ? parsed.fs_allow.length : 0;
      const egressCount = Array.isArray(parsed?.egress_allow) ? parsed.egress_allow.length : 0;
      policy = {
        name: "workflow_policy.json",
        state: "ok",
        detail: `${workflowPolicy} — ${String(fsCount)} fs path(s), ${String(egressCount)} egress host(s)`,
        remedy: "",
      };
    } catch {
      policy = {
        name: "workflow_policy.json",
        state: "warn",
        detail: `${workflowPolicy} — invalid JSON`,
        remedy: `inspect it with a JSON validator, e.g. jq . ${workflowPolicy}`,
      };
    }
  }

  return [
    providerCheck,
    ...(ollamaKeylessGap === null ? [] : [ollamaKeylessGap]),
    subscriptionCheck,
    loginCheck,
    profileCheck,
    {
      name: ".env",
      state: "ok",
      detail: environment.env_file_present
        ? `${environment.env_file} — ${String(envKeys.length)} key(s): ${envKeys.join(", ") || "none"}`
        : `${environment.env_file} — not found; keys may come from the shell`,
      remedy: "",
    },
    jsonCheck(
      "mcp.json",
      join(environment.home, "mcp.json"),
      "not configured (no MCP servers)",
      (value) => countNamed(value, "mcpServers", "server(s)"),
    ),
    jsonCheck(
      "cron/jobs.json",
      join(environment.home, "cron", "jobs.json"),
      "not configured (no jobs)",
      (value) => countNamed(value, "jobs", "job(s)"),
    ),
    policy,
    jsonCheck(
      "workflow_tiers.json",
      join(environment.home, "workflow_tiers.json"),
      "not configured (a node's own model decides)",
      (value) => countNamed(value, "tiers", "tier(s)"),
      "lohra tiers suggest",
    ),
    environment.ollama.alive
      ? {
          name: "ollama",
          state: "ok",
          detail: `running at ${environment.ollama.url} — ${String(environment.ollama.models.length)} model(s): ${environment.ollama.models.join(", ") || "none pulled"}`,
          remedy: "",
        }
      : {
          name: "ollama",
          state: "ok",
          detail: `not running (${environment.ollama.url})`,
          remedy: "ollama serve   # keyless local models; no API key needed",
        },
    foundHarnesses.length === 0
      ? {
          name: "harnesses",
          state: "ok",
          detail: "none found (claude / codex not on PATH)",
          remedy: "",
        }
      : {
          name: "harnesses",
          state: "ok",
          detail: foundHarnesses.map((entry) => String(entry.name)).join(", "),
          remedy: `lohra skill export use-lohra --to ${String(foundHarnesses[0]?.home)}/skills   # let it drive Lohra`,
        },
  ];
}

export function renderChecks(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((check) => check.name.length));
  const lines = ["Lohra doctor", ""];
  for (const check of checks) {
    lines.push(`[${check.state.padEnd(4)}] ${check.name.padEnd(width)}  ${check.detail}`);
    if (check.remedy.length > 0) lines.push(`${" ".repeat(width + 9)}→ ${check.remedy}`);
  }
  const ok = checks.filter((check) => check.state === "ok").length;
  const warn = checks.filter((check) => check.state === "warn").length;
  const fail = checks.filter((check) => check.state === "fail").length;
  lines.push(
    "",
    `${String(ok)} ok, ${String(warn)} warn, ${String(fail)} fail — ${fail > 0 ? "nothing can answer yet; fix the fail line(s) above." : "Lohra can answer."}`,
  );
  return `${lines.join("\n")}\n`;
}
