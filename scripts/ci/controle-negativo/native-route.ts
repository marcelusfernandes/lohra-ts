import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateNativeRoutes, type NativeRoute, type NativeRoutes } from "./native-routes.js";

export interface NativeRouteSelection {
  readonly mode: "standard" | "native-negative" | "native-positive";
  readonly os: "ubuntu" | "windows";
  readonly basePayload: string;
  readonly head: string;
  readonly mergeBase: string;
  readonly slug?: string;
  readonly sources?: readonly string[];
}

const SHA = /^[0-9a-f]{40}$/;
const MANIFEST = "scripts/ci/controle-negativo/native-routes.json";
const PRODUCTION = "scripts/subprocess/windows-helper/native/";
const DRIVER = "tests/fixtures/windows-helper/";
const MAX_OUTPUT = 16 * 1024 * 1024;

function git(root: string, args: readonly string[]): Buffer {
  const result = spawnSync("git", [...args], {
    cwd: root,
    maxBuffer: MAX_OUTPUT,
    timeout: 15_000,
  });
  if (result.error || result.signal !== null || result.status !== 0) {
    const stderr = (result.stderr as Buffer | undefined)?.toString("utf8").trim() ?? "";
    throw new Error(
      `NATIVE_ROUTE_GIT: git ${args[0] ?? "unknown"}: ${result.error?.message ?? (stderr || String(result.signal ?? result.status))}`,
    );
  }
  return result.stdout;
}

function uniqueMergeBase(root: string, basePayload: string, head: string): string {
  const bases = git(root, ["merge-base", "--all", basePayload, head])
    .toString("utf8")
    .trim()
    .split(/\s+/);
  if (bases.length !== 1 || !bases[0] || !SHA.test(bases[0]))
    throw new Error("NATIVE_ROUTE_MERGE_BASE_AMBIGUOUS");
  const mergeBase = bases[0];
  for (const sha of [basePayload, head]) {
    git(root, ["merge-base", "--is-ancestor", mergeBase, sha]);
  }
  return mergeBase;
}

interface Change {
  readonly status: "A" | "M" | "D" | "T";
  readonly path: string;
}

function changes(root: string, mergeBase: string, head: string): readonly Change[] {
  const raw = git(root, ["diff", "--no-renames", "--name-status", "-z", mergeBase, head]);
  const parts = raw.toString("utf8").split("\0");
  if (parts.pop() !== "") throw new Error("NATIVE_ROUTE_DIFF_INVALID: terminator");
  if (parts.length % 2 !== 0) throw new Error("NATIVE_ROUTE_DIFF_INVALID: fields");
  const output: Change[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index];
    const path = parts[index + 1];
    if (!status || !/^[AMDT]$/.test(status) || !path)
      throw new Error(`NATIVE_ROUTE_DIFF_INVALID: ${String(status)} ${String(path)}`);
    output.push({ status: status as Change["status"], path });
  }
  return output;
}

function owner(routes: NativeRoutes, path: string): string | undefined {
  return Object.entries(routes).find(
    ([, route]) =>
      route.proof === path || route.units.includes(path) || route.sources.includes(path),
  )?.[0];
}

function sameSources(left: NativeRoute, right: NativeRoute): boolean {
  return (
    left.sources.length === right.sources.length &&
    left.sources.every((path) => right.sources.includes(path))
  );
}

/** Classifica o diff da branch, nunca o checkout sintético integrado. */
export function selectNativeRoute(
  root: string,
  basePayload: string,
  head: string,
): NativeRouteSelection {
  if (!SHA.test(basePayload) || !SHA.test(head))
    throw new Error("NATIVE_ROUTE_SHA_INVALID: BASE_PAYLOAD/HEAD");
  const mergeBase = uniqueMergeBase(root, basePayload, head);
  const before = validateNativeRoutes(root, mergeBase);
  const after = validateNativeRoutes(root, head);
  const diff = changes(root, mergeBase, head);
  const touched = new Set<string>();
  let productionChanged = false;
  let manifestChanged = false;

  for (const [slug] of Object.entries(before)) {
    if (!after[slug]) throw new Error(`NATIVE_ROUTE_REMOVED: ${slug}`);
  }
  for (const change of diff) {
    if (change.path === MANIFEST) {
      if (change.status === "D") throw new Error("NATIVE_ROUTE_MANIFEST_REMOVED");
      manifestChanged = true;
      continue;
    }
    const slug = owner(before, change.path) ?? owner(after, change.path);
    const managedCs =
      change.path.endsWith(".cs") &&
      (change.path.startsWith(PRODUCTION) || change.path.startsWith(DRIVER));
    if (managedCs && !slug) throw new Error(`NATIVE_ROUTE_SOURCE_UNKNOWN: ${change.path}`);
    if (!slug) continue;
    if (change.status === "D" || change.status === "T")
      throw new Error(`NATIVE_ROUTE_PATH_REMOVED: ${change.path}`);
    touched.add(slug);
    if (change.path.startsWith(PRODUCTION)) productionChanged = true;
  }
  if (manifestChanged) {
    for (const [candidateSlug, current] of Object.entries(after)) {
      const previous = before[candidateSlug];
      if (!previous || !sameSources(previous, current)) touched.add(candidateSlug);
    }
  }

  // Fan-out futuro precisa de uma issue própria e limite explícito; não escolher por ordem.
  if (touched.size > 1) throw new Error(`NATIVE_ROUTE_MULTIPLE: ${[...touched].join(",")}`);
  const slug = [...touched][0];
  if (!slug) {
    if (manifestChanged) {
      const slugs = Object.keys(after);
      if (slugs.length !== 1 || !slugs[0]) throw new Error("NATIVE_ROUTE_MANIFEST_AMBIGUOUS");
      const candidate = after[slugs[0]];
      const previous = before[slugs[0]];
      if (!candidate || !previous)
        throw new Error(`NATIVE_ROUTE_ADDED_WITHOUT_PRODUCTION: ${slugs[0]}`);
      if (!sameSources(previous, candidate))
        throw new Error(`NATIVE_ROUTE_SOURCES_MANIFEST_ONLY: ${slugs[0]}`);
      return {
        mode: "native-positive",
        os: "windows",
        basePayload,
        head,
        mergeBase,
        slug: slugs[0],
        sources: [...candidate.sources],
      };
    }
    return { mode: "standard", os: "ubuntu", basePayload, head, mergeBase };
  }
  const current = after[slug];
  if (!current) throw new Error(`NATIVE_ROUTE_REMOVED: ${slug}`);
  const previous = before[slug];
  if (previous && !sameSources(previous, current)) {
    const changedSources = diff.some(
      (change) => current.sources.includes(change.path) && change.status === "A",
    );
    if (!changedSources) throw new Error(`NATIVE_ROUTE_SOURCES_MANIFEST_ONLY: ${slug}`);
    if (!productionChanged) throw new Error(`NATIVE_ROUTE_SOURCES_POSITIVE: ${slug}`);
  }
  if (!previous && !productionChanged)
    throw new Error(`NATIVE_ROUTE_ADDED_WITHOUT_PRODUCTION: ${slug}`);
  return {
    mode: productionChanged ? "native-negative" : "native-positive",
    os: "windows",
    basePayload,
    head,
    mergeBase,
    slug,
    sources: [...current.sources],
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [, , root, basePayload, head] = process.argv;
    if (!root || !basePayload || !head || process.argv.length !== 5)
      throw new Error("NATIVE_ROUTE_USAGE: <root> <BASE_PAYLOAD> <HEAD>");
    process.stdout.write(JSON.stringify(selectNativeRoute(root, basePayload, head)) + "\n");
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
