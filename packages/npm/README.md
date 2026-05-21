# @grosa787/localcode

npm shim for **LocalCode** — a local-first AI coding TUI/web app.

This package contains **no source code**. On install, the `postinstall` script
downloads the appropriate prebuilt native binary for your platform from GitHub
Releases and places it at `packages/npm/vendor/localcode`. The `localcode` bin
launcher in `bin/localcode.js` then forwards `argv` and signals to that binary.

## Install

```sh
# Global install
npm install -g @grosa787/localcode

# Or run without installing
npx @grosa787/localcode --help
```

Bun is **not** required on your machine — the downloaded binary is self-contained.

## Supported platforms

| OS      | Arch   | Status     |
|---------|--------|------------|
| macOS   | x64    | supported  |
| macOS   | arm64  | supported  |
| Linux   | x64    | supported  |
| Linux   | arm64  | supported  |
| Windows | any    | use WSL    |

## Environment overrides

| Variable | Purpose |
|----------|---------|
| `LOCALCODE_BINARY_URL` | Full URL to a tarball asset. Overrides the GitHub Releases lookup. |
| `LOCALCODE_CHECKSUM_URL` | Override the checksum file URL (defaults to `${LOCALCODE_BINARY_URL}.sha256`). |
| `LOCALCODE_SKIP_CHECKSUM` | Set to `1` to skip SHA-256 verification (not recommended). |
| `LOCALCODE_SKIP_DOWNLOAD` | Set to `1` to skip postinstall entirely (e.g. CI caching). |
| `LOCALCODE_VERSION` | Override the version string used to construct the asset URL. |
| `LOCALCODE_REPO` | Override the `owner/repo` (default: `grosa787/localcode`). |

## Offline / air-gapped installs

```sh
LOCALCODE_SKIP_DOWNLOAD=1 npm install -g @grosa787/localcode
# Then manually place the binary:
mv path/to/localcode "$(npm root -g)/@grosa787/localcode/vendor/localcode"
chmod +x "$(npm root -g)/@grosa787/localcode/vendor/localcode"
```

## Troubleshooting

- **`checksum mismatch`** — refuse-to-install safeguard. The downloaded tarball
  does not match the published `.sha256`. Try again; if it persists, file an
  issue.
- **`HTTP 404`** — the version you're installing doesn't have a release for your
  platform. Pin to a known-good version: `npm install -g @grosa787/localcode@0.20.0`.
- **`unsupported platform`** — see the table above. Windows users: install via WSL.

## See also

Full docs and source: https://github.com/grosa787/localcode
