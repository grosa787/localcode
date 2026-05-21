# Tools

LocalCode exposes eight tools to the model via the OpenAI-style
function-calling format. Schemas live in
[`src/llm/tools-schema.ts`](../src/llm/tools-schema.ts); implementations
live under [`src/tools/`](../src/tools/).

| Tool | Implementation | Phases | Approval default |
| --- | --- | --- | --- |
| [`read_file`](#read_file) | `tools/read-file.ts` | preview-only | none |
| [`list_dir`](#list_dir) | `tools/list-dir.ts` | preview-only | none |
| [`glob_search`](#glob_search) | `tools/glob-search.ts` | preview-only | none |
| [`edit_file`](#edit_file) | `tools/edit-file.ts` | preview + commit | none (audited via diff) |
| [`write_file`](#write_file) | `tools/write-file.ts` | preview + commit | required |
| [`run_command`](#run_command) | `tools/run-command.ts` | preview + commit | required |
| [`fetch_image`](#fetch_image) | `tools/fetch-image.ts` | preview-only | required |
| [`lint_file`](#lint_file) | `tools/lint-file.ts` | preview-only | none |

## Approval flow

`ToolExecutor.requiresApproval(name)` (see
`src/llm/tool-executor.ts`) returns `true` unless:

- `dangerouslyAllowAll` is set (CLI `--dangerously-allow-all`), OR
- the tool is in `config.permissions.autoApprove` (`/permissions add
  <tool>`).

`APPROVAL_REQUIRED_TOOLS` is the executor's source of truth for which
tools normally gate; today it lists `write_file` and `run_command`. The
tool wrappers also tag their own preview results with
`requiresApproval: true` so a non-default executor still gets the
hint. `fetch_image` is a network side-effect and additionally surfaces
`requiresApproval: true` from its preview.

When a gated tool fires:

1. `ToolExecutor.execute` calls the configured `approvalCallback`.
2. `App` builds a `PendingApproval` (kind `diff` for write/edit,
   `command` for run_command, `generic` otherwise) and dispatches
   `SET_PENDING_APPROVAL`.
3. `<ApprovalPrompt>` renders the diff or command summary.
4. The user's `Yes` / `No` resolves the pending Promise.
5. On `Yes`, the tool's `commit` runs (write_file / edit_file /
   run_command). On `No`, the executor returns
   `success: false, error: "User rejected …"`.

Read-only tools and `edit_file` skip the prompt entirely; `edit_file`
still emits the diff in its preview output, which is rendered as an
`InlineDiffView` under the `ToolCallBlock`.

## Auto-lint hook (FIX #27)

After a successful `write_file` or `edit_file` commit on a lintable
extension (`.ts/.tsx/.js/.jsx/.py/.go/.rs`), the executor invokes
`lint_file` and surfaces the result as a synthetic `tool`-role message
via `onAutoCheckResult`. The composition root pipes that into both
`ContextManager` (so the next model turn can self-correct) and the
`ChatScreen` (so the user sees the lint output).

Disable via `new ToolExecutor({ autoLintAfterWrite: false })` or
override entirely with `setPostCommitHook(fn)`.

---

## `read_file`

Read a project file's contents.

- **Args:** `{ path: string }` — relative to `projectRoot`.
- **Returns:** full UTF-8 text, or for files larger than 100 KB the
  first 500 lines plus a truncation banner.
- **Safety:** `path` is resolved with `path.resolve` and rejected if
  the result escapes `projectRoot`. Symlinks are followed by `fs.stat`;
  the path-normalisation guard still catches escape attempts.

```jsonc
// Tool call
{ "name": "read_file", "arguments": { "path": "src/cli.tsx" } }
```

## `list_dir`

Tree-list a directory.

- **Args:** `{ path?: string }` — defaults to `projectRoot`.
- **Returns:** human-readable indented tree.
- **Filters:** depth ≤ 5, built-in ignores (`node_modules`, `.git`,
  `dist`, `build`, `.cache`, `.localcode`), plus minimal gitignore
  matching for literal names, `*.ext` patterns, and `dir/` entries.

```jsonc
{ "name": "list_dir", "arguments": { "path": "src" } }
```

## `glob_search`

Find files matching a glob.

- **Args:** `{ pattern: string, cwd?: string }`.
- **Returns:** up to 100 paths, sorted; if the limit is hit the
  output ends with a "…truncated" hint.
- **Excludes:** `node_modules/**`, `.git/**`, `dist/**`, `build/**`.
- **Engine:** `fast-glob` with `dot: false` defaults.

```jsonc
{ "name": "glob_search", "arguments": { "pattern": "src/**/*.ts" } }
```

When zero matches come back, the tool returns a friendly suggestion
to broaden the pattern instead of an empty success.

## `edit_file`

Surgical search/replace in an existing file.

- **Args:** `{ path: string, find_text: string, replace_text: string }`.
- **Phase 1 (preview):** reads the file, ensures `find_text` appears
  exactly once, computes a unified diff, and returns it with
  `requiresApproval: true`.
- **Phase 2 (commit):** re-reads the file, re-validates uniqueness
  (defends against the file changing between preview and commit), and
  writes the result.

Failure modes:

- 0 matches → `find_text not found in <path>. Tip: include surrounding
  whitespace.`
- 2+ matches → `find_text matches N locations; it must be unique.`
- File missing → `File not found: <path>. Use write_file to create it.`

```jsonc
{
  "name": "edit_file",
  "arguments": {
    "path": "src/llm/adapter.ts",
    "find_text": "const STALL_TIMEOUT_MS = 90_000;",
    "replace_text": "const STALL_TIMEOUT_MS = 120_000;"
  }
}
```

## `write_file`

Replace a file's entire contents (or create it).

- **Args:** `{ path: string, content: string }`.
- **Phase 1:** computes a unified diff against the existing file (or
  shows it as `(new file)` for creations).
- **Phase 2:** creates parent directories if missing, writes the
  full content. Returns `Wrote N bytes to <path>`.
- **Approval:** required by default. Pre-authorise with
  `/permissions add write_file`.

The diff returned by phase 1 is also persisted on the
`ToolCallState.diffPreview` field so `<InlineDiffView>` can render it
beneath the tool-call block.

## `run_command`

Execute a shell command.

- **Args:** `{ command: string, cwd?: string }`.
- **Phase 1:** prints `Will run: <cmd>` + `In: <cwd>`.
- **Phase 2:** `execa('sh', ['-c', command])` with a 30-second timeout.
- **Returns:** stdout (and stderr appended after `[stderr]` when
  non-empty). Non-zero exit code → `success: false, error: "Exit N: …"`.
- **Timeout:** `Command timed out after 30s` on hit.

```jsonc
{ "name": "run_command", "arguments": { "command": "bun test" } }
```

## `fetch_image`

Download an image and base64-encode it for vision-capable models.

- **Args:** `{ url: string, description?: string }`.
- **Allowed schemes:** `http://`, `https://`, `data:image/<type>;base64,…`.
- **Allowed MIME types:** `image/png`, `image/jpeg` (`image/jpg`),
  `image/gif`, `image/webp`.
- **Limits:** 10 MB after decode, 10-second network timeout.
- **Returns:** JSON envelope
  `{ kind: "image", mimeType, dataBase64, byteLength }` in `output`.

`App.onSubmit` watches user input for an image URL regex and adds a
hint to the system prompt nudging the model toward `fetch_image`. After
a successful fetch, `App.runStreamLoop` splices a multimodal user
message (`buildImageMessage`) into context so the next turn analyses
the image.

```jsonc
{ "name": "fetch_image", "arguments": { "url": "https://example.com/screenshot.png" } }
```

## `lint_file`

Run a language-native syntax/type check on a single file.

- **Args:** `{ path: string }`.
- **Dispatch:**

  | Extension          | Linter                                                      |
  | ------------------ | ----------------------------------------------------------- |
  | `.ts/.tsx/.js/.jsx`| `bunx tsc --noEmit --pretty false [--project|<path>]`       |
  | `.py`              | `ruff check … --output-format json` → fallback `python -m py_compile` |
  | `.go`              | `go vet <abs>` + `gofmt -l <abs>`                           |
  | `.rs`              | `rustc --edition 2021 --emit=dep-info -o /dev/null <abs>`   |
  | other              | skip with `No linter configured for <ext>; skipping.`       |

- **Subprocess timeout:** 15 s per linter run.
- **Behaviour:** never fails; if a binary is missing, returns
  `success: true` with `Linter for <lang> not installed; skipping check.`
  This keeps the model's auto-fix loop from getting stuck on missing
  toolchains.

The output format is uniform: `No issues found.` or
```
Found N diagnostics:
  ERROR <line>:<col> [code] <message>
  WARNING <line>:<col> <message>
```

## Argument validation

Every tool wraps its arg parsing in a Zod schema (`*ArgsSchema` exports
under `src/tools/`). Failed validation returns
`{ success: false, error: "Invalid args: <messages>" }` so the model
can self-correct on the next turn.

## Path-traversal guard

All filesystem tools (`read_file`, `write_file`, `edit_file`,
`list_dir`, `lint_file`) call a private `resolveInsideRoot(root,
target)`. The helper resolves the target absolutely and ensures
`path.relative(root, target)` neither starts with `..` nor is
absolute. Any escape attempt becomes `Path traversal blocked`.

## Tool registry contract

`createToolHandlerMap(ctx)` returns `Record<name, { preview, commit? }>`.

- Read-only tools omit `commit`; their `preview` does the work.
- Mutating tools split into a no-side-effect `preview` and a
  side-effecting `commit`. The flat adapter inside `App` honours that
  split: it runs `preview`, lets `ToolExecutor` handle approval, and
  then runs `commit` if the preview succeeded.
- All eight tools are exported individually so external host
  applications (tests, alternate hosts) can wire a subset.

See [docs/CONFIG.md](CONFIG.md#permissions) for the
auto-approve schema, and [docs/COMMANDS.md](COMMANDS.md#permissions)
for the user-facing knob.
