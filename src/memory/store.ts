import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const ENTRY_DELIMITER = "\n§\n";
export const MEMORY_CHAR_LIMIT = 2200;
export const USER_CHAR_LIMIT = 1375;

export class MemoryMutationError extends Error {}
export class MemoryLimitExceeded extends MemoryMutationError {}
export class EntryNotFound extends MemoryMutationError {}
export class AmbiguousEntry extends MemoryMutationError {}

export function parseMemory(content: string): string[] {
  return content
    .split(/\n*§\n*/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function renderMemory(entries: readonly string[]): string {
  return entries.join(ENTRY_DELIMITER);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function uniqueTemporary(path: string): string {
  return join(dirname(path), `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`);
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = uniqueTemporary(path);
  let descriptor: number | undefined;
  let cleanupError: unknown;
  try {
    descriptor = openSync(temporary, "wx", 0o666);
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") cleanupError = error;
    }
  }
  if (cleanupError !== undefined) {
    throw new Error("memory temporary cleanup failed", { cause: cleanupError });
  }
}

export class MemoryFile {
  readonly path: string;
  readonly charLimit: number;

  constructor(path: string, charLimit: number) {
    this.path = path;
    this.charLimit = charLimit;
  }

  private read(): string {
    try {
      return readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  entries(): string[] {
    return parseMemory(this.read());
  }

  render(): string {
    return renderMemory(this.entries());
  }

  add(text: string): void {
    const normalized = text.trim();
    if (normalized.length === 0) return;
    const entries = parseMemory(this.read());
    if (!entries.includes(normalized)) entries.push(normalized);
    this.write(entries);
  }

  replace(oldText: string, newText: string): void {
    const entries = parseMemory(this.read());
    entries[this.findUnique(entries, oldText)] = newText.trim();
    this.write(entries);
  }

  remove(oldText: string): void {
    const entries = parseMemory(this.read());
    entries.splice(this.findUnique(entries, oldText), 1);
    this.write(entries);
  }

  private findUnique(entries: readonly string[], substring: string): number {
    const matches = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.includes(substring));
    if (matches.length === 0) throw new EntryNotFound(`no memory entry contains '${substring}'`);
    if (matches.length > 1) {
      throw new AmbiguousEntry(
        `${String(matches.length)} entries contain '${substring}'; be more specific`,
      );
    }
    return matches[0]?.index ?? 0;
  }

  private write(entries: readonly string[]): void {
    const content = renderMemory(entries);
    const length = codePointLength(content);
    if (length > this.charLimit) {
      throw new MemoryLimitExceeded(
        `memory would be ${String(length)} chars, over the ${String(this.charLimit)} budget`,
      );
    }
    atomicWrite(this.path, content);
  }
}

export interface MemorySnapshot {
  readonly memory: string;
  readonly user: string;
}

export class MemoryStore {
  readonly memory: MemoryFile;
  readonly user: MemoryFile;
  private loaded?: MemorySnapshot;

  constructor(home: string) {
    const memories = join(home, "memories");
    this.memory = new MemoryFile(join(memories, "MEMORY.md"), MEMORY_CHAR_LIMIT);
    this.user = new MemoryFile(join(memories, "USER.md"), USER_CHAR_LIMIT);
  }

  fileFor(target: string): MemoryFile {
    return target === "user" ? this.user : this.memory;
  }

  loadSnapshot(): void {
    this.loaded = Object.freeze({ memory: this.memory.render(), user: this.user.render() });
  }

  snapshot(): MemorySnapshot {
    if (this.loaded === undefined) this.loadSnapshot();
    const value = this.loaded;
    if (value === undefined) throw new Error("memory snapshot was not initialized");
    return Object.freeze({ ...value });
  }
}
