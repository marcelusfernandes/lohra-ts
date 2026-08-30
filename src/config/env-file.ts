import { readFileSync, statSync } from "node:fs";

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    trimmed[0] === trimmed.at(-1) &&
    (trimmed[0] === "'" || trimmed[0] === '"')
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseEnvText(text: string): Readonly<Record<string, string>> {
  const pairs: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || !line.includes("=")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length);
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    if (key.length > 0) pairs[key] = unquote(line.slice(separator + 1));
  }
  return pairs;
}

export function readEnvFile(path: string): Readonly<Record<string, string>> {
  try {
    if (!statSync(path).isFile()) return {};
    return parseEnvText(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function applyEnvFile(path: string, environment: Record<string, string>): readonly string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(readEnvFile(path))) {
    if (!(key in environment)) {
      environment[key] = value;
      applied.push(key);
    }
  }
  return applied;
}
