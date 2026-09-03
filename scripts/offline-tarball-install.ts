import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

interface LockEntry {
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

interface PackageLock {
  readonly packages: Readonly<Record<string, LockEntry>>;
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly bin?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
}

function resolveDependency(
  packages: Readonly<Record<string, LockEntry>>,
  parent: string,
  name: string,
): string | undefined {
  let base = parent;
  while (base.length > 0) {
    const nested = `${base}/node_modules/${name}`;
    if (packages[nested] !== undefined) return nested;
    const separator = base.lastIndexOf("/node_modules/");
    if (separator < 0) break;
    base = base.slice(0, separator);
  }
  const root = `node_modules/${name}`;
  return packages[root] === undefined ? undefined : root;
}

export function prepareOfflineTarballConsumer(options: {
  readonly project: string;
  readonly consumer: string;
  readonly tarball: string;
}): void {
  const project = resolve(options.project);
  const consumer = resolve(options.consumer);
  const tarball = resolve(options.tarball);
  const source = JSON.parse(
    readFileSync(resolve(project, "package-lock.json"), "utf8"),
  ) as PackageLock;
  const manifest = JSON.parse(
    readFileSync(resolve(project, "package.json"), "utf8"),
  ) as PackageManifest;
  const dependencies = manifest.dependencies ?? {};
  const selected = new Set<string>();
  const queue = Object.keys(dependencies).map((name) => `node_modules/${name}`);

  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined || selected.has(path)) continue;
    const entry = source.packages[path];
    if (entry === undefined) throw new Error(`OFFLINE_LOCK_ENTRY_MISSING:${path}`);
    selected.add(path);
    for (const name of [
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
    ]) {
      const dependency = resolveDependency(source.packages, path, name);
      if (dependency !== undefined) queue.push(dependency);
    }
  }

  const packageSpec = `file:${relative(consumer, tarball)}`;
  const packageName = manifest.name;
  const packages: Record<string, LockEntry> = {
    "": {
      name: "lohra-offline-consumer",
      version: "0.0.0",
      dependencies: { [packageName]: packageSpec },
    },
    [`node_modules/${packageName}`]: {
      name: packageName,
      version: manifest.version,
      resolved: packageSpec,
      integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
      hasInstallScript: true,
      dependencies,
      ...(manifest.bin === undefined ? {} : { bin: manifest.bin }),
      ...(manifest.engines === undefined ? {} : { engines: manifest.engines }),
    },
  };
  for (const path of [...selected].sort()) packages[path] = source.packages[path] as LockEntry;

  writeFileSync(
    resolve(consumer, "package.json"),
    `${JSON.stringify({
      name: "lohra-offline-consumer",
      version: "0.0.0",
      private: true,
      dependencies: { [packageName]: packageSpec },
    })}\n`,
  );
  writeFileSync(
    resolve(consumer, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "lohra-offline-consumer",
        version: "0.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: Object.fromEntries(
          Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)),
        ),
      },
      null,
      2,
    )}\n`,
  );
}
