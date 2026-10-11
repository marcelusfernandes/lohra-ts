import { spawnSync } from "node:child_process";

import { declaredUnitsText } from "./native.js";

export interface NativeRoute {
  readonly proof: string;
  readonly units: readonly string[];
  readonly sources: readonly string[];
}

export type NativeRoutes = Readonly<Record<string, NativeRoute>>;

const MANIFEST = "scripts/ci/controle-negativo/native-routes.json";
const MANAGED = ["scripts/subprocess/windows-helper/native/", "tests/fixtures/windows-helper/"];
const SHA = /^[0-9a-f]{40}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH = /^[A-Za-z0-9_./-]+$/;
const MAX_OUTPUT = 16 * 1024 * 1024;

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
}

function git(root: string, args: readonly string[]): Buffer {
  const result = spawnSync("git", [...args], { cwd: root, maxBuffer: MAX_OUTPUT });
  if (result.error || result.signal !== null || result.status !== 0) {
    throw new Error(
      `NATIVE_ROUTES_GIT: git ${args[0] ?? "unknown"}: ${(result.error?.message ?? result.stderr.toString("utf8").trim()) || String(result.signal ?? result.status)}`,
    );
  }
  return result.stdout;
}

function tree(root: string, sha: string): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const record of git(root, ["ls-tree", "-rz", "--full-tree", sha])
    .toString("utf8")
    .split("\0")) {
    if (!record) continue;
    const match = /^(\d{6}) (\w+) [0-9a-f]+\t(.+)$/.exec(record);
    if (!match || !match[1] || !match[2] || !match[3])
      throw new Error("NATIVE_ROUTES_TREE_INVALID");
    entries.set(match[3], { mode: match[1], type: match[2] });
  }
  return entries;
}

function regular(entries: ReadonlyMap<string, TreeEntry>, path: string): void {
  const entry = entries.get(path);
  if (!entry) throw new Error(`NATIVE_ROUTES_MISSING: ${path}`);
  if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
    throw new Error(`NATIVE_ROUTES_NOT_REGULAR: ${path} mode=${entry.mode}`);
  }
}

function path(value: unknown, kind: string): string {
  if (
    typeof value !== "string" ||
    !PATH.test(value) ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`NATIVE_ROUTES_PATH: ${kind}=${String(value)}`);
  }
  return value;
}

function strings(value: unknown, kind: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`NATIVE_ROUTES_${kind}_INVALID`);
  const entries: string[] = value.map((item: unknown) => path(item, kind));
  if (new Set(entries).size !== entries.length) throw new Error(`NATIVE_ROUTES_DUPLICATE: ${kind}`);
  return entries;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("NATIVE_ROUTES_MANIFEST_INVALID");
  return value as Record<string, unknown>;
}

/** Valida uma única árvore Git, sem executar suas provas. */
export function validateNativeRoutes(root: string, sha: string): NativeRoutes {
  if (!SHA.test(sha)) throw new Error(`NATIVE_ROUTES_SHA_INVALID: ${sha}`);
  const entries = tree(root, sha);
  const managed = [...entries.keys()].filter(
    (name) => name.endsWith(".cs") && MANAGED.some((prefix) => name.startsWith(prefix)),
  );
  if (!entries.has(MANIFEST)) {
    if (managed.length > 0)
      throw new Error(`NATIVE_ROUTES_MANIFEST_MISSING: ${managed[0] ?? "unknown"}`);
    return {};
  }
  regular(entries, MANIFEST);
  let raw: Record<string, unknown>;
  try {
    raw = record(JSON.parse(git(root, ["show", `${sha}:${MANIFEST}`]).toString("utf8")) as unknown);
  } catch (cause) {
    throw new Error("NATIVE_ROUTES_MANIFEST_INVALID", { cause });
  }
  if (Object.keys(raw).length !== 1 || !Object.hasOwn(raw, "routes")) {
    throw new Error("NATIVE_ROUTES_MANIFEST_INVALID");
  }
  const routes = record(raw.routes);
  const output: Record<string, NativeRoute> = {};
  const used = new Set<string>();
  const declaredSources = new Set<string>();
  for (const slug of Object.keys(routes).sort()) {
    if (!SLUG.test(slug)) throw new Error(`NATIVE_ROUTES_SLUG_INVALID: ${slug}`);
    const candidate = record(routes[slug]);
    if ([...Object.keys(candidate)].sort().join(",") !== "proof,sources,units") {
      throw new Error(`NATIVE_ROUTES_MANIFEST_INVALID: ${slug}`);
    }
    const proof = path(candidate.proof, "proof");
    if (proof !== `prova/${slug}.ts`) throw new Error(`NATIVE_ROUTES_PROOF_PATH: ${slug}`);
    const units = strings(candidate.units, "UNITS");
    const sources = strings(candidate.sources, "SOURCES");
    for (const item of [proof, ...units, ...sources]) {
      if (used.has(item)) throw new Error(`NATIVE_ROUTES_DUPLICATE: ${item}`);
      used.add(item);
      regular(entries, item);
    }
    for (const item of units) {
      if (!/^tests\/[\w./-]+\.test\.ts$/.test(item))
        throw new Error(`NATIVE_ROUTES_PATH: unit=${item}`);
    }
    for (const item of sources) {
      if (!item.endsWith(".cs") || !MANAGED.some((prefix) => item.startsWith(prefix))) {
        throw new Error(`NATIVE_ROUTES_PATH: source=${item}`);
      }
      declaredSources.add(item);
    }
    let declared: readonly string[];
    try {
      declared = declaredUnitsText(git(root, ["show", `${sha}:${proof}`]).toString("utf8"));
    } catch (cause) {
      throw new Error(`NATIVE_ROUTES_PROOF_INVALID: ${proof}`, { cause });
    }
    if (declared.length !== units.length || declared.some((item) => !units.includes(item))) {
      throw new Error(`NATIVE_ROUTES_UNITS_MISMATCH: ${proof}`);
    }
    output[slug] = { proof, units: [...units].sort(), sources: [...sources].sort() };
  }
  for (const item of managed) {
    if (!declaredSources.has(item)) throw new Error(`NATIVE_ROUTES_UNDECLARED: ${item}`);
  }
  return output;
}
