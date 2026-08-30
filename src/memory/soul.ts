import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadSoul(home: string): string | undefined {
  try {
    const value = readFileSync(join(home, "SOUL.md"), "utf8").trim();
    return value.length === 0 ? undefined : value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
