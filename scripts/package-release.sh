#!/usr/bin/env bash
#
# package-release.sh
# ------------------
# Package a prebuilt LocalCode binary into the release tarball layout consumed by
# install.sh, the npm shim (packages/npm/scripts/install-binary.js), and the
# packaging/nfpm.yaml deb/rpm pipeline. Designed to be invoked either by
# .github/workflows/release.yml or locally for reproducibility verification.
#
# Inputs (env or flags):
#   --bin <path>     absolute path to the compiled `localcode` binary
#   --os <darwin|linux>
#   --arch <x64|arm64>
#   --out <dir>      output directory for tarball + .sha256
#   --version <X.Y.Z>   used for the version-marker file inside the tarball
#
# Produces in <out>/:
#   localcode-<os>-<arch>.tar.gz
#   localcode-<os>-<arch>.tar.gz.sha256
#
# Reproducibility:
#   - tar files set --mtime=@${SOURCE_DATE_EPOCH:-0}, --owner=0, --group=0, --numeric-owner.
#   - GNU tar sort=name keeps file order stable.
#   - SHA-256 over the resulting tarball is recorded in <asset>.sha256 using the
#     Unix `sha256sum` "<hex>  <name>" format. macOS uses `shasum -a 256`.

set -eu

BIN=""
OS=""
ARCH=""
OUT=""
VERSION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --bin)     BIN="$2"; shift 2 ;;
    --os)      OS="$2"; shift 2 ;;
    --arch)    ARCH="$2"; shift 2 ;;
    --out)     OUT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2 ;;
  esac
done

[ -n "$BIN" ]     || { echo "--bin required"   >&2; exit 2; }
[ -n "$OS" ]      || { echo "--os required"    >&2; exit 2; }
[ -n "$ARCH" ]    || { echo "--arch required"  >&2; exit 2; }
[ -n "$OUT" ]     || { echo "--out required"   >&2; exit 2; }
[ -n "$VERSION" ] || { echo "--version required" >&2; exit 2; }
[ -f "$BIN" ]     || { echo "binary not found: $BIN" >&2; exit 1; }

case "$OS" in darwin|linux) ;; *) echo "bad --os: $OS" >&2; exit 2 ;; esac
case "$ARCH" in x64|arm64) ;; *) echo "bad --arch: $ARCH" >&2; exit 2 ;; esac

mkdir -p "$OUT"
ASSET="localcode-${OS}-${ARCH}.tar.gz"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Layout inside the tarball: the binary at the root + LICENSE/README so that
# the install.sh extractor and the npm shim's tar reader both find them.
cp "$BIN" "$STAGE/localcode"
chmod 0755 "$STAGE/localcode"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$REPO_ROOT/LICENSE" ]    && cp "$REPO_ROOT/LICENSE"    "$STAGE/LICENSE"
[ -f "$REPO_ROOT/README.md" ]  && cp "$REPO_ROOT/README.md"  "$STAGE/README.md"

# Record the version inside the tarball — diagnostic only.
printf '%s\n' "$VERSION" > "$STAGE/VERSION"

# Reproducible mtimes (SOURCE_DATE_EPOCH defaults to 0 — Unix epoch — so tar
# headers are deterministic across runners).
EPOCH="${SOURCE_DATE_EPOCH:-0}"

# tar flags: GNU tar on Linux supports --sort, --owner, --group, --numeric-owner,
# --mtime. BSD tar on macOS supports --uname, --gname, --uid, --gid, plus the
# magic env var COPYFILE_DISABLE=1 to suppress ._ AppleDouble files. Branch.
if tar --version 2>/dev/null | head -1 | grep -qi 'gnu'; then
  tar \
    --sort=name \
    --owner=0 --group=0 --numeric-owner \
    --mtime="@${EPOCH}" \
    --format=ustar \
    -C "$STAGE" \
    -czf "$OUT/$ASSET" \
    localcode LICENSE README.md VERSION
else
  # BSD tar (macOS)
  export COPYFILE_DISABLE=1
  ( cd "$STAGE" && \
    find . -mindepth 1 -maxdepth 1 -exec touch -t "$(date -u -r "$EPOCH" +%Y%m%d%H%M.%S 2>/dev/null || echo 197001010000.00)" {} \; ) || true
  ( cd "$STAGE" && \
    tar --uid 0 --gid 0 --uname root --gname root \
        --format ustar \
        -czf "$OUT/$ASSET" \
        localcode LICENSE README.md VERSION )
fi

# Compute SHA-256 sidecar.
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$OUT" && sha256sum "$ASSET" > "${ASSET}.sha256" )
elif command -v shasum >/dev/null 2>&1; then
  ( cd "$OUT" && shasum -a 256 "$ASSET" > "${ASSET}.sha256" )
else
  echo "neither sha256sum nor shasum found" >&2
  exit 1
fi

echo "produced $OUT/$ASSET"
echo "checksum $OUT/${ASSET}.sha256:"
cat "$OUT/${ASSET}.sha256"
