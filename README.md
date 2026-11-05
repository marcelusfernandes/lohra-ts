# lohra-ts

[![ci](https://github.com/marcelusfernandes/lohra-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/marcelusfernandes/lohra-ts/actions/workflows/ci.yml)

A versão atual é `0.1.0`.

lohra-ts is a headless TypeScript agent runtime. One package gives you a CLI, a local gateway and dashboard, durable workflows, cron, MCP tools, and a skill kit for Claude, Codex, OpenCode, and Pi. The npm package is `lohra-ts`. The command it installs is `lohra`.

The package does not bundle or call Python. Since 2026-09-04 it is developed on its own, apart from the historical Python Lohra.

## Install

Node.js 20 or newer, on macOS or Linux.

```bash
npm i -g lohra-ts
lohra --version
lohra doctor
```

`lohra-ts` is a public npm package. `0.0.12` was published on 2026-09-14. This git cut is `0.1.0`. Pushing the tag after merge is what publishes that version and opens the GitHub Release ([docs/release.md](docs/release.md)).

Windows is in progress and is not a supported platform. A green Linux run is not a Windows promise. What the runtime already does with a Windows home, credentials, and generated images is in [docs/windows-home.md](docs/windows-home.md).

If the Python Lohra is also on `PATH`, the first `lohra` wins. `lohra doctor --json` is this runtime's own report.

On the macOS and Linux runners that `pack-check` covers, `better-sqlite3` and `node-pty` are expected to come from prebuilds, not a local compile.

## First session

On a TTY, `lohra init` asks which provider to use. Terminal answers are hidden: the prompt says so, and Ctrl+C or EOF stops setup without claiming it finished. If that provider needs a key that is not set, init asks for it. If a key is already set, it asks for a default model. It may also offer to copy the legacy `use-lohra` kit into harness directories it already sees. That is not the client installer below.

`lohra init --no-input`, or a run whose stdin is not a terminal, only prints the report and writes nothing.

```bash
lohra init
lohra chat "What is in this directory?"
```

`lohra chat` is one turn. `--json` prints a machine-readable result. Resume with `lohra chat --session ID "..."`.

A workflow does not start from the CLI. There is no `lohra workflow run`. Ask for one in a turn; the agent calls `run_workflow`. The smallest spec is one `agent` node:

```json
{
  "meta": { "name": "note" },
  "nodes": [
    {
      "id": "draft",
      "type": "agent",
      "prompt": "Write a one-paragraph note about this repository."
    }
  ]
}
```

Then read the durable run from any terminal, against the same state database:

```bash
lohra workflow list
lohra workflow watch RUN_ID
lohra workflow templates
```

`workflow` only reads state. It does not call a model. Its subcommands are `list`, `watch`, `audit`, `notices`, and `templates`.

`workflow_save` stores a run that finished `complete`. `run_workflow` with `template` set to that name runs it again. `lohra workflow templates` prints the scoreboard. Nothing promotes a template by itself, and there is no learning loop.

How to choose a node, how refs work, and how to read `complete`, `degraded`, `failed`, and `paused`: [assets/skills/workflow-authoring/SKILL.md](assets/skills/workflow-authoring/SKILL.md). `switch`, `loop` (required `max_rounds`, 1 to 16), fail-closed `escalate`, and model-free `call` (`read_file` or `web_fetch` only): [assets/skills/workflow-authoring/flow-control/SKILL.md](assets/skills/workflow-authoring/flow-control/SKILL.md). The same behavior is summarized in [docs/workflow-supervision.md](docs/workflow-supervision.md).

## Surfaces

Os comandos top-level públicos, na ordem exibida pelo help, são `init`, `doctor`, `chat`, `dashboard`, `serve`, `cron`, `workflow`, `models`, `tiers`, `profile`, `auth`, `skill`, `skills` e `update`.

| Command                  | What it is                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `init`, `doctor`, `chat` | Set up, check the profile, take one turn.                                                  |
| `dashboard`              | Local HTTP and WebSocket gateway. It prints a URL and does not open a browser.             |
| `serve`                  | OpenAI-compatible HTTP server.                                                             |
| `cron`                   | Scheduled jobs: `list`, `add`, `remove`, `pause`, `resume`.                                |
| `workflow`               | Read durable runs. It does not start one.                                                  |
| `models`, `tiers`        | Models and tiers for the current provider.                                                 |
| `profile`, `auth`        | Named profiles, and API-key or Codex-subscription auth.                                    |
| `skill`, `skills`        | Export one bundled skill, or install the managed kit into a client.                        |
| `update`                 | On an npm install, compare with the public registry. On a git checkout, fast-forward only. |

How `doctor` and `chat` choose a provider when you pass no `--provider`: [docs/provedores-deteccao.md](docs/provedores-deteccao.md).

### Clients

`lohra skills add` copies this package's skill kit into a client. It does not install the client, and it does not change Lohra's provider.

```bash
lohra skills add "Claude Code"
lohra skills add Codex
lohra skills add OpenCode
lohra skills add Pi
```

`Claude` is accepted. Names are case-insensitive. Paths, updates, and removal: [docs/skills-management.md](docs/skills-management.md). `lohra init` does not yet pick those clients from a keyboard list.

MCP servers are read from `mcp.json` in the Lohra home when `chat` or `dashboard` starts. A missing file is ignored. A malformed file fails closed.

### Library

`import "lohra-ts"` exports `ConversationRuntime`, `SqliteConversationRepository`, `SessionRepository`, and `openStateDatabase`. The import does not open a database, read credentials, start the CLI, or connect to a provider. You pass the state path, the model transport, and the tools.

## Not in 0.1.0

- **Windows as a supported platform.** Milestone 25 hardening is in progress. The `windows-checks` job is informative (`continue-on-error`). This release does not make it required.
- **A terminal UI.** The Ink TUI is not shipped (milestone 23 is still the open investigation). `dashboard` is the local gateway, not that UI.
- **Automatic template promotion or a learning loop.** A template is written only when `workflow_save` is asked to keep a completed run.
- **Keyboard client selection and an explicit default provider inside `init`.** Those are #938 and #939, left for 0.1.1. `lohra skills add` is what installs the kit today.

## More

- [CHANGELOG.md](CHANGELOG.md) — merges since published npm `0.0.12`
- [docs/release.md](docs/release.md) — how a version is cut and published
- [docs/skills-management.md](docs/skills-management.md)
- [docs/provedores-deteccao.md](docs/provedores-deteccao.md)
- [docs/system-prompt.md](docs/system-prompt.md)
- [docs/workflow-supervision.md](docs/workflow-supervision.md)
- [docs/workflow-audit.md](docs/workflow-audit.md)
- [docs/windows-home.md](docs/windows-home.md)
- [docs/gate-decision-t22.md](docs/gate-decision-t22.md)
- [docs/adr/0003-native-wire-format.md](docs/adr/0003-native-wire-format.md)

O owner escolheu `typescript-mainline` para o novo capítulo em [docs/gate-decision-t22.md](docs/gate-decision-t22.md) (2026-09-03). Live provider and SDK smokes remain `NOT_MEASURED` without credentials.

## License

[MIT](LICENSE).
