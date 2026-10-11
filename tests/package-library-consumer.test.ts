import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { assertConsumerLibraryEntry, assertConsumerLibraryTypes } from "../scripts/pack-check.js";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function installedFixture(): { consumer: string; installed: string } {
  root = mkdtempSync(join(tmpdir(), "lohra-library-consumer-"));
  const installed = join(root, "node_modules", "lohra-ts");
  mkdirSync(join(installed, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"library-consumer","type":"module"}');
  writeFileSync(
    join(installed, "package.json"),
    '{"name":"lohra-ts","type":"module","main":"dist/index.js","types":"dist/index.d.ts"}',
  );
  writeFileSync(join(installed, "dist", "index.js"), 'export const marker = "ready";\n');
  writeFileSync(
    join(installed, "dist", "index.d.ts"),
    'export declare const marker: string; export type { PublicMarker } from "./marker.js";\n',
  );
  writeFileSync(join(installed, "dist", "marker.d.ts"), "export type PublicMarker = string;\n");
  return { consumer: root, installed };
}

function fixtureSource(): string {
  return 'import { marker, type PublicMarker } from "lohra-ts"; const value: PublicMarker = marker; void value;\n';
}

it("accepts installed main/types and compiles their transitive declaration", () => {
  const { consumer } = installedFixture();
  expect(() => {
    assertConsumerLibraryEntry(consumer);
  }).not.toThrow();
  expect(() => {
    assertConsumerLibraryTypes(consumer, fixtureSource());
  }).not.toThrow();
}, 20_000);

it("detects a missing installed JS entry rather than accepting a package manifest alone", () => {
  const { consumer, installed } = installedFixture();
  rmSync(join(installed, "dist", "index.js"));
  expect(() => {
    assertConsumerLibraryEntry(consumer);
  }).toThrow(/PACK_LIBRARY_MAIN_MISSING/u);
});

it("detects a missing installed declaration", () => {
  const { consumer, installed } = installedFixture();
  rmSync(join(installed, "dist", "index.d.ts"));
  expect(() => {
    assertConsumerLibraryEntry(consumer);
  }).toThrow(/PACK_LIBRARY_TYPES_MISSING/u);
});

it("fails when a transitive declaration is absent even though main and types exist", () => {
  const { consumer, installed } = installedFixture();
  rmSync(join(installed, "dist", "marker.d.ts"));
  expect(() => {
    assertConsumerLibraryTypes(consumer, fixtureSource());
  }).toThrow(/PACK_LIBRARY_TYPES_FAILED/u);
}, 20_000);
