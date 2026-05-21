# Skills

Skills are markdown files concatenated into the system prompt of
every LLM turn. They're how you teach LocalCode about coding
conventions, project-specific rules, or your favourite testing style.

## Where skills live

LocalCode reads skills from **two** locations and merges them with a
clear precedence:

| Location | Path | Priority |
| --- | --- | --- |
| Project-local | `<projectRoot>/.localcode/skills/*.md` | **Highest** — wins on id collision. |
| Global | `~/.localcode/skills/*.md` | Fallback. |

The `id` of a skill is its filename without the `.md` extension. If
both `~/.localcode/skills/tdd.md` and
`<projectRoot>/.localcode/skills/tdd.md` exist, the project-local
copy is used and the global one is hidden from the listing.

The active state (which skills are enabled) is persisted in JSON next
to the writable directory:

| When you have a project root | When you don't |
| --- | --- |
| `<projectRoot>/.localcode/skills-active.json` | `~/.localcode/skills-active.json` |

Both files contain a sorted JSON array of active skill ids:

```json
[
  "code-review",
  "tdd"
]
```

## Anatomy of a skill file

A skill is plain markdown with optional YAML-style frontmatter:

```md
---
name: TDD style
description: How I want tests written.
---

Always start by writing a failing test, then implement, then refactor.
Avoid mocking objects you own. Prefer table-driven tests when feasible.

When a bug is reported, write a regression test first.
```

Frontmatter rules:

- Must open with `---` on its own line and close with `---` on its
  own line.
- Only `name:` and `description:` are recognised. Other keys are
  ignored (no error).
- Wrapping single or double quotes are stripped.
- No nested objects, arrays, or multi-line scalars.

If frontmatter is missing or malformed, the parser falls back to:

- `name` = the filename stem (`my-skill.md` → `my-skill`).
- `description` = `""`.
- Body = the entire file.

The implementation lives in
[`src/skills/skill-parser.ts`](../src/skills/skill-parser.ts) (purely
zero-dep — no `gray-matter` / `yaml` package).

## How skills compose into the system prompt

`ContextManager.buildSystemPrompt` accepts an `{ skills }` array and
appends an `## Active skills` section that concatenates each active
skill's body, separated by `\n\n---\n\n`. Inactive skills are skipped.
A skill with empty content is also skipped.

```text
…

## Active skills
[ACTIVE SKILLS]
<body of skill 1>

---

<body of skill 2>
```

When no skills are active, the section reads `(none)`.

## Adding skills

### From the UI

- `/skills` opens `SkillsScreen`. Press `a` to import a `.md` file by
  path; the file is **copied** into the writable directory
  (project-local by default), not symlinked.
- `/new-skill` opens `SkillInputOverlay`. You can paste body text and
  give it a filename, or supply an existing `.md` path.

### By dropping a file

Both directories are watched with `chokidar` (`add` / `change` /
`unlink`). Just save a file under either `skills/` directory and
LocalCode picks it up on the fly — no restart needed.

### Programmatic API

```ts
import { SkillsManager } from '@/skills/skills-manager';

const sm = new SkillsManager({ projectRoot: process.cwd() });

await sm.addFromText('tdd.md', '---\nname: TDD\n---\nrules go here');
await sm.toggle('tdd');                  // mark active
const skills = await sm.list();          // [{ id: 'tdd', active: true, ... }]
const prompt = await sm.buildSkillsPrompt();
```

`SkillsManager` constructor shapes:

```ts
new SkillsManager()                                      // global only
new SkillsManager({ projectRoot, configManager? })       // two-source (preferred)
new SkillsManager(legacyDir, legacyConfigManager?)       // sole-source backward-compat
```

The two-source form returns `Skill.source: 'project' | 'global'` so
the UI can label where each one came from.

## Toggling

`/skills` → highlight a skill → `space` to toggle.
Programmatically: `await sm.toggle('id')`.

The toggle goes through `loadActiveSet → mutate → persistActiveSet`,
which atomically writes the JSON file via temp + rename.

## Deleting

`/skills` → highlight → `d`. Or `await sm.delete('id')`.

The manager deletes from the **highest-priority source** that has the
file (project-local first). The sidecar JSON entry is removed if it
was active. There is no undo — the markdown is unlinked from disk.

## Active state edge cases

- A skill that exists in `skills-active.json` but no longer has a
  matching `.md` is silently inactive (not an error).
- `loadActiveSet` is forgiving: corrupt JSON resets to an empty set
  rather than crashing.
- Persist is atomic (temp file + rename) so a crash mid-write doesn't
  leave a malformed file.

## File-watching internals

`App.useEffect` registers a single `chokidar.watch([projectDir,
globalDir], { ignoreInitial: true, depth: 1 })`. Every event triggers
`skillsManager.list()` and `setSkills(next)`, then a re-render. The
watch is `persistent: true` and is cleaned up on `App` unmount.

## Recommended skill set

A few skill files that are useful in most projects (suggestions —
LocalCode does not bundle them):

- `style.md` — style/lint conventions ("never use `any`", "prefer
  named exports").
- `architecture.md` — how the codebase is organised, where modules
  live.
- `testing.md` — your testing philosophy + framework idioms.
- `domain.md` — domain language: what does "Job", "Pipeline", or
  "Ledger" mean in this codebase?

Per-project skills shadow global, so you can keep a baseline global
skill set and override pieces per project.
