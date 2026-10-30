import type * as fs from "node:fs";

export type ManagedInstallStatus = "installed" | "updated" | "removed" | "noop";
export interface ManagedInstallResult {
  readonly status: ManagedInstallStatus;
  readonly directory: string;
  readonly preservedExtras: readonly string[];
}
export class ManagedInstallError extends Error {
  constructor(
    readonly code: "conflict" | "unsafe-path" | "busy" | "io" | "partial",
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}
export interface ManagedInstallOperations {
  readonly fs: typeof fs;
  readonly readKit: () => string;
}
export function manageSkillInstallation(
  _request: { readonly action: "add" | "remove"; readonly skillsDirectory: string },
  _operations: Partial<ManagedInstallOperations> = {},
): ManagedInstallResult {
  throw new Error("not implemented: manageSkillInstallation");
}
