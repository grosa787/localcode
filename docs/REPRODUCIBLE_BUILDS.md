# Reproducible Builds

LocalCode release tarballs are produced from a deterministic recipe so anyone
can rebuild a bit-identical artifact locally and verify the published SHA-256
in `SHA256SUMS`. This doc captures the exact recipe used by
`.github/workflows/release.yml`.

## TL;DR

```sh
# 1. Match the toolchain
bun --version            # must be 1.3.11
git rev-parse HEAD       # must equal the tagged commit
git describe --tags      # should match the release tag (e.g. v0.20.0)

# 2. Build the same way CI does
export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct HEAD)"
bun install --frozen-lockfile
bun run build:web
bun run embed-web

# Native compile (replace os/arch with your target; see table below)
bun build src/cli.tsx \
  --compile \
  --target=bun-linux-x64 \
  --external playwright \
  --external playwright-core \
  --external chromium-bidi \
  --external electron \
  --outfile out-bin/localcode

# 3. Package
scripts/package-release.sh \
  --bin "$(pwd)/out-bin/localcode" \
  --os linux --arch x64 \
  --out dist-release \
  --version "0.20.0"

# 4. Compare against the published checksum
sha256sum dist-release/localcode-linux-x64.tar.gz
```

The hex digest must match the corresponding line of `SHA256SUMS` attached to
the GitHub Release.

## Pinned versions

| Component   | Pin                                              |
| ----------- | ------------------------------------------------ |
| Bun runtime | `1.3.11` (matches `BUN_VERSION` in release.yml). |
| Node.js     | `20.x` (only used for cdxgen SBOM generation).   |
| cdxgen      | `^11` (`@cyclonedx/cdxgen@^11`).                 |
| tar         | GNU tar on Linux runners, BSD tar on macOS.      |

Bun version is the single most important pin: `bun build --compile` embeds the
Bun runtime into the binary, so changing the Bun version changes the binary.

## Target matrix

| Tarball                          | Runner             | Bun `--target`     |
| -------------------------------- | ------------------ | ------------------ |
| `localcode-darwin-x64.tar.gz`    | `macos-13`         | `bun-darwin-x64`   |
| `localcode-darwin-arm64.tar.gz`  | `macos-14`         | `bun-darwin-arm64` |
| `localcode-linux-x64.tar.gz`     | `ubuntu-22.04`     | `bun-linux-x64`    |
| `localcode-linux-arm64.tar.gz`   | `ubuntu-22.04-arm` | `bun-linux-arm64`  |

Each runner builds its own native target — no cross-compilation in CI. If you
rebuild on a different host (e.g. macOS arm64 building a Linux x64 target),
`bun build --compile` will download the matching Bun runtime; this is still
deterministic but slower.

## Environment variables that affect the output

- `SOURCE_DATE_EPOCH` — Unix timestamp embedded into tar headers. CI sets it
  to `git log -1 --format=%ct <tag>`. **Must match** for bit-identical
  tarballs.
- `BUN_INSTALL_CACHE_DIR` — irrelevant for output, but pinning Bun avoids
  surprises.
- `TZ` — leave unset / `UTC` to avoid local-time poisoning of timestamps.
- `LANG=C.UTF-8` — keeps tar/sed/awk sort orders stable across runners.
- `COPYFILE_DISABLE=1` (macOS only) — suppresses `._*` AppleDouble files in
  the tarball. `package-release.sh` exports this automatically when invoked
  on Darwin.

## Working directory layout

CI clones into `$GITHUB_WORKSPACE` (`/home/runner/work/<repo>/<repo>` on
Linux). Locally, the script does **not** depend on the absolute path — only
the relative layout matters:

```
<repo>/
  src/                 source we compile
  web-frontend/        SPA we bundle into src/web/bundle/embedded-assets.ts
  scripts/
    embed-web.ts
    package-release.sh
  out-bin/             intermediate compile output (gitignored)
  dist-release/        final tarballs (gitignored)
```

Anything that writes absolute paths into the binary would break
reproducibility. The current build does not do this (Bun's `--compile` embeds
the bundle by content, not by source path).

## Verifying a downloaded asset

End users don't need any of the above — they just want to verify what they
downloaded. The published `SHA256SUMS` covers every release asset:

```sh
TAG=v0.20.0
REPO=grosa787/localcode
curl -fsSLO "https://github.com/$REPO/releases/download/$TAG/SHA256SUMS"
curl -fsSLO "https://github.com/$REPO/releases/download/$TAG/localcode-linux-x64.tar.gz"
sha256sum --check --ignore-missing SHA256SUMS
```

`install.sh` performs the same check automatically before extraction.

## Honest gaps

- **No code signing / notarization.** macOS binaries are unsigned; users will
  see Gatekeeper warnings on first launch and may need to `xattr -dr
  com.apple.quarantine` or right-click → Open. Apple Developer ID + altool
  notarization are deferred until we have a paid developer account.
- **No SLSA provenance attestation yet.** The release artifacts include
  SHA256SUMS and an SBOM but no signed in-toto attestation. Track upstream
  GitHub `actions/attest-build-provenance` for a low-cost upgrade path.
- **`bun build --compile` does embed a small amount of runner-specific
  metadata** (Bun version string, embedded runtime). Two runs on the *same
  runner version* and *same Bun version* produce identical binaries; two runs
  on different patch versions of Ubuntu may not. Pin the runner OS in
  `.github/workflows/release.yml` (already done: `ubuntu-22.04`, `macos-13`,
  `macos-14`, `ubuntu-22.04-arm`).
- **Playwright is `--external`** — release binaries do not bundle Playwright.
  The browser-tool subsystem is opt-in and only activated when a user runs a
  command that needs it, at which point Playwright is loaded from the system
  install. Releases therefore stay small (~30 MB compressed) at the cost of
  requiring `bunx playwright install` for browser features.

## Reproducing locally on macOS

```sh
brew install bun
bun upgrade --canary || true     # ensure bun on PATH
~/.bun/bin/bun --version          # confirm 1.3.11; if not, see bun.sh/docs
git checkout v0.20.0
export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct HEAD)"
export TZ=UTC LANG=C.UTF-8
bun install --frozen-lockfile
bun run build:web && bun run embed-web
bun build src/cli.tsx --compile --target=bun-darwin-arm64 \
  --external playwright --external playwright-core \
  --external chromium-bidi --external electron \
  --outfile out-bin/localcode
scripts/package-release.sh --bin "$(pwd)/out-bin/localcode" \
  --os darwin --arch arm64 --out dist-release --version 0.20.0
shasum -a 256 dist-release/localcode-darwin-arm64.tar.gz
```

Compare the digest to `SHA256SUMS` from the release. Bit-identical = pass.
