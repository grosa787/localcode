#!/usr/bin/env bash
#
# migrate-to-private.sh — Approach 1 helper for closing the source while
# keeping the public GitHub repo as a distribution shell.
#
# Strategy reference: /tmp/source-protection-strategy.md
#
# WHAT THIS SCRIPT DOES (default = DRY-RUN, no destructive action):
#   1. Pre-flight: gh + auth + clean tree + repo-root checks.
#   2. Creates a new private repo `grosa787/localcode-private` via `gh` (if
#      not already present).
#   3. Pushes the entire current working tree (incl. full git history) to
#      the new private repo as `main` using a temporary remote.
#   4. Generates a `migration-cleanup` branch in the *public* checkout
#      that `git rm`s the source / internal-docs / build files and leaves
#      only the "distribution shell" (README, install.sh, LICENSE,
#      website/, docs/, packages/npm/, packaging/, .github/workflows/
#      excluding ci.yml). Does NOT push or merge — you review and merge.
#   5. Installs the release-sync workflow template into the private repo
#      checkout's `.github/workflows/sync-release.yml` (the user reviews
#      then commits + pushes manually).
#
# WHAT THIS SCRIPT DOES NOT DO (deliberate, safety):
#   - Never force-pushes anything.
#   - Never deletes the public repo.
#   - Never rewrites git history on either side.
#   - Never modifies install.sh or live release URLs.
#   - Never merges the cleanup branch.
#
# Pass --apply to actually perform the migration. Otherwise it prints what
# would happen and exits clean. The script is idempotent on re-run: a
# pre-existing private repo, a pre-existing cleanup branch, or a tree with
# the closed files already removed are detected and skipped.

set -euo pipefail

APPLY=0
PUBLIC_REPO="grosa787/localcode"
PRIVATE_REPO="grosa787/localcode-private"
CLEANUP_BRANCH="migration-cleanup"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYNC_TEMPLATE="$REPO_ROOT/.github/workflows/sync-release.yml.template"

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--apply]
  Default: DRY-RUN — prints every command that would be executed.
  --apply: actually perform the migration steps (create private repo,
           push working tree, create local cleanup branch, copy
           sync-release template into private repo).

The script never force-pushes, never deletes anything on github.com,
and never merges the cleanup branch. It is safe to re-run.
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

# --- 0. Pre-flight --------------------------------------------------------

echo "=== migrate-to-private.sh ==="
echo "Mode:        $([ "$APPLY" -eq 1 ] && echo APPLY || echo DRY-RUN)"
echo "Public repo: $PUBLIC_REPO"
echo "Private repo: $PRIVATE_REPO"
echo "Repo root:   $REPO_ROOT"
echo

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI not installed. brew install gh" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "Error: not logged in. Run: gh auth login" >&2
  exit 1
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: not inside a git repo." >&2
  exit 1
fi
cd "$REPO_ROOT"

# Confirm we're at the project root.
if [ ! -f package.json ] || [ ! -d src ]; then
  echo "Error: run this from the localcode project root (must contain package.json + src/)" >&2
  exit 1
fi

# Confirm there are no uncommitted changes (we don't want surprises).
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree is dirty. Commit or stash before migrating." >&2
  exit 1
fi

if gh repo view "$PRIVATE_REPO" >/dev/null 2>&1; then
  echo "Note: $PRIVATE_REPO already exists on github.com. Will skip the create step."
  PRIVATE_EXISTS=1
else
  PRIVATE_EXISTS=0
fi

# --- 1. Create private repo ----------------------------------------------

if [ "$PRIVATE_EXISTS" -eq 0 ]; then
  echo
  echo "Step 1: Create $PRIVATE_REPO (private, empty)"
  run gh repo create "$PRIVATE_REPO" --private \
    --description "LocalCode — private source repository. Public-facing presence: grosa787/localcode."
else
  echo
  echo "Step 1: SKIP — $PRIVATE_REPO already exists."
fi

# --- 2. Push working tree to private --------------------------------------

echo
echo "Step 2: Push the working tree + full history to $PRIVATE_REPO main"
TMP_REMOTE="private-migration"
if git remote get-url "$TMP_REMOTE" >/dev/null 2>&1; then
  run git remote remove "$TMP_REMOTE"
fi
run git remote add "$TMP_REMOTE" "https://github.com/${PRIVATE_REPO}.git"
run git push "$TMP_REMOTE" HEAD:main
run git push "$TMP_REMOTE" --tags
run git remote remove "$TMP_REMOTE"

# --- 3. Build cleanup branch in PUBLIC checkout --------------------------

echo
echo "Step 3: Build a $CLEANUP_BRANCH branch with source removed (LOCAL ONLY)"
if git show-ref --verify --quiet "refs/heads/$CLEANUP_BRANCH"; then
  echo "Note: $CLEANUP_BRANCH already exists locally — switching to it."
  run git checkout "$CLEANUP_BRANCH"
else
  run git checkout -b "$CLEANUP_BRANCH"
fi

# Files & directories that must be removed from the PUBLIC repo. The
# remainder is the "distribution shell" — everything a user needs to
# install + read docs + file issues, with zero source code.
TO_REMOVE_DIRS=(
  "src"
  "web-frontend/src"
  "web-frontend/tests"
  "web-frontend/public"
  "tests"
  "docs/ARCHITECTURE.md"
  ".omc"
  ".claude"
  "dist"
  "dist-web"
)
TO_REMOVE_FILES=(
  "AGENTS_LOG.md"
  "FIXES_PLAN.md"
  "ROADMAP.md"
  "LOCALCODE_MASTER_PROMPT.md"
  "bunfig.toml"
  "bun.lock"
  "tsconfig.json"
  "scripts/embed-web.ts"
  "web-frontend/package.json"
  "web-frontend/tsconfig.json"
  "web-frontend/vite.config.ts"
  "web-frontend/index.html"
  ".github/workflows/ci.yml"
)
# Also strip any rogue top-level CLAUDE.md if it ever got committed (the
# real one lives at ../CLAUDE.md outside the public repo root; this is
# defensive).
TO_REMOVE_FILES+=("CLAUDE.md")

for path in "${TO_REMOVE_DIRS[@]}" "${TO_REMOVE_FILES[@]}"; do
  if git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    run git rm -rf --cached "$path"
  else
    echo "  skip (not tracked): $path"
  fi
done

# Replace the deleted ci.yml with a minimal one that runs on the
# distribution shell (no source = no tsc / bun test).
MIN_CI=".github/workflows/ci.yml"
if [ "$APPLY" -eq 1 ]; then
  mkdir -p .github/workflows
  cat >"$MIN_CI" <<'YML'
name: CI (distribution shell)

# The source tree lives in a private repo. This CI only validates that the
# distribution-shell files are well-formed: install.sh syntax, website
# builds, and packaging metadata is intact.

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
      - name: bash -n install.sh
        run: bash -n install.sh

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
  echo "+ wrote minimal $MIN_CI"
  run git add "$MIN_CI"
else
  echo "[dry-run] would write minimal $MIN_CI"
fi

# Commit the removal + minimal ci.yml — but never push.
if [ "$APPLY" -eq 1 ]; then
  if ! git diff --cached --quiet; then
    run git commit -m "Close source: distribution-only public repo

Source moved to grosa787/localcode-private. This commit removes the
working tree and internal docs from the public repo. The public repo
remains the canonical install + issue-tracker URL.

See BUILD_FROM_SOURCE.md for contributor instructions."
  else
    echo "Note: nothing to commit on $CLEANUP_BRANCH — already clean."
  fi
else
  echo "[dry-run] git commit -m 'Close source: distribution-only public repo'"
fi

# --- 4. Install sync-release template into private repo ------------------

echo
echo "Step 4: Place sync-release workflow into the private repo checkout"
if [ ! -f "$SYNC_TEMPLATE" ]; then
  echo "Warning: $SYNC_TEMPLATE missing — skip Step 4."
else
  TMP_PRIV_DIR="$(mktemp -d)"
  echo "  Cloning $PRIVATE_REPO -> $TMP_PRIV_DIR (shallow)"
  if [ "$APPLY" -eq 1 ]; then
    run gh repo clone "$PRIVATE_REPO" "$TMP_PRIV_DIR" -- --depth=1 || true
    if [ -d "$TMP_PRIV_DIR/.git" ]; then
      mkdir -p "$TMP_PRIV_DIR/.github/workflows"
      cp "$SYNC_TEMPLATE" "$TMP_PRIV_DIR/.github/workflows/sync-release.yml"
      echo "+ placed sync-release.yml into $TMP_PRIV_DIR/.github/workflows/"
      echo "  Review + commit + push manually from: $TMP_PRIV_DIR"
    else
      echo "  (private repo had no main branch yet — copy the template by hand once you push.)"
    fi
  else
    echo "[dry-run] would clone $PRIVATE_REPO to $TMP_PRIV_DIR and copy sync-release.yml"
    rm -rf "$TMP_PRIV_DIR"
  fi
fi

# --- 5. Next manual steps -------------------------------------------------

cat <<EOF

=== Step 3 + 4 complete (local only). Next manual steps ===

1. Inspect the cleanup branch:
     git log -1 --stat $CLEANUP_BRANCH
     git diff main..$CLEANUP_BRANCH | head -120

2. (Private repo) Review the sync-release.yml workflow at
   the temporary clone listed above. Set repo secret SYNC_TOKEN
   (PAT with 'repo' scope on $PUBLIC_REPO). Commit + push.

3. (Public repo) Push the cleanup branch and open a PR:
     git push origin $CLEANUP_BRANCH
     gh pr create --base main --head $CLEANUP_BRANCH --repo $PUBLIC_REPO

4. Cut a release in the PRIVATE repo to verify the new sync path:
     # from private repo clone
     git tag v0.20.1 && git push --tags
   The sync-release.yml workflow builds binaries and publishes
   them to $PUBLIC_REPO's Releases.

5. Verify install.sh works against the new release:
     curl -fsSL https://raw.githubusercontent.com/$PUBLIC_REPO/main/install.sh | bash

6. Merge the cleanup PR. Stars + fork tree stay intact.

ROLLBACK (any time before merging the cleanup PR):
   git checkout main && git branch -D $CLEANUP_BRANCH
   gh repo delete $PRIVATE_REPO --yes   # if you want to undo Step 1 too

This script never touched origin/main. The cleanup branch is local-only
until you 'git push origin $CLEANUP_BRANCH'.
EOF
