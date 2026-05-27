# Migration

LocalCode can import your existing conversations from other CLI tools so
you keep one continuous history when you switch over. v1 supports
[Claude Code](https://docs.anthropic.com/claude/docs/claude-code).

## Quick start

```sh
# Inside any LocalCode session:
/import claude-code           # opens an interactive overlay (or prints the
                              # plan when the host has no overlay support)
/import cc                    # alias for `/import claude-code`
/import claude-code all       # non-interactive: import every found session
```

On first launch, if LocalCode detects sessions under `~/.claude/projects/`
and you have no LocalCode sessions yet, it offers a one-time prompt:

- `Y` opens the import flow,
- `N` (or Esc) dismisses for this launch only,
- `X` dismisses permanently (the `migration.claudeCodeDismissed` flag is
  persisted in `~/.localcode/config.toml`).

## Where Claude Code stores its data

Claude Code persists each conversation as one JSONL file:

```
~/.claude/projects/
  -Users-foo-Documents-myrepo/
    abcd1234-….jsonl
    efgh5678-….jsonl
  -Users-foo-otherproj/
    ijkl9012-….jsonl
```

- Each subdirectory is one project. Claude Code mangles the absolute
  path by replacing every `/` with `-` (`/Users/foo/myrepo` →
  `-Users-foo-myrepo`). LocalCode reverses this for display only —
  paths with literal `-` characters in their components remain
  ambiguous, but the reconstruction produces a usable label.
- Each `.jsonl` file is one session. The filename without the
  extension is the source session id.
- Override the scan root with `$CLAUDE_HOME` (default `~/.claude`).

## What gets mapped

| Claude Code event   | LocalCode role / shape                                |
| ------------------- | ----------------------------------------------------- |
| `user`              | `Message{role: 'user'}` — `content` flattened to text |
| `assistant`         | `Message{role: 'assistant'}` — text + tool_use blocks |
| `tool_use` block    | `Message.toolCalls[]` entry with mapped name          |
| `tool_result` event | `Message{role: 'tool', toolCallId: <tool_use_id>}`    |
| `system`, `summary` | skipped (LocalCode does not persist these)            |
| `thinking` blocks   | dropped (LocalCode renders thinking from `<think>` markers in assistant text instead) |

### Tool-name mapping

Claude Code uses CamelCase tool names; LocalCode uses snake_case. The
mapper in `src/migration/tool-map.ts` rewrites them on import so the
chat log surfaces consistent names. Unknown tool names are passed
through unchanged with a one-line warning so you can search and
remap manually if you ever revive an old turn.

| Claude Code | LocalCode      |
| ----------- | -------------- |
| `Read`      | `read_file`    |
| `Edit`      | `edit_file`    |
| `Write`     | `write_file`   |
| `Bash`      | `run_command`  |
| `Glob`      | `glob_search`  |
| `Grep`      | `glob_search` (best-effort; consider switching to your own pattern after import) |
| `LS`        | `list_dir`     |
| `TodoWrite` | `todo_write`   |
| ...         | (everything else passes through as-is) |

## What is preserved

- **Message content** — text bodies, in order.
- **Tool calls + tool results** — full `arguments` payload (untouched
  JSON), `tool_use_id` ↔ `tool_call_id` link.
- **Timestamps** — each event's `timestamp` becomes `Message.createdAt`.
- **Model** — assistant messages keep their `model` hint when present
  so the chat UI labels them correctly.
- **First user message** — used to seed the session `title`.

## What is preserved as text only

- **Thinking** — Claude Code emits `thinking` blocks for chain-of-
  thought. LocalCode collapses them out of the imported messages
  (kept opt-in via `<think>` markers in newly streamed assistant
  text only).
- **Streaming metadata** (delta indices, partial JSON for tool
  arguments) — only the final, fully-parsed shape lands in SQLite.
- **Tool argument validation errors / retry events** — Claude Code's
  internal event stream is not part of the chat transcript.

## Duplicate detection

When LocalCode imports a session, it tags the new row's `summary`
column with `importedFrom:claude-code:<source-session-id>`. A
re-import of the same `.jsonl` file is refused with:

```
already imported: <source-session-id>
```

The dedup scan is bounded to the most recent 200 sessions — if your
LocalCode DB exceeds that you can still force a fresh import by
deleting the existing session via `/resume` → Delete first.

## Robustness

- The importer **streams** the JSONL file rather than reading it whole
  — even multi-megabyte Claude Code sessions stay under a few hundred
  KB of RAM.
- **Malformed lines** (truncated JSON, mid-stream artefacts) are
  skipped with a `console.warn`. The rest of the file imports cleanly.
- **Per-session failures** in `importAll` are aggregated as `errors[]`
  and never abort the loop — a single corrupt `.jsonl` does not
  prevent the rest of your sessions from coming across.
- **No network**, **no LLM calls**. Pure local file → SQLite.

## Inspecting what was imported

```sh
# Open the in-session resume picker; imported rows show with their
# original title alongside the importedFrom: marker in their summary.
/resume

# Or query SQLite directly for the dedup marker.
sqlite3 ~/.localcode/sessions.db \
  "SELECT id, title, summary FROM sessions WHERE summary LIKE 'importedFrom:claude-code:%';"
```

## Limitations

- The original Claude Code session id is preserved only inside the
  summary marker — LocalCode mints its own UUID for the new session.
- Branch / fork relationships from Claude Code (if any) are not
  reconstructed; each `.jsonl` imports as a fresh top-level session.
- Workspace state, MCP server config, and skills are NOT migrated —
  only chat conversations. Re-add MCP servers via `/mcp browse` and
  skills via `/skills browse` / project-local `.localcode/skills/`.
