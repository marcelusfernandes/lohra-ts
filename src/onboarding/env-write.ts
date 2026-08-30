import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { parseEnvText } from "../config/env-file.js";

const needsQuotes = [" ", "\t", "#", "'", '"'] as const;

export interface EnvWriteOperations {
  readonly writeText: (path: string, body: string) => void;
  readonly chmod600: (path: string) => void;
  readonly replace: (source: string, destination: string) => void;
}

const operations: EnvWriteOperations = {
  writeText: (path, body) => {
    writeFileSync(path, body, { encoding: "utf8", mode: 0o666 });
  },
  chmod600: (path) => {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Python treats chmod as best effort on exotic filesystems and Windows.
    }
  },
  replace: (source, destination) => {
    renameSync(source, destination);
  },
};

export function formatValue(value: string): string {
  if (
    value.length > 0 &&
    !needsQuotes.some((character) => value.includes(character)) &&
    value === value.trim()
  ) {
    return value;
  }
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return value;
}

function lineKey(raw: string): string | undefined {
  let line = raw.trim();
  if (line.length === 0 || line.startsWith("#") || !line.includes("=")) return undefined;
  if (line.startsWith("export ")) line = line.slice("export ".length);
  const key = line.slice(0, line.indexOf("=")).trim();
  return key || undefined;
}

function render(text: string, updates: Readonly<Record<string, string>>): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  const sourceLines = text.split(/\r?\n/u);
  if (sourceLines.at(-1) === "") sourceLines.pop();
  for (const raw of sourceLines) {
    const key = lineKey(raw);
    if (key === undefined || !(key in updates)) {
      lines.push(raw);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${key}=${formatValue(updates[key] ?? "")}`);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) lines.push(`${key}=${formatValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function upsertEnvFile(
  path: string,
  updates: Readonly<Record<string, string>>,
  ops: EnvWriteOperations = operations,
): string[] {
  const text = read(path);
  const current = parseEnvText(text);
  const changed = Object.fromEntries(
    Object.entries(updates).filter(([key, value]) => current[key] !== value),
  );
  const keys = Object.keys(changed);
  if (keys.length === 0) return [];
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    ops.writeText(temporary, render(text, changed));
    ops.chmod600(temporary);
    ops.replace(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The successful rename removes the temporary path.
    }
  }
  ops.chmod600(path);
  return keys;
}
