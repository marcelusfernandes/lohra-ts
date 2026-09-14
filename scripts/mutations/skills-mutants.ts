// Catálogo de mutação da fatia `skills` (issue #681, follow-up das QAs de
// 992edb74/c26486b7 e das PRs #675 (#677)/#679 (#678), que mudaram
// `src/skills/store.ts` sem nenhuma fatia de mutação cobrindo o diretório —
// mesmo molde de #636 para `src/doctor/**`). Mecânica A (`harness.ts`), mesmo
// molde de `doctor-mutants.ts`: cada mutante morre por um teste focado já
// existente ou acrescentado em `tests/skills.test.ts`, `tests/skill-export.test.ts`
// ou `tests/skills-builtin-contract.test.ts` (`tests/**` não está no `Files`
// desta issue além dos três citados; só são citados como oráculo, nunca
// editados fora deles).
import type { Mutant } from "./types.js";

const store = "src/skills/store.ts";
const exportModule = "src/skills/export.ts";

const skillsFocus = "tests/skills.test.ts";
const skillExportFocus = "tests/skill-export.test.ts";
const skillsBuiltinContractFocus = "tests/skills-builtin-contract.test.ts";

export const skillsMutants: readonly Mutant[] = [
  {
    id: "SK1-collect-swallow-error",
    category: "collect-swallow-error",
    mechanism: "family-a",
    focus: {
      file: skillsFocus,
      test: "warns collectSkillFiles's own path and code on a readdirSync failure other than ENOENT, then keeps scanning (#678)",
    },
    edits: [
      {
        file: store,
        before:
          '    } catch (error) {\n      const code = (error as NodeJS.ErrnoException).code;\n      if (code !== "ENOENT") {\n        warn(`collectSkillFiles: ${directory} unreadable (${code ?? "unknown error"})`);\n      }\n      return;\n    }',
        after: "    } catch {\n      return;\n    }",
      },
    ],
  },
  {
    id: "SK2-collect-warns-on-enoent",
    category: "collect-warns-on-enoent",
    mechanism: "family-a",
    focus: {
      file: skillsFocus,
      test: "does not warn on ENOENT — a skill root that hasn't been created yet is tolerated",
    },
    edits: [
      {
        file: store,
        before: '      if (code !== "ENOENT") {',
        after: "      if (true) {",
      },
    ],
  },
  {
    id: "SK3-collect-warn-drops-code",
    category: "collect-warn-drops-code",
    mechanism: "family-a",
    focus: {
      file: skillsFocus,
      test: "warns collectSkillFiles's own path and code on a readdirSync failure other than ENOENT, then keeps scanning (#678)",
    },
    edits: [
      {
        file: store,
        before:
          '        warn(`collectSkillFiles: ${directory} unreadable (${code ?? "unknown error"})`);',
        after: "        warn(`collectSkillFiles: ${directory} unreadable`);",
      },
    ],
  },
  {
    id: "SK4-real-or-resolved-skips-realpath",
    category: "real-or-resolved-skips-realpath",
    mechanism: "family-a",
    focus: {
      file: skillsFocus,
      test: "realOrResolved follows a symlink to its real target, not just resolve() of the literal path",
    },
    edits: [
      {
        file: store,
        before: "      return join(realpathSync(current), ...suffix);",
        after: "      return join(resolve(current), ...suffix);",
      },
    ],
  },
  {
    id: "SK5-parse-skill-md-name-optional",
    category: "parse-skill-md-name-optional",
    mechanism: "family-a",
    focus: {
      file: skillsFocus,
      test: "parseSkillMd rejects frontmatter missing a name",
    },
    edits: [
      {
        file: store,
        before:
          '  const name = meta.get("name");\n  if (name === undefined || name.length === 0) {\n    throw new SkillFormatError("SKILL.md frontmatter must define a \'name\'");\n  }\n  return Object.freeze({\n    name,',
        after: '  const name = meta.get("name") ?? "";\n  return Object.freeze({\n    name,',
      },
    ],
  },
  {
    id: "SK6-unquote-swallows-invalid-scalar",
    category: "unquote-swallows-invalid-scalar",
    mechanism: "family-a",
    focus: {
      file: skillsFocus,
      test: "unquote rejects an invalid double-quoted scalar instead of swallowing it",
    },
    edits: [
      {
        file: store,
        before:
          '    try {\n      return JSON.parse(trimmed) as string;\n    } catch {\n      throw new SkillFormatError("invalid SKILL.md frontmatter: invalid quoted scalar");\n    }',
        after:
          "    try {\n      return JSON.parse(trimmed) as string;\n    } catch {\n      return trimmed;\n    }",
      },
    ],
  },
  {
    id: "SK7-within-prefix-without-separator",
    category: "within-prefix-without-separator",
    mechanism: "family-a",
    focus: {
      file: skillsFocus,
      test: "within closes the boundary at a directory separator, not a bare string prefix",
    },
    edits: [
      {
        file: store,
        before:
          '  const value = relative(resolvedRoot, resolvedPath);\n  return value === "" || (!value.startsWith("..") && !isAbsolute(value));',
        after: "  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot);",
      },
    ],
  },
  {
    id: "SK8-store-root-precedence-home-first",
    category: "store-root-precedence-home-first",
    mechanism: "family-a",
    focus: {
      file: skillsFocus,
      test: "uses project > home > builtin precedence and renders the literal index",
    },
    edits: [
      {
        file: store,
        before: "    this.roots = [...projectRoots, this.root, ...builtinRoots];",
        after: "    this.roots = [this.root, ...projectRoots, ...builtinRoots];",
      },
    ],
  },
  {
    id: "SK9-update-builtin-write-bypasses-copy",
    category: "update-builtin-write-bypasses-copy",
    mechanism: "family-a",
    focus: {
      file: skillsFocus,
      test: "updates project in-place, copies builtins on write and deletes home only",
    },
    edits: [
      {
        file: store,
        before:
          '    const path =\n      this.origin(existing) === "builtin"\n        ? join(this.root, existing.name, "SKILL.md")\n        : existing.path;',
        after: "    const path = existing.path;",
      },
    ],
  },
  {
    id: "SK10-delete-scope-bypasses-home-root",
    category: "delete-scope-bypasses-home-root",
    mechanism: "family-a",
    focus: {
      file: skillsFocus,
      test: "updates project in-place, copies builtins on write and deletes home only",
    },
    edits: [
      {
        file: store,
        before: "    const skill = this.scanRoot(this.root).find((entry) => entry.name === name);",
        after: "    const skill = this.scan().find((entry) => entry.name === name);",
      },
    ],
  },
  {
    id: "SK11-export-error-message-drops-catalog",
    category: "export-error-message-drops-catalog",
    mechanism: "family-a",
    focus: {
      file: skillExportFocus,
      test: "fails before touching the destination for unknown kits",
    },
    edits: [
      {
        file: exportModule,
        before: "    throw new Error(`no exportable skill '${name}' — available: ['use-lohra']`);",
        after: "    throw new Error(`no exportable skill '${name}'`);",
      },
    ],
  },
  {
    id: "SK12-parse-skill-md-description-dropped",
    category: "parse-skill-md-description-dropped",
    mechanism: "family-a",
    focus: {
      file: skillsBuiltinContractFocus,
      test: "descriptions de use-lohra-ts e workflow-authoring têm gatilho e anti-gatilho",
    },
    edits: [
      {
        file: store,
        before: '    description: meta.get("description") ?? "",',
        after: '    description: "",',
      },
    ],
  },
];
