import type { ToolDefinition } from "./types.js";

// Built-in tool schema registry. Definition and key order is a contract:
// consumers rely on this exact shape and ordering.
export const BUILTIN_DEFINITIONS = [
  {
    type: "function",
    function: {
      description: "Read a UTF-8 text file from the local filesystem.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file",
          },
        },
        required: ["path"],
      },
      name: "read_file",
    },
  },
  {
    type: "function",
    function: {
      description: "Write a UTF-8 text file (creating parent directories).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file",
          },
          content: {
            type: "string",
            description: "Full file contents to write",
          },
        },
        required: ["path", "content"],
      },
      name: "write_file",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Run a shell command on the local machine and return stdout, stderr, and the exit code. Dangerous commands require user approval.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to run",
          },
          timeout: {
            type: "integer",
            description: "Timeout in seconds (default 30)",
          },
          cwd: {
            type: "string",
            description: "Working directory (optional)",
          },
        },
        required: ["command"],
      },
      name: "terminal",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Fetch a web page by URL and return its readable text content. Use this to read an article, doc, or page the conversation refers to. Only public http(s) URLs are allowed.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The http(s) URL to fetch",
          },
        },
        required: ["url"],
      },
      name: "web_fetch",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Search the web and return a list of results (title, url, snippet). Use this to find pages, then 'web_fetch' to read the most relevant one.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for",
          },
          max_results: {
            type: "integer",
            description: "How many results, 1-10 (default 5)",
          },
        },
        required: ["query"],
      },
      name: "web_search",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Save durable facts that should persist across sessions. Save proactively when the user corrects you, shares a preference or habit, or you learn a convention or environment quirk. Do NOT save task progress, completed-work logs, or temporary TODOs \u2014 procedures belong in skills, not memory. Write declarative facts ('User prefers tabs'), not instructions to yourself.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "replace", "remove"],
          },
          target: {
            type: "string",
            enum: ["memory", "user"],
            description: "memory = agent notes (default); user = user profile",
          },
          text: {
            type: "string",
            description: "Entry text for 'add'",
          },
          old_text: {
            type: "string",
            description: "Unique substring to find (replace/remove)",
          },
          new_text: {
            type: "string",
            description: "Replacement entry text (replace)",
          },
        },
        required: ["action"],
      },
      name: "memory",
    },
  },
  {
    type: "function",
    function: {
      description: "Load the full body of a skill by name (progressive disclosure).",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill name to load",
          },
        },
        required: ["name"],
      },
      name: "skill_view",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Skills are procedural memory. create one when a task was complex (5+ steps), you overcame non-obvious errors, or a workflow is worth reusing. update one that's stale or wrong (edits it in place \u2014 a project skill is edited in the project). delete removes a skill (home skills only). For a project-specific skill, create with scope='project'. Bodies: concise, reusable instructions.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "update", "delete"],
          },
          name: {
            type: "string",
            description: "Skill name (lowercase, hyphens, \u226464)",
          },
          description: {
            type: "string",
            description: "One-line description (create/update)",
          },
          body: {
            type: "string",
            description: "Markdown instructions (create/update)",
          },
          scope: {
            type: "string",
            enum: ["home", "project"],
            description: "Where create writes (default home; 'project' = the project's skills)",
          },
        },
        required: ["action", "name"],
      },
      name: "skill_manage",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Search your past sessions at zero token cost. mode='discovery' full-text searches all messages (FTS5 syntax: AND default, OR, NOT, \"phrases\", prefix*); mode='browse' lists recent sessions; mode='read' returns a whole session by id.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["discovery", "browse", "read"],
          },
          query: {
            type: "string",
            description: "Search query (discovery)",
          },
          session_id: {
            type: "string",
            description: "Session to read (read)",
          },
          limit: {
            type: "integer",
            description: "Max results (discovery)",
          },
        },
        required: ["mode"],
      },
      name: "session_search",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Delegate one or more self-contained subtasks to fresh, isolated subagents and wait for their results. Each subagent starts with no knowledge of this conversation, so every task string must be fully self-contained. Each result carries a 'sub_id' \u2014 to continue that subagent later (it keeps its own history), call delegate_task again with 'resume_id' set to that sub_id and a single follow-up instruction in 'tasks' \u2014 plus 'error_kind' (null on success; 'dead_turn' for a subagent that produced no final text and called no tool), 'tokens_in', 'tokens_out', 'provider' and 'model' for that task's turn, so you can decide the next step without calling collect_session.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "string",
            },
            description:
              "Self-contained task descriptions, one per subagent (or a single follow-up instruction when resuming).",
          },
          resume_id: {
            type: "string",
            description: "A sub_id from a prior delegate_task, to continue that subagent.",
          },
          model: {
            type: "string",
            description: "Optional model for the subagents. Omit to inherit the orchestrator's.",
          },
          provider: {
            type: "string",
            description:
              "Optional provider for the subagents (cross-provider, e.g. 'openai', 'anthropic') \u2014 must have credentials configured. Omit to inherit.",
          },
          effort: {
            type: "string",
            description:
              "Optional reasoning effort for the subagents (where the model supports it).",
          },
          max_iterations: {
            type: "integer",
            description:
              "Optional cap on how many provider round-trips each subagent may take (1-128). Raise it for long tool-heavy work; omit to inherit the default.",
          },
        },
        required: ["tasks"],
      },
      name: "delegate_task",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Schedule prompts to run later as autonomous agent turns. Use for recurring or one-off background work the user asked to automate (a daily summary, a periodic check). 'interval' value = minutes; 'once' value = an epoch timestamp; 'cron' value = a 5-field expression (min hour day month weekday, weekday 0=Sunday). Each run is isolated \u2014 write a fully self-contained prompt.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "list", "remove", "pause", "resume"],
          },
          name: {
            type: "string",
            description: "Job name (for 'add')",
          },
          prompt: {
            type: "string",
            description: "The instruction each run executes (for 'add')",
          },
          schedule_type: {
            type: "string",
            enum: ["once", "interval", "cron"],
          },
          value: {
            description: "minutes (interval) | epoch (once) | cron expr (cron)",
          },
          job_id: {
            type: "string",
            description: "Target job (remove/pause/resume)",
          },
        },
        required: ["action"],
      },
      name: "cronjob",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Analyze an image and return a text description. Pass a local image 'path' or a remote 'url', and an optional 'prompt' for what to look for. Use this to read screenshots, diagrams, or photos the conversation refers to.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Local image file path",
          },
          url: {
            type: "string",
            description: "Image URL (http or data URI)",
          },
          prompt: {
            type: "string",
            description: "What to look for (optional)",
          },
        },
      },
      name: "vision_analyze",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Generate one or more images from a text 'prompt' and save them to disk; returns the file paths. Optional 'size' (one of '1024x1024', '1024x1536', '1536x1024', 'auto') and 'n' (how many, 1-10). Use this to create illustrations, mockups, or diagrams the user asks for.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "What to draw",
          },
          size: {
            type: "string",
            enum: ["1024x1024", "1024x1536", "1536x1024", "auto"],
            description: "Image size (optional; defaults to the provider's default)",
          },
          n: {
            type: "integer",
            description: "How many images, 1-10 (default 1)",
          },
        },
        required: ["prompt"],
      },
      name: "image_gen",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Start a parallel sub-session (a fresh, isolated agent) to work on a self-contained task without blocking you. Returns a 'sub_id' immediately. The sub-session has no access to this conversation, so the prompt must be fully self-contained. Use 'steer_session' to add instructions and 'collect_session' to read the result.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Self-contained task for the sub-session",
          },
          model: {
            type: "string",
            description: "Optional model for the sub-session. Omit to inherit the orchestrator's.",
          },
          provider: {
            type: "string",
            description:
              "Optional provider for the sub-session (cross-provider, e.g. 'openai', 'anthropic') \u2014 must have credentials configured. Omit to inherit.",
          },
          effort: {
            type: "string",
            description: "Optional reasoning effort (where the model supports it).",
          },
          max_iterations: {
            type: "integer",
            description:
              "Optional cap on how many provider round-trips the sub-session may take (1-128). Raise it for long tool-heavy work; omit to inherit the default.",
          },
        },
        required: ["prompt"],
      },
      name: "spawn_session",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Inject an extra instruction into a running sub-session by its 'sub_id'. If the sub-session is busy the text is queued and read before its next step; if idle it starts a new turn.",
      parameters: {
        type: "object",
        properties: {
          sub_id: {
            type: "string",
            description: "The sub-session id from spawn_session",
          },
          text: {
            type: "string",
            description: "The instruction to inject",
          },
        },
        required: ["sub_id", "text"],
      },
      name: "steer_session",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Read a sub-session's status and output by its 'sub_id'. Set 'wait' true to block until its current turn finishes, or false to poll.",
      parameters: {
        type: "object",
        properties: {
          sub_id: {
            type: "string",
            description: "The sub-session id from spawn_session",
          },
          wait: {
            type: "boolean",
            description: "Block until the turn finishes (default false)",
          },
        },
        required: ["sub_id"],
      },
      name: "collect_session",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Run a dynamic multi-agent workflow you author as a declarative spec \u2014 a DAG of sub-agents that pursues a goal autonomously. 'spec' is an object with meta{name}, optional schemas{NAME: <json-schema>}, and a 'nodes' list; every node is {id, type, ...fields}. The node types are a CLOSED set of 10:\n- agent: one leaf prompt. Add 'schema' (inline JSON-Schema, or a name string that must match a key in schemas — the same lookup as 'schema_ref') or 'schema_ref' (a name from schemas) to get validated JSON back instead of prose.\n- parallel: barrier fan-out over 'branches' (a list of nodes) \u2014 all of them finish before anything downstream runs. Branches in the same run share ONE working filesystem root, fenced per run acquisition, not per branch \u2014 two branches that write the SAME file race at the filesystem and the last write silently wins — the collision now shows up in workflow_status's 'artifacts'/'faults' (advisory, never flips 'status'), but the write itself is never arbitrated. Design fan-out with one file per leaf, and aggregate their outputs in a downstream node instead of writing into a shared file from parallel branches. Optional 'retries' (0-3, default 0) re-spawns a branch that comes back DEAD (timed out, cancelled, or the runtime failed it) up to that many times \u2014 a branch that returns a legitimate EMPTY value (no schema, so an empty string or list is real data) is never retried.\n- pipeline: 'items' (a list or a ${ref}) x 'stages' (agent-shaped stages). Each item flows through the stages on its own, with no barrier between items \u2014 use this, not parallel, for per-item processing. Each stage spawns its own leaf, so a stage MAY carry its own 'model'/'tier'/'effort'/'provider', overriding the node's for that stage only \u2014 this is the one sub-object where a routing knob is real, not refused. Optional 'min_success_ratio' (0 < ratio \u2264 1): if fewer than that fraction of items complete, the node seals the whole run 'failed' with a fault naming the measured ratio.\n- loop_until_dry: repeat 'body' until 'stop_after_k_empty' rounds come back empty, capped by 'max_rounds'. Optional 'budget' (a positive whole number of tokens) is a real per-node ceiling \u2014 the round loop stops with a fault once that node's own spend reaches it, independent of the run's overall token_budget.\n- verify: adversarial check \u2014 'skeptics' sub-agents try to refute 'finding' (optional 'lenses'); a majority refutation kills it.\n- judge_panel: 'attempts' are scored by 'judges' independent judges, and the winner is rewritten by the 'synthesize' prompt.\n- workflow: run a saved template by 'ref' as a nested sub-workflow.\n- gate: draft 'body' (agent-shaped), have a reviewer leaf judge it against 'validator', and re-draft with its feedback until it passes ('attempts', default 2) \u2014 the cheap way to hold one answer to a standard.\n- completeness_check: audit 'results' against 'task'; returns {complete, missing} \u2014 pair it with loop_until_dry to keep digging.\n- checkpoint: ask a HUMAN 'prompt' and PAUSE the run (it spawns nothing); resume with checkpoint_answers={node_id: answer} using the exact node_id the pause reply carries — inside a nested 'workflow' node it's SCOPED ('<sub_node_id>.<checkpoint_id>', e.g. \"sub.confirm\") so it never collides with the root's or a SIBLING nested workflow's checkpoint of the same id — or give it a 'default'.\nAgent and rigor nodes (verify, judge_panel, loop_until_dry, gate, completeness_check) may name a portable 'tier' (small|medium|big) instead of a 'model' slug \u2014 the operator maps it, and one resolved routing applies to every leaf the node spawns. An explicit 'model' wins over the tier. Put the knobs on the NODE: one level down, inside 'body'/'synthesize'/'branches', a routing knob ('model'/'tier'/'effort'/'provider') is refused at validation as an unknown field — those sub-objects only take the agent-shaped fields ('prompt', 'schema', 'schema_ref', 'tool_less', 'timeout', 'retries', 'max_iterations') and spawn with the node's own routing. A pipeline 'stage' is the one exception (see 'pipeline' above): it spawns its own leaf, so it MAY set its own routing knobs there instead.\nBefore naming a 'model' or a 'provider' on a node, call list_models \u2014 it reports what is REACHABLE right now plus the operator's tier map. Never invent a slug: only 'tier' is a closed enum, and 'model'/'effort'/'provider' are free fields nothing validates \u2014 the catalog is information, not an allow-list. Nodes in the SAME DAG may name DIFFERENT providers, including 'openai-codex' (the subscription \u2014 refused unless the human enabled it AND prefers it, and a refused node just comes back null) beside an API-key one. If the user asked to CONFIRM the assignment, put a checkpoint presenting the plan (node -> model/provider) before the expensive nodes; on automatic, assign straight from the tiers and the catalog and don't stop to ask.\nA leaf (or pipeline stage) that dies with 'max_iterations (N) reached' needs a bigger 'max_iterations' (1-128, default 50), not a longer 'timeout'.\nReference an earlier node's output with ${node.field} and the run inputs with ${args.x} \u2014 plain dotted paths only, never expressions. Use 'depends_on' to order nodes that share no data ref.\nA complete valid spec: {\"meta\":{\"name\":\"triage-bugs\"},\"schemas\":{\"FINDING\":{\"type\":\"object\",\"properties\":{\"bug\":{\"type\":\"string\"}}}},\"nodes\":[{\"id\":\"scan\",\"type\":\"agent\",\"prompt\":\"Name the worst bug in ${args.dump}.\",\"schema_ref\":\"FINDING\"},{\"id\":\"check\",\"type\":\"verify\",\"finding\":\"${scan.bug}\",\"skeptics\":3},{\"id\":\"report\",\"type\":\"agent\",\"depends_on\":[\"check\"],\"prompt\":\"Write a fix plan for ${check.finding}.\"}]}\nReturns a run_id immediately \u2014 poll it with workflow_status ('wait' blocks) and abort with workflow_cancel. Reach for verify nodes for adversarial checking and agent schemas for structured output. TIP: call workflow_templates FIRST \u2014 adapt a proven template instead of authoring from scratch whenever one fits the task shape.\nRe-running is cheap: run_workflow(resume_run_id=...) replays the cells that already completed and only re-spawns what died. A 'paused' status means the run stopped RESUMABLY, not that the spec failed \u2014 it keeps its finished nodes. Provider quota: it auto-resumes itself, so don't cancel it. Spent 'token_budget' (the optional cap on what the whole run may spend, reported back as {total, spent, remaining}): it will not \u2014 resume it with a bigger one. A run paused with reason 'route_fault' (auth/model/routing refused a leaf) can resume on a DIFFERENT route: run_workflow(resume_run_id=..., route={provider?, model?}) rewrites 'provider'/'model' on every node (and pipeline stage) that names a route \u2014 nodes that never named one keep their cached cells, only the pinned ones re-spawn (channel 'operator' in workflow_status's 'pivots'). Resuming WITHOUT 'route' instead applies workflow_status's 'lesson.suggested_route' on your behalf (channel 'route_envelope') whenever the operator's workflow_routes.json (a per-dead-route ordered fallback list, `<home>/workflow_routes.json`) names one for this exact dead route that this run hasn't tried yet \u2014 the harness never picks a route outside that list; with no envelope entry, or none left to try, a route-less resume just tries the SAME route again. A run pivots route at most 3 times total, across BOTH channels; an explicit 'route' always wins over the envelope's own suggestion (even a different one), and is refused without 'resume_run_id' or once the run has already pivoted 3 times \u2014 a route-less resume past the cap simply stays put instead of refusing. Each node a pivot actually rewrites leaves a node.rerouted entry in workflow_audit. Before resuming with 'route', call workflow_preview {run_id, route} to see what would replay and what would re-spawn WITHOUT spending a token or consuming one of the 3 pivots.\nWhile a run is in flight you can always look: workflow_status reports live 'progress' per node, workflow_list shows every run at once, and workflow_pause stops one resumably (nothing in flight is thrown away).\nFor choosing between the node types, sizing the fan-out and reading the rollup honestly, load the workflow-authoring skill first.",
      parameters: {
        type: "object",
        properties: {
          spec: {
            type: "object",
            description:
              "The workflow spec: {meta:{name}, schemas?, nodes:[{id, type, ...}]}. type is one of: agent, parallel, pipeline, loop_until_dry, verify, judge_panel, workflow, gate, completeness_check, checkpoint (see this tool's description for their fields).",
          },
          args: {
            type: "object",
            description:
              "Inputs for the run (referenced as ${args.x}). A resume replays the run's OWN args \u2014 send these again only to change them.",
          },
          resume_run_id: {
            type: "string",
            description:
              "Re-run a prior run_id, reusing its cached cells (resume after a crash). It replays the run's OWN persisted spec, so 'spec' is optional here \u2014 send one only to run something different. The spec, args and pending checkpoint are on disk, so this works in a later session too, not just this one.",
          },
          checkpoint_answers: {
            type: "object",
            description:
              "Answers for the 'checkpoint' nodes a previous stretch of this run paused on, keyed by node id: {\"approve\": \"yes\"}. Each answer becomes that node's output and is cached, so the same question is never asked twice. A checkpoint inside a nested 'workflow' node reports a SCOPED node_id ('<sub_node_id>.<checkpoint_id>', e.g. \"sub.confirm\") — the bare checkpoint id is still accepted as long as it doesn't collide with a checkpoint at the root or a sibling nested workflow; once it does, only that exact scoped key is accepted and the bare id is refused as ambiguous instead of silently going to the wrong node.",
          },
          token_budget: {
            type: "integer",
            description:
              "Cap the tokens this whole run may spend. Checked before every leaf spawn; overrunning pauses the run instead of truncating it. On a resume the tally continues, so pass a bigger number than the 'spent' workflow_status reported (omit to keep the old cap).",
          },
          route: {
            type: "object",
            description:
              "Only accepted together with 'resume_run_id': {provider?, model?} rewrites 'provider'/'model' on every node (and pipeline stage) in the run's OWN persisted spec that names a route — nodes that never named one are untouched and keep their cached cells; a pinned node re-spawns on the new route. Use it to resume a run paused with reason 'route_fault' on a route other than the one that just refused. A given 'provider'/'model' must be non-empty after trimming whitespace — an empty or whitespace-only value is refused before the run is touched, never persisted as a route. Refused without 'resume_run_id', or once a run has already pivoted route 3 times (the same shared cap a route-less resume's own automatic envelope pivot counts against). Omit 'route' entirely to let a route_fault resume apply the operator's workflow_routes.json suggestion instead (channel 'route_envelope' in workflow_status's 'pivots'); naming 'route' explicitly here always wins over that suggestion, even a different one (channel 'operator').",
          },
        },
        required: [],
      },
      name: "run_workflow",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Poll a workflow run's status/outputs by its run_id. 'wait' blocks until done. 'progress' is live even mid-run \u2014 {done, running, pending, total} plus a per-node list (pending/running/complete/null, and settled items for a pipeline) \u2014 so a long run is never a black box. status 'paused' means the run stopped resumably, not that the spec failed: the reply carries reason/resume_at/attempts and the finished nodes are kept. reason 'quota_exhausted' (the provider) retries itself \u2014 resume it early with run_workflow(resume_run_id=...). reason 'route_fault' means a leaf refused the ROUTE itself (auth_failed/route_fault/model_not_found, never quota) — the reply carries 'lesson' {error_kind, node_id, provider, model, suggested_route}; suggested_route is the first fallback the operator authorized for this exact dead route in workflow_routes.json (`<home>/workflow_routes.json`, an ordered per-route fallback list) that this run hasn't tried yet, or null when no envelope covers this route or every authorized fallback was already tried — resuming WITHOUT 'route' applies it automatically (channel 'route_envelope' in the reply's 'pivots', each entry also naming 'channel': 'operator' for one you passed yourself), so the harness never picks a route outside what the operator authorized; naming 'route' yourself instead (channel 'operator') always wins, even when it differs from the suggestion — resume with run_workflow(resume_run_id=..., route={provider?, model?}) — it rewrites every node (and pipeline stage) that names a route, so cells that never named one stay cached, and the same leaf refuses again only if the new route is still broken — call workflow_preview {run_id, route} first to see what a candidate route would replay/re-spawn without spending it. A run pivots route at most 3 times, across both channels; past that, an explicit 'route' is refused and a route-less resume just stays on the current one instead of pivoting again. Each node a pivot actually rewrote shows up as workflow_audit's node.rerouted, naming the channel, the pivot number, and the 'from'/'to' route. reason 'token_budget_exhausted' never does: compare 'token_budget' {total, spent, remaining} and resume with a bigger cap. reason 'checkpoint' is waiting on YOU: the reply carries checkpoint{node_id, prompt, default?, rename_hint?} \u2014 answer it with run_workflow(resume_run_id=..., checkpoint_answers={node_id: answer}). 'rename_hint' only shows up when this node_id (already the scoped form) collides with a ROOT checkpoint's own literal id \u2014 resuming with the SAME node_id just pauses again, so rename one of the two checkpoint ids in the spec instead of answering. A run still marked 'running' with 'stale' true is one whose process was lost \u2014 resume it; its finished cells replay, and the audit ledger (workflow_audit) records the resume as segment.completed{reason:'process_crash'} plus audit.gap, distinct from a sink failure. 'leaf_respawns' is the run's total count of leaves re-spawned beyond the plan \u2014 an empty output on any agent or pipeline stage, a failed schema validation on a pipeline stage specifically (an agent node's own schema mismatch is steered on the same leaf instead, never re-spawned), or a dead parallel branch retried under its 'retries' field, or a dead gate/loop_until_dry 'body' leaf retried under that same 'body.retries' field \u2014 and it stays the run's total across a resume, not just the latest stretch's. 'sandbox_refusals' is the run's total count of tool calls the operator sandbox denied inside a leaf (path outside the working scope, a read-only root, an egress host not allowed, a tainted run) \u2014 ADVISORY: it shows up here and in 'faults' as \"<node>: sandbox refused N tool call(s)\", but never on its own flips 'status' away from 'complete', because the denial may be the policy working as intended. It stays the run's total across a resume too. 'fault_kinds' lists the ErrorKind of each leaf failure the provider classified (e.g. 'auth_failed', 'model_not_found'), in order of occurrence — a typed subset of 'faults', never parsed from its text; 'quota_exhausted' never appears here, since that failure surfaces as reason 'quota_exhausted' instead. 'artifacts' lists every file a leaf's own write_file tool call actually wrote this run — {node_id, sub_id, path, bytes}, 'path' exactly as the tool received it and 'bytes' from the tool's own envelope; it accumulates across a resume, and it is never populated by 'terminal' or an MCP tool. Two leaves writing the SAME path both still show up here — the collision only ever shows up in 'faults' as an advisory (\"artifact path written by 2 leaves\"), never changes 'status'. 'forcing_fallbacks' is the run's total count of nodes that named a 'schema'/'schema_ref' and forced it as a tool call, where the leaf's completed turn never actually made that StructuredOutput call — the node's own raw text is used instead, so this counts a MISSED structured output, never a routing choice like 'provider'/'model'/'tier'. When the run is still known IN THIS PROCESS (the one that launched it, or resumed it), the reply also carries 'live_tail' \u2014 {events, next_cursor, dropped}, the last events this process itself observed (bounded: at most 256 events or 64 KiB serialized, whichever is smaller; 'dropped' counts how many older events fell off) \u2014 pass the previous reply's 'next_cursor' back as 'after_index' to see only what is new since then. 'next_cursor' is monotonic for the run's whole life in this process \u2014 it never goes backward, even across a same-process pause and auto-resume, so an 'after_index' from before a pause still returns every event pushed since, never a silent gap. The run's own terminal event never shows up as a 'live_tail' entry \u2014 read 'status' for that. A durable-only read (a DIFFERENT process from the one running it, e.g. after a resume elsewhere) never carries 'live_tail' \u2014 use workflow_audit for that run's full history instead.",
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
          },
          wait: {
            type: "boolean",
            description: "Block until the run finishes (default false)",
          },
          after_index: {
            type: "integer",
            description:
              "Only include 'live_tail' events after this cursor (the previous reply's 'live_tail.next_cursor'). Omit to get the whole live tail this process currently holds.",
          },
        },
        required: ["run_id"],
      },
      name: "workflow_status",
    },
  },
  {
    type: "function",
    function: {
      description:
        "List the workflow runs this session knows (newest first): run_id, name, status, nodes_done/nodes_total, tokens_spent and token_budget. Use it to find a run whose id you lost, or to see what is still in flight before starting another one.",
      parameters: {
        type: "object",
        properties: {},
      },
      name: "workflow_list",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Pause a running workflow by its run_id \u2014 the resumable stop. Unlike workflow_cancel, nothing is thrown away: leaves already in flight finish and are charged, finished nodes are kept, and the run reports status 'paused' with reason 'user_requested'. Nothing resumes it on its own \u2014 continue it whenever you like with run_workflow(resume_run_id=...), no token_budget raise needed.",
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
          },
        },
        required: ["run_id"],
      },
      name: "workflow_pause",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Cancel a running workflow by its run_id — waits (up to the same ceiling shutdown() uses) for every leaf already in flight to actually stop, so status 'cancelled' means nothing is still spending tokens. A leaf that ignores the cancel signal past that ceiling returns status 'cancelling' with 'leaves_in_flight' (still running, not thrown away); call workflow_cancel again or workflow_status to see it finally settle.",
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
          },
        },
        required: ["run_id"],
      },
      name: "workflow_cancel",
    },
  },
  {
    type: "function",
    function: {
      description:
        "List validated workflow templates (proven specs to adapt), or fetch one by 'name' to get its full spec. Prefer adapting a template over authoring fresh. Templates come from `<home>/workflows/*.json` — one JSON spec per file, 'name'/'ref' is the filename without its extension; the same 'ref' a 'workflow' node in run_workflow's spec resolves through.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Fetch this template's full spec (omit to list)",
          },
        },
      },
      name: "workflow_templates",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Read the durable metadata-only audit trail for one workflow run. This is a local SQLite query: it creates no provider client and spends no model tokens. Events are chronological and paginated by durable seq. Reuse the returned snapshot_seq for stable pagination; omit it with after_seq to follow a live tail. Filters affect event rows, never integrity notices; an empty string or 0 in an optional filter (node_id/event_type/sub_id/segment_id/attempt) means no filter, not a literal value to match; snapshot_seq: 0 likewise means no snapshot yet, not page one frozen at seq 0 — a run with events never has a real snapshot_seq of 0. leaf.started/leaf.completed/leaf.failed cover one spawned leaf each (role, node_path, usage); tool.started/tool.completed cover one tool call made INSIDE a leaf (tool_name_state — known_tool only from the builtin catalog, an MCP tool's real name always reports unknown_tool here — arg count, success/error/sandbox_denied/cancelled) — both carry identity.sub_id, so filtering by sub_id returns a leaf together with every tool it called; reason 'cancelled' means the leaf itself closed (cancel, shutdown, or a timeout) while this call was still in flight, so tool.completed is still paired with its tool.started even though the real dispatch never got to finish. cache.replayed/cache.missed/cache.stored/cache.unavailable cover one node-cache lookup or write each, with node_path naming the cell's owner. segment.started/segment.completed bracket one acquisition (segment_id): a dead-owner resume closes the PRIOR segment as interrupted/process_crash before the new one starts, followed by audit.gap{reason:'process_crash'} — distinct from audit.gap{reason:'sink_failure'}. node.paused names the reason (checkpoint/quota_exhausted/token_budget_exhausted/user_requested/route_fault) a run stopped resumably. node.rerouted names one node a resume actually rewrote onto a new route — 'channel' ('operator' for an explicit 'route', 'route_envelope' for the operator's own workflow_routes.json suggestion applied automatically), 'pivot' (this run's pivot count so far), and 'from'/'to' ({provider, model}, the node's own resolved routing before/after) — one per node the pivot actually rewrote, never for a node that named no route at all. Never a tool's name, arguments, or output in clear text. Called in the SAME turn as run_workflow (this process), it first waits up to 250ms for this process's audit trail to finish draining to disk; 'integrity.pending' — a count, never negative — shows up only if that drain is still not done when the wait runs out. It counts events still buffered in this process's audit trail for any run, not filtered by run_id, so it can be nonzero even when this run itself has nothing pending; a later read may show more events for this run (retry the same query shortly). A durable-only read from a DIFFERENT process never sets it — there is no buffer there to drain.",
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description: "Workflow run id.",
          },
          node_id: {
            type: "string",
            description: "Exact final node id.",
          },
          event_type: {
            type: "string",
            description: "Exact audit event type.",
          },
          sub_id: {
            type: "string",
            description: "Exact leaf sub-session id.",
          },
          segment_id: {
            type: "string",
            description: "Exact run segment id.",
          },
          attempt: {
            type: "integer",
            minimum: 0,
          },
          after_seq: {
            type: "integer",
            minimum: 0,
            description: "Exclusive durable cursor (default 0).",
          },
          snapshot_seq: {
            type: "integer",
            minimum: 0,
            description: "High-water mark returned by page one for a stable scan.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            description: "Rows to return (default 50, clamped to 100).",
          },
        },
        required: ["run_id"],
      },
      name: "workflow_audit",
    },
  },
  {
    type: "function",
    function: {
      description:
        "List durable operator notices — warnings recorded to disk (workflow faults, sink refusals, stale fence writes), never in-memory only, so a notice a killed process left behind is still visible from a fresh one. Unacknowledged by default; include_acked also returns the ones already handled. Omitting run_id lists every scope (every run plus global); given, it scopes to that run only. An empty string or 0 in an optional filter (run_id/limit) means no filter, not a literal value.",
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description: "Only this run's notices (omit for every run and global).",
          },
          after_seq: {
            type: "integer",
            minimum: 0,
            description: "Exclusive durable cursor (default 0; only meaningful with run_id).",
          },
          include_acked: {
            type: "boolean",
            description: "Also return already-acknowledged notices (default false).",
          },
          limit: {
            type: "integer",
            minimum: 1,
            description: "Rows to return (default 50, clamped to 200).",
          },
        },
      },
      name: "workflow_notices",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Acknowledge one durable operator notice by its id (from workflow_notices) — an acked notice stops showing up in workflow_notices unless include_acked is set. Acking an unknown or already-acked id is not an error: it reports acked:false.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "integer",
            description: "The notice's id, from workflow_notices.",
          },
        },
        required: ["id"],
      },
      name: "workflow_notices_ack",
    },
  },
  {
    type: "function",
    function: {
      description:
        "List the models reachable right now, per provider: live from each provider whose API key is configured, from the local Ollama daemon, and the subscription model when subscription mode is on. Providers without a key come back as 'skipped' naming the variable to set. Each provider entry also carries 'context_window' \u2014 the token window per listed model, straight from the provider when it reports one (OpenRouter's context_length, or max_input_tokens/context_window elsewhere) or from the last successful fetch cached on disk; a model whose window is unknown reports null, never a guess. Also returns the operator's tier map (small|medium|big) \u2014 prefer naming a TIER over a hard-coded slug. It starts no session and spends no tokens, but it does write: each live fetch is merged into ~/.lohra/context-windows.json so a later call can fall back to it.",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "Only this provider (e.g. 'openai', 'ollama'). Omit for all.",
          },
          query: {
            type: "string",
            description: "Case-insensitive substring filter on model ids.",
          },
          limit: {
            type: "integer",
            description:
              "Max ids reported per provider (default 25, max 100). The real total is always reported, so nothing is cut silently.",
          },
        },
      },
      name: "list_models",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Read the turns a still-running orchestration leaf has already committed — while it keeps working. 'Committed' means assented turns only: the turn currently in flight is never included (it isn't durable yet). Unlike workflow_audit, this is NOT metadata-only: a 'tool' turn's content is the raw, unredacted tool output the leaf actually saw. sub_id must be a leaf that belongs to run_id, verified via that run's audit ledger (a leaf.started event for this sub_id) — if the audit trail is disabled, its queue dropped the event, or retention already pruned the run, this returns the same named error as a genuinely unrelated sub_id, fail-closed rather than trusting an unverifiable claim. content is truncated to a shared max_chars budget across all returned turns, spent from the MOST RECENT turn backward (default 4096, max 32768; truncated reports whether anything was cut) — so the tail of the conversation is never cut BECAUSE OF older turns, and it is the OLDEST turns within the window that come back with content:'' when the budget runs out (the most recent turn itself is still sliced if it alone overruns the whole budget). Only the MOST RECENT 200 turns are ever returned; truncated_turns reports whether older ones were dropped.",
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description: "The run this leaf was spawned from.",
          },
          sub_id: {
            type: "string",
            description: "The leaf's own session id (from workflow_audit's leaf.started events).",
          },
          max_chars: {
            type: "integer",
            minimum: 1,
            description:
              "Shared content budget across every turn (default 4096, clamped to 32768).",
          },
        },
        required: ["run_id", "sub_id"],
      },
      name: "workflow_leaf_read",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Steer a live workflow leaf: deliver an operator message to the node's leaf right now, without waiting for it to fail or ask a question. Name the leaf with EXACTLY ONE of node_id or sub_id — node_id resolves through the run's currently live leaves (never a finished one), and refuses if that node has more than one live leaf right now (a fan-out mid-flight): use sub_id (from workflow_audit's leaf.started events) to disambiguate. An unknown run_id, a node_id with no live leaf, or a sub_id that isn't a live leaf of this run all come back as a named error rather than a silent no-op. The message itself is never written to the audit ledger (workflow_audit only ever shows leaf.steered{source:'operator', message_chars}) — only its length is.",
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description: "The run whose live leaf gets steered.",
          },
          node_id: {
            type: "string",
            description:
              "The node whose (single) live leaf to steer. Mutually exclusive with sub_id.",
          },
          sub_id: {
            type: "string",
            description:
              "The leaf's own session id (from workflow_audit's leaf.started events), when node_id alone would be ambiguous. Mutually exclusive with node_id.",
          },
          message: {
            type: "string",
            description: "The operator message to deliver to the leaf's next turn.",
          },
        },
        required: ["run_id", "message"],
      },
      name: "workflow_steer",
    },
  },
  {
    type: "function",
    function: {
      description:
        "Dry-run a resume of a workflow run WITHOUT spending a token, without writing anything, and without consuming one of the run's 3 route pivots — what would replay from cache, what would re-spawn, and why. Reports, per top-level node: 'replay' (a cached cell owns it), 'recompute' with a 'reason' ('never_completed' — the node has no cached cell at all — or 'identity_changed' — it completed before, but under a DIFFERENT route/identity), 'checkpoint_pending' (waiting on an answer, unless the pending checkpoint has a 'default', which this preview applies the same way a real resume would), 'upstream_missing' (a dependency never produced a value), 'token_budget_exhausted' (the run is already at or past its cap), or 'unknown' (an engine fault, or a nested 'workflow' node with no template loader wired — not yet in this process). A 'workflow' node that DID run nested reports {outcome:'nested', cells_replayed, cells_to_recompute, leaves_to_spawn} aggregated, never its internal nodes. Top-level totals: cells_replayed, tokens_saved (from the hits), leaves_to_spawn, estimated_tokens_to_repay (leaves_to_spawn times this run's own measured average tokens per costed cell — null with estimate_basis null when the run has never costed a single cell), route_applied, and pivots_used (pivots already spent — unaffected by this call). 'route' is the SAME shape run_workflow's own accepts ({provider?, model?}) and prices a HYPOTHETICAL pivot on THIS run's persisted spec without ever writing it, spending a token, or counting against the run's 3-pivot cap — call this BEFORE run_workflow(resume_run_id=..., route=...) to see what it would cost first. Refuses a run that is genuinely live under an unexpired lease (poll workflow_status instead); an orphaned run (status 'running' with an expired lease) previews fine, same as a real resume would accept it.",
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description: "The workflow run to preview a resume of.",
          },
          route: {
            type: "object",
            description:
              "Same shape as run_workflow's own 'route': {provider?, model?}. Prices this hypothetical pivot without applying it, spending a token, or consuming one of the run's 3 pivots.",
          },
        },
        required: ["run_id"],
      },
      name: "workflow_preview",
    },
  },
] as const satisfies readonly ToolDefinition[];
