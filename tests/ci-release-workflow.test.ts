// Workflow `.github/workflows/release.yml` (D7/#536, épico #529): tag `v*`
// → publica no npm com provenance (OIDC, trusted publisher — sem token no
// repo) e cria a GitHub Release com o tarball. Pina a forma do YAML, como
// `tests/ci-pack-check-job.test.ts` faz para o `pack-check`.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RELEASE = fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url));

// Arquivo ausente → "" : as asserções falham por conteúdo (vermelho de
// asserção para o controle negativo, não estrutural).
const yaml = existsSync(RELEASE) ? readFileSync(RELEASE, "utf8") : "";

describe("release.yml — publicação por tag com provenance (D7/#536)", () => {
  it("dispara em push de tag v* e em workflow_dispatch com a tag a publicar", () => {
    expect(yaml).toMatch(/^on:\n {2}push:\n {4}tags: \["v\*"\]/mu);
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).toMatch(/inputs:\n {6}tag:\n {8}description:/u);
    expect(yaml).toContain("required: true");
    expect(yaml).not.toContain("pull_request");
  });

  it("pede id-token: write (OIDC) e contents: write (Release), nada além", () => {
    expect(yaml).toMatch(/^permissions:\n {2}contents: write\n {2}id-token: write\n/mu);
    expect(yaml).not.toContain("NODE_AUTH_TOKEN");
    expect(yaml).not.toContain("secrets.");
  });

  it("verifica que a tag está em main e bate com package.json#version antes de tudo", () => {
    const guarda = yaml.indexOf("merge-base --is-ancestor HEAD origin/main");
    const versao = yaml.indexOf("require('./package.json').version");
    const install = yaml.indexOf("run: npm ci");
    expect(guarda).toBeGreaterThan(-1);
    expect(versao).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(guarda);
    expect(install).toBeGreaterThan(versao);
    // No dispatch, GITHUB_SHA é o SHA do workflow (main), não o da tag.
    // O conteúdo empacotado é o HEAD do checkout, que tem de ser a tag.
    expect(yaml).toContain('git rev-parse "refs/tags/${RELEASE_TAG}^{}"');
    expect(yaml).not.toContain('merge-base --is-ancestor "$GITHUB_SHA"');
  });

  it("pina npm 11.21.2 antes do pack:check e faz checkout da tag", () => {
    // npm 12 (o `npm@latest` do run 42035117059, 12.2.2) emite
    // `npm pack --json` como objeto `{ "<nome>": { filename } }`.
    // scripts/pack-check.ts lê `[0].filename` e lança PACK_TARBALL_MISSING.
    // A linha 11 ainda emite o array e já faz trusted publishing (>= 11.5.1).
    const pin = yaml.indexOf("run: npm install -g npm@11.21.2 && npm --version");
    const pack = yaml.indexOf("run: npm run pack:check");
    expect(pin).toBeGreaterThan(-1);
    expect(pack).toBeGreaterThan(pin);
    expect(yaml).not.toContain("npm@latest");
    expect(yaml).toContain("ref: ${{ steps.release_tag.outputs.name }}");
    expect(yaml).toContain('gh release create "$RELEASE_TAG"');
    expect(yaml).not.toContain('gh release create "$GITHUB_REF_NAME"');
  });

  it("npm ci → build → pack:check → npm publish --provenance --access public → gh release create, nessa ordem", () => {
    const install = yaml.indexOf("run: npm ci");
    const build = yaml.indexOf("run: npm run build");
    const pack = yaml.indexOf("run: npm run pack:check");
    const publish = yaml.indexOf("npm publish --provenance --access public");
    const release = yaml.indexOf("gh release create");
    expect(install).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(install);
    expect(pack).toBeGreaterThan(build);
    expect(publish).toBeGreaterThan(pack);
    expect(release).toBeGreaterThan(publish);
  });

  it("publica com o prepare desligado e anexa o .tgz à Release", () => {
    expect(yaml).toContain('LOHRA_SKIP_PREPARE: "1"');
    expect(yaml).toMatch(/gh release create[^\n]*\.tgz/u);
    expect(yaml).toMatch(/timeout-minutes: \d+/u);
  });
});
