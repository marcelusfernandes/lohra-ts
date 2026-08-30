import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { toolError, toolResult } from "./envelope.js";
import type { ToolArguments } from "./types.js";

const MAX_READ_CODE_POINTS = 100_000;

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error ? String(error.code) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

export function readFileTool(args: ToolArguments): string {
  const path = args.path;
  if (!path) return toolError("missing required argument 'path'");
  const renderedPath = renderArgument(path);
  let content: string;
  try {
    const bytes = readFileSync(renderedPath);
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return toolError(`file not found: ${renderedPath}`);
    if (code === "EISDIR") return toolError(`path is a directory: ${renderedPath}`);
    if (error instanceof TypeError && /encoded data/iu.test(error.message)) {
      return toolError(`file is not valid UTF-8 text: ${renderedPath}`);
    }
    return toolError(`could not read ${renderedPath}: ${errorMessage(error)}`);
  }
  const codePoints = Array.from(content);
  const truncated = codePoints.length > MAX_READ_CODE_POINTS;
  return toolResult(codePoints.slice(0, MAX_READ_CODE_POINTS).join(""), {
    truncated,
    path: renderedPath,
  });
}

export function writeFileTool(args: ToolArguments): string {
  const path = args.path;
  const content = args.content;
  if (!path) return toolError("missing required argument 'path'");
  if (content === undefined || content === null) {
    return toolError("missing required argument 'content'");
  }
  if (typeof content !== "string") return toolError("'content' must be a string");
  const renderedPath = renderArgument(path);
  try {
    mkdirSync(dirname(renderedPath), { recursive: true });
    writeFileSync(renderedPath, content, "utf8");
  } catch (error) {
    return toolError(`could not write ${renderedPath}: ${errorMessage(error)}`);
  }
  return toolResult(undefined, {
    bytes_written: Buffer.byteLength(content, "utf8"),
    path: renderedPath,
  });
}

export const READ_FILE_SCHEMA = {
  description: "Read a UTF-8 text file from the local filesystem.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Path to the file" } },
    required: ["path"],
  },
} as const;

export const WRITE_FILE_SCHEMA = {
  description: "Write a UTF-8 text file (creating parent directories).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file" },
      content: { type: "string", description: "Full file contents to write" },
    },
    required: ["path", "content"],
  },
} as const;
