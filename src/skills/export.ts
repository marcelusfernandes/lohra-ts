import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../assets/skills", import.meta.url));

export function listExportable(): string[] {
  return existsSync(join(root, "use-lohra", "SKILL.md")) ? ["use-lohra"] : [];
}

export function readExportable(name: string): string {
  const path = join(root, name, "SKILL.md");
  if (!existsSync(path)) {
    throw new Error(`no exportable skill '${name}' — available: ['use-lohra']`);
  }
  return readFileSync(path, "utf8");
}

export function writeExportable(name: string, destination: string): string {
  const body = readExportable(name);
  const path = join(destination, name, "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
  return path;
}
