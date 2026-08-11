#!/usr/bin/env bash
#
# LocalCode installer. Run `./install.sh --help` (or pipe from curl with
# `| bash -s -- --help`) for the full usage text — it lives in usage()
# below, NOT in this comment block, so the two can never drift apart.

set -eu

# ---------- defaults ----------
DEFAULT_REPO="https://github.com/grosa787/localcode.git"
DEFAULT_REF_SOURCE="main"           # when building from source
DEFAULT_HOME="${HOME}/.local/share/localcode"
DEFAULT_BIN_DIR="${HOME}/.local/bin"
FALLBACK_BIN_DIR="/usr/local/bin"
MIN_BUN_MAJOR=1
MIN_BUN_MINOR=1
DEFAULT_RELEASE_BASE="https://github.com"
DEFAULT_REPO_SLUG="grosa787/localcode"

LOCALCODE_REPO="${LOCALCODE_REPO:-$DEFAULT_REPO}"
LOCALCODE_HOME="${LOCALCODE_HOME:-$DEFAULT_HOME}"
LOCALCODE_BIN_DIR="${LOCALCODE_BIN_DIR:-$DEFAULT_BIN_DIR}"
LOCALCODE_RELEASE_BASE="${LOCALCODE_RELEASE_BASE:-$DEFAULT_RELEASE_BASE}"
# LOCALCODE_REF is resolved later (depends on mode): source-build defaults to
# `main`; binary mode defaults to the latest GitHub release tag.
LOCALCODE_REF="${LOCALCODE_REF:-}"

VERBOSE=0
MODE="install"
FORCE=0
FROM_SOURCE="${LOCALCODE_FROM_SOURCE:-0}"

# How to re-invoke this installer, for hints we print. When piped from curl
# `$0` is "bash" (or "-bash"), which is not a runnable path — fall back to the
# documented one-liner instead of telling the user to run `bash --uninstall`.
if [ -f "$0" ] && [ -r "$0" ]; then
  SELF_CMD="$0"
else
  SELF_CMD="curl -fsSL https://raw.githubusercontent.com/grosa787/localcode/main/install.sh | bash -s --"
fi

# ---------- usage ----------
# Printed from a heredoc, NOT sed'd out of "$0": under the documented
# `curl … | bash` invocation the script has no file on disk, so any attempt
# to read "$0" fails ("sed: bash: No such file or directory").
usage() {
  cat <<'USAGE'
LocalCode installer
-------------------
One-command install. Run it from a clone (./install.sh) or piped from curl:

  curl -fsSL https://raw.githubusercontent.com/grosa787/localcode/main/install.sh | bash

When piping, flags must come after `-s --`, otherwise bash eats them:

  curl -fsSL .../install.sh | bash -s -- --update

What it does:
  1. Detect OS + arch (bail on unsupported).
  2. Download the prebuilt binary for your platform from the latest GitHub
     release and verify it against the release SHA256SUMS.
  3. If no usable prebuilt asset exists, fall back to a source build: ensure
     Bun >= 1.1, clone/refresh the repo into $LOCALCODE_HOME
     (default ~/.local/share/localcode), then `bun install && bun run build`.
  4. Symlink the result into a PATH directory:
       - first $HOME/.local/bin/localcode (no sudo, preferred);
       - fall back to /usr/local/bin/localcode (sudo) if that is unwritable.
  5. Add that bin dir to your shell rc files so `localcode` resolves in new
     shells, and best-effort link it into /usr/local/bin (only when sudo
     needs no prompt) so it resolves in the current one too.

Flags:
  --uninstall          remove the symlink and the install dir.
  --update             refresh an existing install in place, using the same
                       channel it was installed with: a prebuilt install
                       re-downloads the latest release binary, a source
                       install does git fetch + rebuild.
  --dir <path>         override install dir (default $HOME/.local/share/localcode).
  --from-source        skip the prebuilt-binary path entirely (always clone + build).
  --force              re-download and re-verify the release binary even when
                       the installed one already carries the target tag. Use
                       this to repair a truncated or corrupted install.
  --verbose            print each step's command output.
  --help, -h           show this help.

An existing install pins its channel. Re-running the installer over a source
checkout keeps building from source rather than silently dropping a prebuilt
binary beside the now-orphaned clone. Run --uninstall first to switch channels.

Env:
  LOCALCODE_HOME       override install dir (same as --dir).
  LOCALCODE_REPO       override clone URL (default github.com/grosa787/localcode).
  LOCALCODE_REF        git ref / release tag to install. Default: latest GitHub
                       release (or `main` when --from-source is used).
  LOCALCODE_BIN_DIR    override symlink dir. Default: $HOME/.local/bin.
  LOCALCODE_FROM_SOURCE  same as --from-source when set to "1".
  LOCALCODE_RELEASE_BASE override release-asset URL prefix (default github.com).
USAGE
}

# ---------- arg parse ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall)   MODE="uninstall"; shift ;;
    --update)      MODE="update"; shift ;;
    --from-source) FROM_SOURCE=1; shift ;;
    --force)       FORCE=1; shift ;;
    --verbose)     VERBOSE=1; shift ;;
    --dir)
      if [ $# -lt 2 ]; then echo "error: --dir requires a value" >&2; exit 2; fi
      LOCALCODE_HOME="$2"; shift 2 ;;
    --help|-h)
      usage
      exit 0 ;;
    *)
      echo "error: unknown flag: $1" >&2
      echo "run '$SELF_CMD --help' for usage." >&2
      exit 2 ;;
  esac
done

# ---------- logging ----------
log()  { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
# Run a step quietly, but show its output if it fails.
#
# The old implementation was `"$@" >/dev/null 2>&1 || ( "$@" )` — it ran the
# command a SECOND time to reveal the output. That is wrong for three reasons:
# a failing step is executed twice (up to 4 `git clone` attempts against a bad
# ref, two full `bun install`s), a command that fails only intermittently gets
# silently papered over by the retry, and callers that redirect (`run git clone
# … 2>/dev/null || run git clone …`) swallow the retry's output anyway, so the
# whole point was defeated. Capture once, replay on failure.
run() {
  if [ "$VERBOSE" -eq 1 ]; then
    ( set -x; "$@" )
    return $?
  fi
  _run_log="$(mktemp "${TMPDIR:-/tmp}/localcode-run.XXXXXX" 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/localcode-run.$$")"
  _run_status=0
  "$@" >"$_run_log" 2>&1 || _run_status=$?
  if [ "$_run_status" -ne 0 ]; then
    printf 'command failed (exit %s): %s\n' "$_run_status" "$*" >&2
    cat "$_run_log" >&2 2>/dev/null || true
  fi
  rm -f "$_run_log"
  return "$_run_status"
}

# ---------- OS / arch detection ----------
detect_platform() {
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  uname_m="$(uname -m 2>/dev/null || echo unknown)"
  case "$uname_s" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux" ;;
    *) die "unsupported OS: $uname_s (LocalCode supports macOS and Linux; Windows users: use WSL)" ;;
  esac
  case "$uname_m" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) die "unsupported arch: $uname_m" ;;
  esac
}

# ---------- prerequisite tools ----------
have() { command -v "$1" >/dev/null 2>&1; }

bun_version_ok() {
  # arg: version string like "1.1.20" or "1.2.0"
  v="$1"
  major="$(printf '%s\n' "$v" | awk -F. '{print $1+0}')"
  minor="$(printf '%s\n' "$v" | awk -F. '{print $2+0}')"
  if [ "$major" -gt "$MIN_BUN_MAJOR" ]; then return 0; fi
  if [ "$major" -lt "$MIN_BUN_MAJOR" ]; then return 1; fi
  if [ "$minor" -ge "$MIN_BUN_MINOR" ]; then return 0; fi
  return 1
}

ensure_bun() {
  if have bun; then
    cur="$(bun --version 2>/dev/null || echo 0.0.0)"
    if bun_version_ok "$cur"; then
      log "bun ${cur} OK"
      return 0
    fi
    warn "bun ${cur} is older than ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}; reinstalling latest"
  else
    log "bun not found; installing via https://bun.sh/install"
  fi
  if ! have curl; then die "'curl' is required to install Bun"; fi
  # Bun's installer writes to $HOME/.bun by default and prints PATH hints.
  curl -fsSL https://bun.sh/install | bash
  # Make Bun available in this shell for the rest of the script.
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  PATH="$BUN_INSTALL/bin:$PATH"
  export PATH
  if ! have bun; then
    die "Bun installation finished but 'bun' is still not on PATH. Add \"$BUN_INSTALL/bin\" to PATH and re-run."
  fi
  log "bun $(bun --version) installed"
}

ensure_fetcher() {
  if have git; then FETCHER="git"; return 0; fi
  if have curl && have tar; then FETCHER="tarball"; return 0; fi
  die "need either 'git' OR ('curl' + 'tar') to fetch the repository"
}

# ---------- prebuilt binary download path ----------

# Map LOCALCODE_REPO URL -> "owner/repo" slug for release URLs.
release_repo_slug() {
  printf '%s' "$LOCALCODE_REPO" | sed -E 's#^https?://github.com/##; s#\.git$##' \
    | awk -F/ 'NF>=2 {print $1"/"$2}'
}

# Resolve the latest release tag via the GitHub API (no auth — public repo).
# Sets LOCALCODE_REF if currently empty.
resolve_latest_tag() {
  slug="$1"
  url="https://api.github.com/repos/${slug}/releases/latest"
  tag=""
  if have curl; then
    raw="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$url" 2>/dev/null || true)"
  elif have wget; then
    raw="$(wget -qO- --header='Accept: application/vnd.github+json' "$url" 2>/dev/null || true)"
  else
    return 1
  fi
  # Pull the tag_name without depending on jq.
  tag="$(printf '%s' "$raw" | tr -d '\n\r' \
    | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' \
    | head -1 \
    | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
  [ -n "$tag" ] || return 1
  printf '%s' "$tag"
}

# Compute sha256 of a file; outputs the hex digest only.
file_sha256() {
  f="$1"
  if have sha256sum; then
    sha256sum "$f" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$f" | awk '{print $1}'
  else
    return 1
  fi
}

# Try to download + install the prebuilt binary for $OS/$ARCH at $LOCALCODE_REF.
# Returns 0 on success (binary at $LOCALCODE_HOME/bin/localcode), 1 to signal
# the caller to fall back to source-build mode.
install_prebuilt() {
  slug="$(release_repo_slug)"
  if [ -z "$slug" ]; then
    warn "could not parse repo slug from $LOCALCODE_REPO; falling back to source-build"
    return 1
  fi

  if [ -z "$LOCALCODE_REF" ] || [ "$LOCALCODE_REF" = "main" ]; then
    log "resolving latest release for $slug"
    latest="$(resolve_latest_tag "$slug" || true)"
    if [ -z "$latest" ]; then
      warn "could not determine latest release tag; falling back to source-build"
      return 1
    fi
    LOCALCODE_REF="$latest"
  fi

  # Reject obviously non-tag refs (sha / branch). Tags start with `v` in this project.
  case "$LOCALCODE_REF" in
    v[0-9]*) ;;
    *)
      log "LOCALCODE_REF='$LOCALCODE_REF' does not look like a release tag (expected vX.Y.Z); using source-build path"
      return 1 ;;
  esac

  tag="$LOCALCODE_REF"

  # Nothing to do if the installed binary already carries this tag — skip the
  # ~13 MB download. The caller still runs install_symlink(), so a broken or
  # missing symlink is repaired either way.
  #
  # --force bypasses the skip: the tag file says nothing about the binary's
  # integrity, so a download truncated after `install -m 0755` (or a later
  # corruption) would otherwise be unrepairable — every re-run would
  # short-circuit and only re-point the symlink at the broken binary.
  if [ "$FORCE" -ne 1 ] \
    && [ -x "$LOCALCODE_HOME/bin/localcode" ] \
    && [ -f "$LOCALCODE_HOME/.installed-tag" ]; then
    installed_tag="$(cat "$LOCALCODE_HOME/.installed-tag" 2>/dev/null || true)"
    if [ "$installed_tag" = "$tag" ]; then
      BIN_TARGET="$LOCALCODE_HOME/bin/localcode"
      log "already on $tag — nothing to download"
      log "    if the binary is broken, re-run with --force to re-download and re-verify"
      return 0
    fi
  fi

  asset="localcode-${OS}-${ARCH}.tar.gz"
  base="${LOCALCODE_RELEASE_BASE}/${slug}/releases/download/${tag}"
  asset_url="${base}/${asset}"
  sums_url="${base}/SHA256SUMS"

  if ! have curl; then
    warn "curl not found; cannot fetch prebuilt binary"
    return 1
  fi
  if ! have tar; then
    warn "tar not found; cannot extract prebuilt binary"
    return 1
  fi

  tmpdir="$(mktemp -d)"
  log "downloading $asset_url"
  if ! curl -fsSL --retry 3 --retry-delay 1 -o "$tmpdir/$asset" "$asset_url"; then
    warn "could not fetch $asset_url (tag may not have a prebuilt asset for $OS/$ARCH)"
    rm -rf "$tmpdir"
    return 1
  fi

  log "downloading SHA256SUMS"
  if ! curl -fsSL --retry 3 --retry-delay 1 -o "$tmpdir/SHA256SUMS" "$sums_url"; then
    warn "could not fetch SHA256SUMS from release $tag; refusing to install unverified binary"
    rm -rf "$tmpdir"
    return 1
  fi

  expected="$(awk -v f="$asset" '$2==f || $2=="*"f {print $1; exit}' "$tmpdir/SHA256SUMS" || true)"
  if [ -z "$expected" ]; then
    warn "SHA256SUMS does not list $asset; refusing to install unverified binary"
    rm -rf "$tmpdir"
    return 1
  fi
  got="$(file_sha256 "$tmpdir/$asset" || true)"
  if [ -z "$got" ]; then
    warn "no sha256sum / shasum tool available; refusing to install unverified binary"
    rm -rf "$tmpdir"
    return 1
  fi
  if [ "$expected" != "$got" ]; then
    warn "SHA-256 mismatch for $asset
  expected: $expected
  got:      $got
refusing to install."
    rm -rf "$tmpdir"
    return 1
  fi
  log "checksum verified ($expected)"

  mkdir -p "$LOCALCODE_HOME/bin"
  ( cd "$tmpdir" && tar -xzf "$asset" )
  # The tarball contains `localcode` (the native binary), LICENSE, README.md.
  # Place the binary at $LOCALCODE_HOME/bin/localcode and a marker so we know
  # this is a binary install (no git history).
  if [ ! -f "$tmpdir/localcode" ]; then
    warn "extracted tarball did not contain a 'localcode' executable"
    rm -rf "$tmpdir"
    return 1
  fi
  install -m 0755 "$tmpdir/localcode" "$LOCALCODE_HOME/bin/localcode"
  printf '%s\n' "$tag" > "$LOCALCODE_HOME/.installed-tag"
  rm -rf "$tmpdir"

  BIN_TARGET="$LOCALCODE_HOME/bin/localcode"
  log "installed prebuilt binary for $OS/$ARCH at $BIN_TARGET (tag $tag)"
  return 0
}

# ---------- install-kind detection ----------
# Which channel is already installed at $LOCALCODE_HOME?
#   source → a git clone we build with Bun (symlink points at dist/cli.js)
#   binary → a prebuilt native binary dropped by install_prebuilt
#   none   → nothing there yet
# Both --update and the channel-pinning guard in main() key off this.
detect_install_kind() {
  if [ -d "$LOCALCODE_HOME/.git" ]; then
    printf 'source'
    return 0
  fi
  if [ -f "$LOCALCODE_HOME/.installed-tag" ] || [ -x "$LOCALCODE_HOME/bin/localcode" ]; then
    printf 'binary'
    return 0
  fi
  printf 'none'
}

# ---------- fetch / update ----------
fetch_repo() {
  parent_dir="$(dirname "$LOCALCODE_HOME")"
  mkdir -p "$parent_dir"
  if [ -d "$LOCALCODE_HOME/.git" ]; then
    log "updating existing clone at $LOCALCODE_HOME"
    # Try to land the ref in an explicit remote-tracking ref FIRST. A clone
    # made by the pre-prebuilt installer used `--depth=1 --branch vX.Y.Z`,
    # whose single-branch refspec never creates `refs/remotes/origin/main`
    # — so a bare `git checkout -f main` has nothing to DWIM against and
    # the source-channel update dies. Falls back to a plain fetch (which
    # always populates FETCH_HEAD) when the ref is a tag or a sha.
    ( cd "$LOCALCODE_HOME" && run git fetch --tags --depth=1 origin \
        "+refs/heads/${LOCALCODE_REF}:refs/remotes/origin/${LOCALCODE_REF}" ) \
      || ( cd "$LOCALCODE_HOME" && run git fetch --tags --depth=1 origin "$LOCALCODE_REF" )
    # Branch → hard-reset a local branch onto the fetched remote tip.
    # Tag / sha → check the ref out directly. Detached FETCH_HEAD is the
    # last resort so a shallow clone with no local ref still updates.
    ( cd "$LOCALCODE_HOME" && run git checkout -f -B "$LOCALCODE_REF" \
        "refs/remotes/origin/$LOCALCODE_REF" ) 2>/dev/null \
      || ( cd "$LOCALCODE_HOME" && run git checkout -f "$LOCALCODE_REF" ) 2>/dev/null \
      || ( cd "$LOCALCODE_HOME" && run git checkout -f FETCH_HEAD )
    return 0
  fi
  if [ -e "$LOCALCODE_HOME" ] && [ ! -d "$LOCALCODE_HOME/.git" ]; then
    # existing non-git dir → refuse to clobber
    die "$LOCALCODE_HOME exists and is not a git clone; remove it or pass --dir <other>"
  fi
  case "$FETCHER" in
    git)
      log "cloning $LOCALCODE_REPO @ $LOCALCODE_REF -> $LOCALCODE_HOME"
      run git clone --depth=1 --branch "$LOCALCODE_REF" "$LOCALCODE_REPO" "$LOCALCODE_HOME" 2>/dev/null \
        || run git clone "$LOCALCODE_REPO" "$LOCALCODE_HOME"
      ( cd "$LOCALCODE_HOME" && run git checkout -f "$LOCALCODE_REF" ) 2>/dev/null || true
      ;;
    tarball)
      # github tarball — no git history but enough to build.
      # Translate https://github.com/owner/repo.git → owner/repo
      slug="$(printf '%s' "$LOCALCODE_REPO" | sed -E 's#^https?://github.com/##; s#\.git$##')"
      tar_url="https://codeload.github.com/${slug}/tar.gz/${LOCALCODE_REF}"
      log "downloading tarball $tar_url"
      tmpdir="$(mktemp -d)"
      tarball="$tmpdir/lc.tar.gz"
      run curl -fsSL "$tar_url" -o "$tarball"
      mkdir -p "$LOCALCODE_HOME"
      run tar -xzf "$tarball" --strip-components=1 -C "$LOCALCODE_HOME"
      rm -rf "$tmpdir"
      ;;
  esac
}

# ---------- build ----------
build_project() {
  log "installing dependencies (bun install)"
  ( cd "$LOCALCODE_HOME" && run bun install )
  log "building bundle (bun run build)"
  ( cd "$LOCALCODE_HOME" && run bun run build )
  if [ ! -f "$LOCALCODE_HOME/dist/cli.js" ]; then
    die "build finished but $LOCALCODE_HOME/dist/cli.js is missing"
  fi
  chmod +x "$LOCALCODE_HOME/dist/cli.js"
}

# ---------- symlink ----------
path_contains() {
  # arg: directory; returns 0 if $PATH contains it as a colon segment
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Idempotently ensure $1 (a bin dir) is exported onto PATH in every shell
# the user might open, so `localcode` resolves in FUTURE sessions with no
# manual step. Touches the common POSIX/zsh/bash rc files plus fish; each
# file is edited at most once (guarded by a grep for the dir).
ensure_on_path() {
  bindir="$1"
  line="export PATH=\"$bindir:\$PATH\""
  marker="# added by LocalCode installer (https://github.com/grosa787/localcode)"
  RC_UPDATED=""

  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ -e "$rc" ] || continue
    # Skip if the dir is already referenced anywhere in the file.
    if grep -qsF "$bindir" "$rc"; then continue; fi
    if printf '\n%s\n%s\n' "$marker" "$line" >> "$rc" 2>/dev/null; then
      RC_UPDATED="$RC_UPDATED $rc"
    fi
  done

  # zsh is the macOS default shell, but a fresh account may have no
  # ~/.zshrc yet — create it so the export still lands for new shells.
  if [ ! -e "$HOME/.zshrc" ] && have zsh; then
    if printf '%s\n%s\n' "$marker" "$line" > "$HOME/.zshrc" 2>/dev/null; then
      RC_UPDATED="$RC_UPDATED $HOME/.zshrc"
    fi
  fi
  # Lowest-common-denominator login file when nothing else was touched.
  if [ -z "$RC_UPDATED" ] && [ ! -e "$HOME/.profile" ]; then
    if printf '%s\n%s\n' "$marker" "$line" > "$HOME/.profile" 2>/dev/null; then
      RC_UPDATED="$RC_UPDATED $HOME/.profile"
    fi
  fi

  # fish keeps PATH in its own conf.d dir; fish_add_path is idempotent.
  if have fish; then
    fish_conf="$HOME/.config/fish/conf.d/localcode.fish"
    mkdir -p "$(dirname "$fish_conf")" 2>/dev/null || true
    if printf '# added by LocalCode installer\nif test -d %s\n    fish_add_path %s\nend\n' \
        "$bindir" "$bindir" > "$fish_conf" 2>/dev/null; then
      RC_UPDATED="$RC_UPDATED $fish_conf"
    fi
  fi
}

# Best-effort: ALSO expose the binary in a system dir already on PATH
# everywhere (/usr/local/bin), so `localcode` works in the CURRENT,
# already-open shell — not just future ones. Never blocks the install:
# uses sudo only when it won't prompt (cached creds); silently skips
# otherwise. Safe to call after the primary ~/.local/bin link.
ensure_system_symlink() {
  target="$1"
  syslink="$FALLBACK_BIN_DIR/localcode"
  # Already the primary link target → nothing to do.
  [ "${LINKED_AT:-}" = "$syslink" ] && return 0
  if [ -d "$FALLBACK_BIN_DIR" ] && [ -w "$FALLBACK_BIN_DIR" ]; then
    if ln -sf "$target" "$syslink" 2>/dev/null; then
      SYS_LINKED="$syslink"
      return 0
    fi
  fi
  if have sudo && sudo -n true 2>/dev/null; then
    if sudo ln -sf "$target" "$syslink" 2>/dev/null; then
      SYS_LINKED="$syslink"
    fi
  fi
  return 0
}

install_symlink() {
  # Prefer the native binary placed by install_prebuilt; fall back to the
  # bundled cli.js from source-build mode.
  target="${BIN_TARGET:-$LOCALCODE_HOME/dist/cli.js}"
  # 1) try ~/.local/bin (no sudo)
  if mkdir -p "$LOCALCODE_BIN_DIR" 2>/dev/null && [ -w "$LOCALCODE_BIN_DIR" ]; then
    link="$LOCALCODE_BIN_DIR/localcode"
    log "linking $target -> $link"
    ln -sf "$target" "$link"
    LINKED_AT="$link"
    # Make `localcode` resolve everywhere with no manual step:
    #   - future shells: append the bin dir to every shell rc file.
    #   - the current shell: also link into /usr/local/bin (already on
    #     PATH) when we can do so without prompting for sudo.
    if ! path_contains "$LOCALCODE_BIN_DIR"; then
      ensure_on_path "$LOCALCODE_BIN_DIR"
    fi
    ensure_system_symlink "$target"
    return 0
  fi
  # 2) fall back to /usr/local/bin via sudo
  link="$FALLBACK_BIN_DIR/localcode"
  warn "cannot write to $LOCALCODE_BIN_DIR; falling back to $link (requires sudo)"
  log "running: sudo ln -sf $target $link"
  if ! sudo ln -sf "$target" "$link"; then
    die "sudo symlink failed. Try: export LOCALCODE_BIN_DIR=\$HOME/.local/bin && re-run."
  fi
  LINKED_AT="$link"
}

# ---------- uninstall ----------
uninstall() {
  removed=0
  # remove known symlink locations if they point into our install dir
  for cand in "$LOCALCODE_BIN_DIR/localcode" "$FALLBACK_BIN_DIR/localcode"; do
    if [ -L "$cand" ]; then
      tgt="$(readlink "$cand" 2>/dev/null || true)"
      case "$tgt" in
        "$LOCALCODE_HOME"/*)
          log "removing symlink $cand"
          if [ -w "$(dirname "$cand")" ]; then
            rm -f "$cand"
          else
            sudo rm -f "$cand"
          fi
          removed=1
          ;;
        *)
          warn "skipping $cand (does not point into $LOCALCODE_HOME)"
          ;;
      esac
    fi
  done
  if [ -d "$LOCALCODE_HOME" ]; then
    log "removing install dir $LOCALCODE_HOME"
    rm -rf "$LOCALCODE_HOME"
    removed=1
  fi
  if [ "$removed" -eq 0 ]; then
    log "nothing to uninstall (no symlink or dir found)"
  else
    log "uninstalled."
  fi
}

# ---------- main ----------
main() {
  detect_platform
  log "platform: $OS/$ARCH"

  if [ "$MODE" = "uninstall" ]; then
    uninstall
    exit 0
  fi

  INSTALL_KIND="$(detect_install_kind)"

  # An existing install pins its channel, for both --update and a plain
  # re-run. Without this, re-running the installer over a source checkout
  # downloaded a prebuilt binary and re-pointed the symlink at it, leaving the
  # git clone on disk, orphaned and silently stale.
  if [ "$INSTALL_KIND" = "source" ] && [ "$FROM_SOURCE" -ne 1 ]; then
    log "existing source install at $LOCALCODE_HOME -> staying on the source channel (git fetch + rebuild)"
    log "    to switch to the prebuilt binary: $SELF_CMD --uninstall, then re-run the installer"
    FROM_SOURCE=1
  fi
  if [ "$INSTALL_KIND" = "binary" ] && [ "$FROM_SOURCE" -eq 1 ]; then
    die "$LOCALCODE_HOME holds a prebuilt-binary install, which --from-source cannot reuse.
Run '$SELF_CMD --uninstall' first, or install elsewhere with --dir <path>."
  fi
  if [ "$MODE" = "update" ] && [ "$INSTALL_KIND" = "none" ]; then
    die "nothing installed at $LOCALCODE_HOME — run the installer without --update first."
  fi

  # Binary-first path: download prebuilt binary for the platform from the
  # latest (or specified) GitHub release. Falls back to source-build on any
  # failure unless --from-source forced us there explicitly. --update takes
  # this same path for binary installs — it is how they refresh; sending them
  # to the source branch made `--update` die on "not a git clone".
  USED_PREBUILT=0
  if [ "$FROM_SOURCE" -ne 1 ]; then
    mkdir -p "$LOCALCODE_HOME"
    if install_prebuilt; then
      USED_PREBUILT=1
    elif [ "$INSTALL_KIND" = "binary" ]; then
      # Never silently convert a working binary install into a source build:
      # fetch_repo() would refuse the non-git dir anyway, and the user's
      # current install still works. Leave it alone and say so.
      die "could not refresh the prebuilt install at $LOCALCODE_HOME (see the warning above).
Your existing install is untouched — retry when the network/release is available,
or switch to a source build with: $SELF_CMD --uninstall   then   $SELF_CMD --from-source"
    else
      log "prebuilt-binary path unavailable; falling back to source-build"
      # The prebuilt attempt created $LOCALCODE_HOME (and possibly $LOCALCODE_HOME/bin)
      # but did NOT write a `.git` directory. The downstream fetch_repo() refuses
      # to clobber a non-empty, non-git dir — so we clean up here unless the
      # user already had a populated install we'd be wiping. Only remove the
      # dir if its only contents are the empty `bin/` we just made.
      if [ -d "$LOCALCODE_HOME" ] && [ ! -d "$LOCALCODE_HOME/.git" ]; then
        # Detect: dir is "fresh" — either empty, or contains only an empty bin/.
        # If the only contents are an empty `bin/`, remove that first so the
        # top-level rmdir succeeds.
        if [ -d "$LOCALCODE_HOME/bin" ]; then
          rmdir "$LOCALCODE_HOME/bin" 2>/dev/null || true
        fi
        # rmdir only succeeds if the directory is now empty — safe to attempt
        # blindly; we explicitly do NOT use `rm -rf` so we never clobber a
        # populated directory the user may want preserved.
        rmdir "$LOCALCODE_HOME" 2>/dev/null || true
        if [ -d "$LOCALCODE_HOME" ] && [ ! -d "$LOCALCODE_HOME/.git" ]; then
          # Still there → had unexpected contents. Surface, then let
          # fetch_repo() emit the canonical "refusing to clobber" error.
          remaining="$(ls -A "$LOCALCODE_HOME" 2>/dev/null | tr '\n' ' ')"
          warn "$LOCALCODE_HOME has unexpected contents after prebuilt failure: $remaining"
        fi
      fi
    fi
  fi

  if [ "$USED_PREBUILT" -ne 1 ]; then
    # Source-build defaults to `main` if no LOCALCODE_REF was provided.
    LOCALCODE_REF="${LOCALCODE_REF:-$DEFAULT_REF_SOURCE}"
    ensure_bun
    ensure_fetcher
    fetch_repo
    build_project
  fi
  install_symlink

  log "LocalCode installed at $LINKED_AT"
  if [ -n "${SYS_LINKED:-}" ]; then
    log "also linked at $SYS_LINKED (on PATH for every shell)"
  fi
  if [ -n "${RC_UPDATED:-}" ]; then
    log "added $LOCALCODE_BIN_DIR to PATH in:$RC_UPDATED"
  fi
  echo ""
  if [ -n "${SYS_LINKED:-}" ] || path_contains "$LOCALCODE_BIN_DIR"; then
    # Resolvable in the CURRENT shell right now.
    echo "  Run: localcode"
  else
    # rc files were updated → works in any NEW shell. Offer a one-liner
    # so the user doesn't even have to open a new terminal.
    echo "  Run: localcode    (in a new terminal)"
    echo "  Or activate it in this shell now:"
    echo "      export PATH=\"$LOCALCODE_BIN_DIR:\$PATH\""
  fi
  echo ""
  echo "  Update:    $SELF_CMD --update"
  echo "  Uninstall: $SELF_CMD --uninstall"
}

main
