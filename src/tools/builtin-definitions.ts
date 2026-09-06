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
        "Delegate one or more self-contained subtasks to fresh, isolated subagents and wait for their results. Each subagent starts with no knowledge of this conversation, so every task string must be fully self-contained. Each result carries a 'sub_id' \u2014 to continue that subagent later (it keeps its own history), call delegate_task again with 'resume_id' set to that sub_id and a single follow-up instruction in 'tasks'.",
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
        "Run a dynamic multi-agent workflow you author as a declarative spec \u2014 a DAG of sub-agents that pursues a goal autonomously. 'spec' is an object with meta{name}, optional schemas{NAME: <json-schema>}, and a 'nodes' list; every node is {id, type, ...fields}. The node types are a CLOSED set of 10:\n- agent: one leaf prompt. Add 'schema' (inline JSON-Schema) or 'schema_ref' (a name from schemas) to get validated JSON back instead of prose.\n- parallel: barrier fan-out over 'branches' (a list of nodes) \u2014 all of them finish before anything downstream runs.\n- pipeline: 'items' (a list or a ${ref}) x 'stages' (agent-shaped stages). Each item flows through the stages on its own, with no barrier between items \u2014 use this, not parallel, for per-item processing.\n- loop_until_dry: repeat 'body' until 'stop_after_k_empty' rounds come back empty, capped by 'max_rounds'.\n- verify: adversarial check \u2014 'skeptics' sub-agents try to refute 'finding' (optional 'lenses'); a majority refutation kills it.\n- judge_panel: 'attempts' are scored by 'judges' independent judges, and the winner is rewritten by the 'synthesize' prompt.\n- workflow: run a saved template by 'ref' as a nested sub-workflow.\n- gate: draft 'body' (agent-shaped), have a reviewer leaf judge it against 'validator', and re-draft with its feedback until it passes ('attempts', default 2) \u2014 the cheap way to hold one answer to a standard.\n- completeness_check: audit 'results' against 'task'; returns {complete, missing} \u2014 pair it with loop_until_dry to keep digging.\n- checkpoint: ask a HUMAN 'prompt' and PAUSE the run (it spawns nothing); resume with checkpoint_answers={id: answer}, or give it a 'default'.\nAgent and rigor nodes (verify, judge_panel, loop_until_dry, gate, completeness_check) may name a portable 'tier' (small|medium|big) instead of a 'model' slug \u2014 the operator maps it, and one resolved routing applies to every leaf the node spawns. An explicit 'model' wins over the tier. Put the knobs on the NODE: one level down, inside 'body'/'synthesize'/'branches'/'stages', a routing knob is silently ignored (no error, no fault) and those leaves bill the session's own model.\nBefore naming a 'model' or a 'provider' on a node, call list_models \u2014 it reports what is REACHABLE right now plus the operator's tier map. Never invent a slug: only 'tier' is a closed enum, and 'model'/'effort'/'provider' are free fields nothing validates \u2014 the catalog is information, not an allow-list. Nodes in the SAME DAG may name DIFFERENT providers, including 'openai-codex' (the subscription \u2014 refused unless the human enabled it AND prefers it, and a refused node just comes back null) beside an API-key one. If the user asked to CONFIRM the assignment, put a checkpoint presenting the plan (node -> model/provider) before the expensive nodes; on automatic, assign straight from the tiers and the catalog and don't stop to ask.\nA leaf (or pipeline stage) that dies with 'max_iterations (N) reached' needs a bigger 'max_iterations' (1-128, default 50), not a longer 'timeout'.\nReference an earlier node's output with ${node.field} and the run inputs with ${args.x} \u2014 plain dotted paths only, never expressions. Use 'depends_on' to order nodes that share no data ref.\nA complete valid spec: {\"meta\":{\"name\":\"triage-bugs\"},\"schemas\":{\"FINDING\":{\"type\":\"object\",\"properties\":{\"bug\":{\"type\":\"string\"}}}},\"nodes\":[{\"id\":\"scan\",\"type\":\"agent\",\"prompt\":\"Name the worst bug in ${args.dump}.\",\"schema_ref\":\"FINDING\"},{\"id\":\"check\",\"type\":\"verify\",\"finding\":\"${scan.bug}\",\"skeptics\":3},{\"id\":\"report\",\"type\":\"agent\",\"depends_on\":[\"check\"],\"prompt\":\"Write a fix plan for ${check.finding}.\"}]}\nReturns a run_id immediately \u2014 poll it with workflow_status ('wait' blocks) and abort with workflow_cancel. Reach for verify nodes for adversarial checking and agent schemas for structured output. TIP: call workflow_templates FIRST \u2014 adapt a proven template instead of authoring from scratch whenever one fits the task shape.\nRe-running is cheap: run_workflow(resume_run_id=...) replays the cells that already completed and only re-spawns what died. A 'paused' status means the run stopped RESUMABLY, not that the spec failed \u2014 it keeps its finished nodes. Provider quota: it auto-resumes itself, so don't cancel it. Spent 'token_budget' (the optional cap on what the whole run may spend, reported back as {total, spent, remaining}): it will not \u2014 resume it with a bigger one.\nWhile a run is in flight you can always look: workflow_status reports live 'progress' per node, workflow_list shows every run at once, and workflow_pause stops one resumably (nothing in flight is thrown away).\nFor choosing between the node types, sizing the fan-out and reading the rollup honestly, load the workflow-authoring skill first.",
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
              'Answers for the \'checkpoint\' nodes a previous stretch of this run paused on, keyed by node id: {"approve": "yes"}. Each answer becomes that node\'s output and is cached, so the same question is never asked twice.',
          },
          token_budget: {
            type: "integer",
            description:
              "Cap the tokens this whole run may spend. Checked before every leaf spawn; overrunning pauses the run instead of truncating it. On a resume the tally continues, so pass a bigger number than the 'spent' workflow_status reported (omit to keep the old cap).",
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
        "Poll a workflow run's status/outputs by its run_id. 'wait' blocks until done. 'progress' is live even mid-run \u2014 {done, running, pending, total} plus a per-node list (pending/running/complete/null, and settled items for a pipeline) \u2014 so a long run is never a black box. status 'paused' means the run stopped resumably, not that the spec failed: the reply carries reason/resume_at/attempts and the finished nodes are kept. reason 'quota_exhausted' (the provider) retries itself \u2014 resume it early with run_workflow(resume_run_id=...). reason 'token_budget_exhausted' never does: compare 'token_budget' {total, spent, remaining} and resume with a bigger cap. reason 'checkpoint' is waiting on YOU: the reply carries checkpoint{node_id, prompt, default?} \u2014 answer it with run_workflow(resume_run_id=..., checkpoint_answers={node_id: answer}). A run still marked 'running' with 'stale' true is one whose process was lost \u2014 resume it; its finished cells replay.",
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
      description: "Cancel a running workflow by its run_id.",
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
        "List validated workflow templates (proven specs to adapt), or fetch one by 'name' to get its full spec. Prefer adapting a template over authoring fresh.",
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
        "Read the durable metadata-only audit trail for one workflow run. This is a local SQLite query: it creates no provider client and spends no model tokens. Events are chronological and paginated by durable seq. Reuse the returned snapshot_seq for stable pagination; omit it with after_seq to follow a live tail. Filters affect event rows, never integrity notices.",
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
        "List the models reachable right now, per provider: live from each provider whose API key is configured, from the local Ollama daemon, and the subscription model when subscription mode is on. Providers without a key come back as 'skipped' naming the variable to set. Also returns the operator's tier map (small|medium|big) \u2014 prefer naming a TIER over a hard-coded slug. Read-only: it starts no session and spends no tokens.",
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
] as const satisfies readonly ToolDefinition[];
