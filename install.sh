#!/usr/bin/env bash
#
# LocalCode installer
# -------------------
# One-command install (Claude-Code-style). Designed to be run either as a
# clone-local script (./install.sh) OR piped from curl:
#
#   curl -fsSL https://raw.githubusercontent.com/grosa787/localcode/main/install.sh | bash
#
# Steps it performs end-to-end:
#   1. Detect OS + arch (bail on unsupported).
#   2. Ensure Bun >= 1.1 is installed (installs via official installer if missing).
#   3. Fetch (or update) the repo into $LOCALCODE_HOME (~/.local/share/localcode).
#   4. bun install && bun run build.
#   5. Symlink dist/cli.js into a PATH directory:
#        - first try $HOME/.local/bin/localcode (no sudo, preferred);
#        - fall back to /usr/local/bin/localcode (sudo, explained first).
#   6. Print success + PATH hint if $HOME/.local/bin is not on PATH.
#
# Flags:
#   --uninstall          remove the symlink and the install dir.
#   --update             git pull + rebuild (works on existing install).
#   --dir <path>         override install dir (default $HOME/.local/share/localcode).
#   --from-source        skip the prebuilt-binary path entirely (always clone + build).
#   --verbose            print each step's command output.
#   --help, -h           show this help.
#
# Env:
#   LOCALCODE_HOME       override install dir (same as --dir).
#   LOCALCODE_REPO       override clone URL (default github.com/grosa787/localcode).
#   LOCALCODE_REF        git ref / release tag to install. Default: latest GitHub release
#                        (or `main` when --from-source is used).
#   LOCALCODE_BIN_DIR    override symlink dir. Default: $HOME/.local/bin.
#   LOCALCODE_FROM_SOURCE  same as --from-source when set to "1".
#   LOCALCODE_RELEASE_BASE override release-asset URL prefix (default github.com).

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
FROM_SOURCE="${LOCALCODE_FROM_SOURCE:-0}"

# ---------- arg parse ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall)   MODE="uninstall"; shift ;;
    --update)      MODE="update"; shift ;;
    --from-source) FROM_SOURCE=1; shift ;;
    --verbose)     VERBOSE=1; shift ;;
    --dir)
      if [ $# -lt 2 ]; then echo "error: --dir requires a value" >&2; exit 2; fi
      LOCALCODE_HOME="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "error: unknown flag: $1" >&2
      echo "run with --help for usage." >&2
      exit 2 ;;
  esac
done

# ---------- logging ----------
log()  { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
run() {
  if [ "$VERBOSE" -eq 1 ]; then
    ( set -x; "$@" )
  else
    "$@" >/dev/null 2>&1 || ( "$@" )
  fi
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

# ---------- fetch / update ----------
fetch_repo() {
  parent_dir="$(dirname "$LOCALCODE_HOME")"
  mkdir -p "$parent_dir"
  if [ -d "$LOCALCODE_HOME/.git" ]; then
    log "updating existing clone at $LOCALCODE_HOME"
    ( cd "$LOCALCODE_HOME" && run git fetch --tags --depth=1 origin "$LOCALCODE_REF" )
    ( cd "$LOCALCODE_HOME" && run git checkout -f "$LOCALCODE_REF" )
    # if ref is a branch, fast-forward to remote tip
    ( cd "$LOCALCODE_HOME" && run git reset --hard "origin/$LOCALCODE_REF" ) 2>/dev/null || true
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
    if ! path_contains "$LOCALCODE_BIN_DIR"; then
      PATH_HINT="$LOCALCODE_BIN_DIR is not on your PATH yet. Add this to your shell rc:
    export PATH=\"$LOCALCODE_BIN_DIR:\$PATH\""
    fi
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

  # Binary-first path: download prebuilt binary for the platform from the
  # latest (or specified) GitHub release. Falls back to source-build on any
  # failure unless --from-source forced us there explicitly.
  USED_PREBUILT=0
  if [ "$FROM_SOURCE" -ne 1 ] && [ "$MODE" != "update" ]; then
    mkdir -p "$LOCALCODE_HOME"
    if install_prebuilt; then
      USED_PREBUILT=1
    else
      log "prebuilt-binary path unavailable; falling back to source-build"
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
  echo ""
  echo "  Run: localcode"
  echo ""
  if [ -n "${PATH_HINT:-}" ]; then
    printf '%s\n' "$PATH_HINT"
    echo ""
  fi
  echo "  Re-run this installer any time to update."
  echo "  Uninstall with: $0 --uninstall"
}

main
