#!/usr/bin/env node
// scripts/release.ts — `npm run release -- <patch|minor|major|x.y.z>` (issue #531/D2).
//
// STUB (commit `test(red):`): as assinaturas e os tipos já são os finais;
// os corpos lançam "not implemented" para o vermelho ser de runtime (uma
// asserção real de `tests/release-script.test.ts`, não um erro estrutural
// de import) — convenção `worktree-segura` §7.
export type BumpKind = "patch" | "minor" | "major";

export type ParsedVersionArg =
  | { readonly kind: "bump"; readonly bump: BumpKind }
  | { readonly kind: "explicit"; readonly version: string };

export interface MergedPr {
  readonly number: string | null;
  readonly title: string;
}

export interface RunReleaseOptions {
  readonly cwd: string;
  readonly arg: string | undefined;
  readonly now?: Date;
}

export interface RunReleaseResult {
  readonly version: string;
  readonly previousVersion: string;
  readonly changelogSection: string;
}

export function parseVersionArg(_arg: string | undefined): ParsedVersionArg {
  throw new Error("not implemented: parseVersionArg");
}

export function computeNextVersion(_currentVersion: string, _parsed: ParsedVersionArg): string {
  throw new Error("not implemented: computeNextVersion");
}

export function isTreeClean(_cwd: string): boolean {
  throw new Error("not implemented: isTreeClean");
}

export function currentBranch(_cwd: string): string {
  throw new Error("not implemented: currentBranch");
}

export function validateReleaseBranch(_branch: string, _targetVersion: string): void {
  throw new Error("not implemented: validateReleaseBranch");
}

export function lastReleaseTag(_cwd: string): string | null {
  throw new Error("not implemented: lastReleaseTag");
}

export function mergesSince(_cwd: string, _sinceTag: string | null): readonly MergedPr[] {
  throw new Error("not implemented: mergesSince");
}

export function buildChangelogSection(
  _version: string,
  _prs: readonly MergedPr[],
  _dateIso: string,
): string {
  throw new Error("not implemented: buildChangelogSection");
}

export function insertChangelogSection(_existing: string, _section: string): string {
  throw new Error("not implemented: insertChangelogSection");
}

export function bumpLockVersion(
  _lock: Record<string, unknown>,
  _version: string,
): Record<string, unknown> {
  throw new Error("not implemented: bumpLockVersion");
}

export function runRelease(_options: RunReleaseOptions): RunReleaseResult {
  throw new Error("not implemented: runRelease");
}
