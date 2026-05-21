#!/usr/bin/env bash
#
# strip-public-repo.sh — convert the public repo checkout into a
# distribution-only shell.
#
# This is a more focused sibling of `migrate-to-private.sh`. The migration
# script does this AND pushes to a private repo AND creates a cleanup
# branch. Use this one when you've already pushed source to the private
# repo and just want to surgically remove source from the public checkout
# on a fresh branch / in CI / for review.
#
# Default = DRY-RUN. Pass --apply to actually `git rm` the files.
# Pass --no-commit to stage the removals but skip the final commit.
#
# Idempotent: re-running after a successful strip is a no-op (files are
# already gone; nothing to remove).

set -euo pipefail

APPLY=0
COMMIT=1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --no-commit) COMMIT=0 ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--apply] [--no-commit]

  Strips source code, internal docs, build configs, and dev artefacts
  from the current checkout. Leaves the distribution shell: README,
  install.sh, LICENSE, docs/, website/, packages/npm/, packaging/,
  .github/workflows/ (release/packages/pages/lockdown).

  --apply       actually run git rm (default is dry-run).
  --no-commit   stage the removals but do not commit.

  Safe to re-run; second pass detects missing files and skips.
EOF
      exit 0 ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 1 ;;
  esac
done

run() {
  if [ "$APPLY" -eq 1 ]; then
    echo "+ $*"
    "$@"
  else
    echo "[dry-run] $*"
  fi
}

cd "$REPO_ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: not inside a git repo." >&2
  exit 1
fi

if [ ! -f package.json ] || [ ! -d src ]; then
  echo "Warning: src/ already absent. The repo may already be stripped." >&2
  echo "         (Continuing — operation is idempotent.)" >&2
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree is dirty. Commit or stash before stripping." >&2
  exit 1
fi

echo "=== strip-public-repo.sh ==="
echo "Mode: $([ "$APPLY" -eq 1 ] && echo APPLY || echo DRY-RUN)"
echo "Root: $REPO_ROOT"
echo

# What we strip:
#   1. ALL TypeScript / TSX source (the main thing we want gone).
#   2. Tests + build configs (without source they're useless).
#   3. Internal docs (architecture, dev plans, history).
#   4. Local agent / IDE artefacts (.omc, .claude).
#   5. Pre-built dist (will come from Releases instead).
#   6. CI workflow that builds source (replaced by minimal CI for shell).
TO_REMOVE_DIRS=(
  "src"
  "tests"
  "web-frontend/src"
  "web-frontend/tests"
  "web-frontend/public"
  "docs/ARCHITECTURE.md"
  ".omc"
  ".claude"
  "dist"
  "dist-web"
  "node_modules"
  "website/node_modules"
  "web-frontend/node_modules"
)
TO_REMOVE_FILES=(
  # Internal planning / history.
  "AGENTS_LOG.md"
  "FIXES_PLAN.md"
  "ROADMAP.md"
  "LOCALCODE_MASTER_PROMPT.md"
  "CLAUDE.md"
  # Build configs that have no meaning without src/.
  "bunfig.toml"
  "bun.lock"
  "tsconfig.json"
  # Web-frontend build configs (only kept the rendered site under website/).
  "web-frontend/package.json"
  "web-frontend/tsconfig.json"
  "web-frontend/vite.config.ts"
  "web-frontend/index.html"
  # Build-time helper that depends on src/.
  "scripts/embed-web.ts"
  # CI that requires src/ + tests/.
  ".github/workflows/ci.yml"
)

removed_count=0
for path in "${TO_REMOVE_DIRS[@]}" "${TO_REMOVE_FILES[@]}"; do
  if git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    run git rm -rf --cached -- "$path"
    removed_count=$((removed_count + 1))
  else
    # Untracked-but-present (e.g. node_modules) — try removing locally.
    if [ -e "$path" ]; then
      run rm -rf -- "$path"
    else
      echo "  skip (absent): $path"
    fi
  fi
done

# Plant a minimal CI that the distribution shell can run.
if [ "$APPLY" -eq 1 ]; then
  mkdir -p .github/workflows
  cat >.github/workflows/ci.yml <<'YML'
name: CI (distribution shell)

# Source code lives in a private repo. This CI only validates the
# distribution shell: install.sh syntax + website build.

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  shell-check:
    name: install.sh syntax
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash -n install.sh

  website-build:
    name: Website builds
    runs-on: ubuntu-latest
    if: hashFiles('website/package.json') != ''
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install
        working-directory: website
      - run: bun run build
        working-directory: website
YML
  echo "+ wrote minimal .github/workflows/ci.yml"
  run git add .github/workflows/ci.yml
else
  echo "[dry-run] would write minimal .github/workflows/ci.yml"
fi

echo
echo "Stripped $removed_count tracked path(s)."

if [ "$APPLY" -eq 1 ] && [ "$COMMIT" -eq 1 ]; then
  if ! git diff --cached --quiet; then
    run git commit -m "Strip source: distribution shell only

Source moved to a private repo. Public repo now contains only:
- README + LICENSE + install.sh (binary install entry point)
- docs/ (user-facing)
- packages/npm/, packaging/ (release shims)
- website/ (landing page)
- .github/workflows/ (release.yml, packages.yml, pages.yml, lockdown.yml)

See BUILD_FROM_SOURCE.md for contributor instructions."
  else
    echo "Note: nothing to commit — repo was already stripped."
  fi
elif [ "$APPLY" -eq 1 ]; then
  echo "Skipping commit (--no-commit). Staged changes ready for review."
fi

cat <<EOF

Next steps:
  1. git status                # inspect staged removals
  2. git diff --cached --stat  # confirm only intended files removed
  3. git push origin HEAD:strip-source
  4. gh pr create --base main --head strip-source --repo grosa787/localcode
EOF
