/**
 * OpenAI-compatible tool schemas. Sent verbatim as `tools` in the chat
 * completions body so the model knows what functions it can call.
 *
 * R27 (Agent A) — descriptions trimmed to 15-25 words each. Total tool
 * payload dropped from ~1500 tokens to ~500. Format per tool:
 *   "<verb-led action>. <key constraint>. <return shape or approval>."
 *
 * Implementations live in `src/tools/`. This file is the wire contract.
 */

import type { ToolSchema } from '@/types/message';

const readFile: ToolSchema = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      'Read file contents. Path relative to project root. Files >1MB auto-paginate (call again with offset to continue). Set respondWithSummary=true for line count + head/tail only.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to project root. ".." escapes are rejected.',
        },
        offset: {
          type: 'number',
          description:
            '1-based line number to start at. Use the value from the auto-paginate footer to fetch the next page.',
        },
        limit: {
          type: 'number',
          description:
            'Maximum number of lines to return when offset is set. Defaults to remaining file, capped internally.',
        },
        respondWithSummary: {
          type: 'boolean',
          description:
            'When true, return only line count, size, first 20 and last 5 lines. Use as a cheap overview.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

const writeFile: ToolSchema = {
  type: 'function',
  function: {
    name: 'write_file',
    description:
      'Write a file by replacing its full contents. Shows diff for user approval. Creates missing parent dirs.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Target path relative to project root.',
        },
        content: {
          type: 'string',
          description: 'Complete new file contents (not a diff).',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
};

const runCommand: ToolSchema = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      'Run shell command in project root. 30s timeout. Output capped at 50KB. Requires user approval. Set runInBackground=true to spawn async + poll via monitor.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command, e.g. "bun test".',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory relative to project root.',
        },
        runInBackground: {
          type: 'boolean',
          description:
            'When true, spawn without awaiting and return a taskId; poll status via monitor tool.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

const listDir: ToolSchema = {
  type: 'function',
  function: {
    name: 'list_dir',
    description:
      'Recursively list directory as a tree. Honours .gitignore. Skips node_modules/.git/dist. Depth capped at 5.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory relative to project root. Defaults to root.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

const globSearch: ToolSchema = {
  type: 'function',
  function: {
    name: 'glob_search',
    description:
      'Match files by glob (e.g. "src/**/*.ts"). Skips node_modules/.git. Returns up to 100 sorted paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern, e.g. "**/*.test.ts".',
        },
        cwd: {
          type: 'string',
          description: 'Optional search root relative to project root.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
};

const editFile: ToolSchema = {
  type: 'function',
  function: {
    name: 'edit_file',
    description:
      'Surgical edit: replace `find_text` with `replace_text` in path. find_text must be unique. Returns diff for approval.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to project root.',
        },
        find_text: {
          type: 'string',
          description: 'Exact text to find (must be unique in file).',
        },
        replace_text: {
          type: 'string',
          description: 'Replacement text.',
        },
      },
      required: ['path', 'find_text', 'replace_text'],
      additionalProperties: false,
    },
  },
};

const multiEdit: ToolSchema = {
  type: 'function',
  function: {
    name: 'multi_edit',
    description:
      'Apply a batch of find/replace edits to ONE file atomically. Edits run sequentially (edit N sees result of N-1). All-or-nothing: any failure aborts, file unchanged. Returns single cumulative diff for approval.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to project root.',
        },
        edits: {
          type: 'array',
          description: 'Ordered list of edits. At least one required.',
          items: {
            type: 'object',
            properties: {
              oldString: {
                type: 'string',
                description:
                  'Exact text to find. Must be unique in current content unless replaceAll is true.',
              },
              newString: {
                type: 'string',
                description: 'Replacement text. Must differ from oldString.',
              },
              replaceAll: {
                type: 'boolean',
                description:
                  'When true, replace every occurrence; otherwise oldString must be unique.',
              },
            },
            required: ['oldString', 'newString'],
          },
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },
  },
};

const fetchImage: ToolSchema = {
  type: 'function',
  function: {
    name: 'fetch_image',
    description:
      'Download image from http(s) or data URL and return base64 for vision-capable models. Requires approval.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'http://, https://, or data:image/* URL.',
        },
        description: {
          type: 'string',
          description: 'Optional hint about what to look for.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
};

const lintFile: ToolSchema = {
  type: 'function',
  function: {
    name: 'lint_file',
    description:
      'Run language-appropriate static check (tsc / ruff / vet / rustc). Auto-runs after write_file/edit_file; manual call OK.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to project root.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

const findSymbol: ToolSchema = {
  type: 'function',
  function: {
    name: 'find_symbol',
    description:
      'Find where a symbol is defined (function/class/interface/type/const/variable). Returns file:line locations.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Symbol name (case-sensitive).',
        },
        kind: {
          type: 'string',
          enum: ['function', 'class', 'interface', 'type', 'const', 'variable', 'any'],
          description: "Filter by kind. Default 'any'.",
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
};

const spawnAgentSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'spawn_agent',
    description:
      'Spawn a sub-agent on independent files. Returns agentId for await_agent / agent_status. Lead-only. Optional `template` (architect, debugger, security-reviewer, typescript-reviewer, python-reviewer, rust-reviewer, go-reviewer, test-engineer, performance-optimizer, doc-writer) preloads a specialist system prompt.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: "Worker's slice of the task." },
        files: {
          type: 'array',
          description: 'Files the worker exclusively owns (write).',
          items: { type: 'string' },
        },
        template: {
          type: 'string',
          description:
            'Optional catalog template id (e.g. "debugger"). When set, the template system prompt is prepended to `task`.',
        },
        model: { type: 'string', description: 'Optional worker model id.' },
        skills: {
          type: 'array',
          description: 'Optional skill ids to inject.',
          items: { type: 'string' },
        },
        isolation: {
          type: 'string',
          enum: ['worktree', 'shared'],
          description: "Default 'worktree' (git fork).",
        },
        timeout: { type: 'number', description: 'Seconds; default 600.' },
      },
      required: ['task', 'files'],
      additionalProperties: false,
    },
  },
};

const agentStatusSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'agent_status',
    description: 'Snapshot a sub-agent. Returns status (running/done/failed/cancelled), lastMessage, error.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Id from spawn_agent.' },
      },
      required: ['agentId'],
      additionalProperties: false,
    },
  },
};

const awaitAgentSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'await_agent',
    description: 'Block until sub-agent terminal. Returns status, summary, diff. Default timeout 600s.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Id from spawn_agent.' },
        timeoutSec: { type: 'number', description: 'Optional cap; default 600.' },
      },
      required: ['agentId'],
      additionalProperties: false,
    },
  },
};

const teamSendSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'team_send',
    description: "Broadcast/unicast on the team-bus. to='all' fans out; to=agentId direct. Caller never echoes own message.",
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: "'all' or recipient agentId." },
        message: { type: 'string', description: 'Plain-text body.' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
  },
};

const teamReadSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'team_read',
    description: 'Pull team-bus messages addressed to caller (or to=all) since cursor. Track sinceSec yourself.',
    parameters: {
      type: 'object',
      properties: {
        sinceSec: {
          type: 'number',
          description: 'Seconds-ago cursor. 0 = entire buffer.',
        },
        fromAgentId: {
          type: 'string',
          description: 'Optional sender filter.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

const webFetch: ToolSchema = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description:
      'Fetch http(s) URL. HTML→markdown; text/json verbatim; binary as stub. 500KB default, 15s timeout. SSRF-guarded.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http:// or https:// URL.',
        },
        maxBytes: {
          type: 'number',
          description: 'Optional byte cap (default 500000, hard cap 2000000).',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
};

const webSearch: ToolSchema = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web via DuckDuckGo. Returns top results {title,url,snippet} so you can pick which URL to web_fetch.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query, e.g. "rust async runtime comparison".',
        },
        maxResults: {
          type: 'number',
          description: 'Optional result cap (default 10, max 25).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

const gitStatusSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'git_status',
    description:
      'Read git working-tree state. Returns {branch, ahead, behind, staged, modified, untracked, raw}.',
    parameters: {
      type: 'object',
      properties: {
        short: {
          type: 'boolean',
          description: 'When true, raw output is the porcelain form (terser).',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

const gitLogSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'git_log',
    description:
      'Read commit history. Returns entries with {hash, message, author, date}. Default limit 20, max 200.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max commits to return. Default 20, max 200.',
        },
        path: {
          type: 'string',
          description: 'Optional path filter (commits touching this path only).',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

const gitBranchSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'git_branch',
    description: 'List local + remote branches. Returns {current, all: string[]}.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};

const gitDiffSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'git_diff',
    description:
      'Unified diff of working tree or staged changes. Capped at 100KB. Optional path filter.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional path to limit the diff to.',
        },
        staged: {
          type: 'boolean',
          description: 'When true, diff index vs HEAD instead of worktree vs index.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

const gitCommitSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'git_commit',
    description:
      'Commit staged changes (or all changes when addAll=true). Shows diff for approval. Returns commit hash.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Commit message (single line or first-line summary).',
        },
        addAll: {
          type: 'boolean',
          description: 'When true, run `git add -A` before committing.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
};

const todoWrite: ToolSchema = {
  type: 'function',
  function: {
    name: 'todo_write',
    description:
      'Replace the session task list. Each call sets the full list. Use to track complex multi-step work.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Complete replacement todo list. Each call overwrites the prior list.',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'Task description in imperative form, e.g. "Add tests for X".',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Current lifecycle state of the task.',
              },
              activeForm: {
                type: 'string',
                description: 'Present-continuous form, e.g. "Adding tests for X".',
              },
            },
            required: ['content', 'status', 'activeForm'],
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
  },
};

const notebookRead: ToolSchema = {
  type: 'function',
  function: {
    name: 'notebook_read',
    description:
      'Read a Jupyter .ipynb notebook as structured JSON: cells with index, id, cell_type, source, trimmed outputs. nbformat 4 only.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to .ipynb file, relative to project root.',
        },
        includeOutputs: {
          type: 'boolean',
          description: 'When false, omit cell outputs (default true).',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

const notebookEdit: ToolSchema = {
  type: 'function',
  function: {
    name: 'notebook_edit',
    description:
      'Two-phase edit of a Jupyter notebook cell: replace, insert, or delete. Preview returns diff; commit writes. Requires approval.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to .ipynb file, relative to project root.',
        },
        mode: {
          type: 'string',
          enum: ['replace', 'insert', 'delete'],
          description: 'Edit operation. Default "replace".',
        },
        cellIndex: {
          type: 'number',
          description:
            '0-based cell index. For insert, valid range is 0..cellCount; for replace/delete it is 0..cellCount-1.',
        },
        cellType: {
          type: 'string',
          enum: ['code', 'markdown'],
          description: "Required for mode='insert'. Cell kind to create.",
        },
        newSource: {
          type: 'string',
          description:
            "Required for mode='replace' and mode='insert'. New cell source text.",
        },
      },
      required: ['path', 'mode', 'cellIndex'],
      additionalProperties: false,
    },
  },
};

const scheduleWakeupSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'schedule_wakeup',
    description:
      'Defer your own continuation. Use only when waiting on an external event (long build, retry). delaySeconds 60-3600.',
    parameters: {
      type: 'object',
      properties: {
        delaySeconds: {
          type: 'number',
          description: 'Seconds before resuming. Range 60..3600 (clamped).',
        },
        reason: {
          type: 'string',
          description: 'Short rationale shown in the UI badge (e.g. "checking build").',
        },
        prompt: {
          type: 'string',
          description: 'Self-prompt that becomes the next user turn on wake-up.',
        },
      },
      required: ['delaySeconds', 'reason', 'prompt'],
      additionalProperties: false,
    },
  },
};

// PDF-TOOL-SECTION — schema for `read_pdf`. Single-phase, read-only.
// Coordinate edits here with `src/tools/pdf-read.ts` and the matching
// entry in `KNOWN_TOOL_NAMES` (see `src/types/message.ts`).
const readPdf: ToolSchema = {
  type: 'function',
  function: {
    name: 'read_pdf',
    description:
      'Extract text from a PDF, page by page. Path relative to project root. Optional pages spec (e.g. "1-3,5"). Caps each page at 8KB; rejects files >50MB.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to .pdf file, relative to project root.',
        },
        pages: {
          type: 'string',
          description:
            'Optional comma-separated 1-based pages or ranges, e.g. "1-3,5". Omit for the whole document.',
        },
        includeImages: {
          type: 'boolean',
          description:
            'Reserved for future image extraction. Currently inert; omitted images are flagged in the envelope.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};
// PDF-TOOL-SECTION-END

// ONTOLOGY-TOOL-SECTION — schemas for `find_call_sites`, `impacts_of`,
// `type_hierarchy`. All single-phase, read-only. Coordinate edits with
// `src/tools/{find-call-sites,impacts-of,type-hierarchy}.ts` and the
// matching entries in `KNOWN_TOOL_NAMES` (see `src/types/message.ts`).
const findCallSitesSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'find_call_sites',
    description:
      'Find every caller of a symbol via the background ontology index. Returns {matches, totalCount, truncated}. Prefer this over find_symbol when the index is ready.',
    parameters: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Bare symbol name (e.g. "doThing") or fully-qualified id.',
        },
        scope: {
          type: 'string',
          enum: ['project', 'file'],
          description: 'Optional scope hint. Default "project".',
        },
        filePath: {
          type: 'string',
          description: 'Optional substring filter on caller file path.',
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
};

const impactsOfSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'impacts_of',
    description:
      'Transitive blast-radius of a symbol. Walks reverse refs+calls+extends+implements up to maxDepth (default 3). Returns {rootSymbol, affected, totalCount}.',
    parameters: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Bare symbol name or fully-qualified id.',
        },
        maxDepth: {
          type: 'number',
          description: 'BFS depth cap (1..8). Default 3.',
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
};

const typeHierarchySchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'type_hierarchy',
    description:
      'Ancestors, descendants, and siblings of a class or interface. Returns {ancestors, descendants, siblings} — empty arrays when the ontology has no edges for the type.',
    parameters: {
      type: 'object',
      properties: {
        typeName: {
          type: 'string',
          description: 'Bare type name, e.g. "ToolExecutor".',
        },
      },
      required: ['typeName'],
      additionalProperties: false,
    },
  },
};
// ONTOLOGY-TOOL-SECTION-END

// PROCESS-STATUS-TOOL-SECTION — `process_status`. Single-phase, read-only.
// Coordinate edits here with `src/tools/process-status.ts` and the matching
// entry in `KNOWN_TOOL_NAMES` (see `src/types/message.ts`).
const processStatusSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'process_status',
    description:
      'Inspect long-running processes registered via /watch. Returns id, pid, health, exit code, and recent stdout/stderr tails. Optional id narrows to one watch.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Optional watch id returned by /watch. Omit to list every watched process.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};
// PROCESS-STATUS-TOOL-SECTION-END

const monitorSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'monitor',
    description:
      'Read status/output of a background run_command task by taskId. Optional wait (≤30s) blocks for change. killTask=true sends SIGTERM.',
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Id returned by run_command when runInBackground=true.',
        },
        wait: {
          type: 'number',
          description:
            'Optional poll-wait in ms (0..30000). Resolves on new output, status change, or timeout.',
        },
        killTask: {
          type: 'boolean',
          description: 'When true, deliver SIGTERM and return immediately.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
};

/** Canonical list of tools sent to the model on every turn. */
export const TOOLS_SCHEMA: readonly ToolSchema[] = [
  readFile,
  writeFile,
  runCommand,
  listDir,
  globSearch,
  editFile,
  multiEdit,
  fetchImage,
  lintFile,
  findSymbol,
  spawnAgentSchema,
  agentStatusSchema,
  awaitAgentSchema,
  teamSendSchema,
  teamReadSchema,
  webFetch,
  webSearch,
  gitStatusSchema,
  gitLogSchema,
  gitBranchSchema,
  gitDiffSchema,
  gitCommitSchema,
  todoWrite,
  notebookRead,
  notebookEdit,
  monitorSchema,
  scheduleWakeupSchema,
  readPdf,
  // ONTOLOGY-TOOL-SECTION
  findCallSitesSchema,
  impactsOfSchema,
  typeHierarchySchema,
  // ONTOLOGY-TOOL-SECTION-END
  // PROCESS-STATUS-TOOL-SECTION — read-only `process_status` tool.
  processStatusSchema,
  // PROCESS-STATUS-TOOL-SECTION-END
] as const;

/** Quick lookup of tool name → schema. */
export const TOOLS_BY_NAME: Readonly<Record<string, ToolSchema>> =
  Object.fromEntries(TOOLS_SCHEMA.map((t) => [t.function.name, t]));
