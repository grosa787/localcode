# Homebrew distribution

LocalCode publishes a Homebrew formula via a separate **tap repository**
(`grosa787/homebrew-tap`). The tap is auto-bumped on every `v*` release by the
`.github/workflows/release-homebrew.yml` workflow in this repo.

## Install (end users)

```sh
brew install grosa787/tap/localcode
```

Brew resolves `grosa787/tap` to `https://github.com/grosa787/homebrew-tap`,
adds it as a tap, then installs the `localcode` formula from it. The formula
downloads the prebuilt tarball for your platform (`darwin-arm64`,
`darwin-x64`, `linux-arm64`, `linux-x64`) from the matching GitHub Release.

Upgrade later with:

```sh
brew upgrade localcode
```

Uninstall:

```sh
brew uninstall localcode
brew untap   grosa787/tap   # optional — remove the tap entirely
```

## One-time maintainer setup

The auto-bump workflow needs a tap repo and a token. Do these once.

### 1. Create the tap repository

Homebrew requires the repo name to start with `homebrew-`:

```sh
gh repo create grosa787/homebrew-tap --public \
  --description "Homebrew tap for LocalCode"
```

Then bootstrap a minimal layout (anything is fine — the workflow overwrites
`Formula/localcode.rb` on first run):

```sh
git clone https://github.com/grosa787/homebrew-tap.git
cd homebrew-tap
mkdir -p Formula
printf '# grosa787/homebrew-tap\n\nHomebrew tap for [LocalCode](https://github.com/grosa787/localcode).\n\n```sh\nbrew install grosa787/tap/localcode\n```\n' > README.md
git add README.md Formula
git commit --allow-empty -m "bootstrap"
git push origin main
```

### 2. Create the `HOMEBREW_TAP_PAT` secret

The workflow needs to commit and push to `grosa787/homebrew-tap` from inside
the action — `GITHUB_TOKEN` only has rights on the source repo, so a separate
token is required.

1. Visit <https://github.com/settings/personal-access-tokens/new> (fine-grained
   PAT, recommended over classic).
2. **Resource owner**: `grosa787` (your user).
3. **Repository access**: *Only select repositories* → pick
   `grosa787/homebrew-tap` (and **only** that repo).
4. **Repository permissions**:
   - `Contents` → **Read and write**
   - `Metadata` → Read-only (auto-selected).
   Leave everything else as default.
5. **Expiration**: 90–365 days. Rotate before it expires.
6. Generate. Copy the token (`github_pat_...`).
7. Back in the LocalCode source repo:
   `gh secret set HOMEBREW_TAP_PAT --body '<paste-token>' \
      --repo grosa787/localcode`
   (or via the web UI: *Settings → Secrets and variables → Actions → New
   repository secret*).

### 3. First-run verification

Cut a release as usual (`git tag -a vX.Y.Z -m '...' && git push origin vX.Y.Z`).
After `release.yml` finishes uploading the tarballs and `SHA256SUMS`,
`release-homebrew.yml` runs automatically:

1. Waits for `SHA256SUMS` to appear on the GitHub Release (≤30 min).
2. Downloads it, extracts the per-tarball SHA-256 hashes.
3. Renders `dist/homebrew/localcode.rb` (the template in this repo) with the
   version + hashes substituted.
4. Pushes the result to `grosa787/homebrew-tap` as `Formula/localcode.rb` with
   commit message `localcode <version>`.

Smoke-test the install end to end:

```sh
brew untap   grosa787/tap          2>/dev/null || true
brew install grosa787/tap/localcode
localcode --version
brew uninstall localcode
```

## Re-running for an existing release

If a release's tarballs were re-published (e.g. SBOM regen, manual rebuild
via `workflow_dispatch`), trigger the tap bump manually:

```sh
gh workflow run release-homebrew.yml \
  --repo grosa787/localcode \
  --field tag=v0.22.0
```

## How the template works

`dist/homebrew/localcode.rb` is a static template with five placeholders the
workflow substitutes with `sed`:

| Placeholder                | Replaced with                                    |
| -------------------------- | ------------------------------------------------ |
| `__VERSION__`              | Tag minus the `v` prefix (e.g. `0.22.0`)         |
| `__SHA256_DARWIN_ARM64__`  | `sha256(localcode-darwin-arm64.tar.gz)`          |
| `__SHA256_DARWIN_X64__`    | `sha256(localcode-darwin-x64.tar.gz)`            |
| `__SHA256_LINUX_ARM64__`   | `sha256(localcode-linux-arm64.tar.gz)`           |
| `__SHA256_LINUX_X64__`     | `sha256(localcode-linux-x64.tar.gz)`             |

All four hashes come straight out of the `SHA256SUMS` file produced by
`release.yml` — Homebrew downloads the same tarballs that `install.sh` and the
`.deb`/`.rpm` builds consume, so there is exactly one source of truth per
release.

## Troubleshooting

- **`brew install` says `404` on a tarball URL** — `release.yml` likely failed
  to upload one of the platform archives. Re-run it, then re-run
  `release-homebrew.yml`.
- **`SHA256 mismatch`** — the tarball was re-uploaded after the formula was
  bumped. Re-run `release-homebrew.yml` for that tag; brew will then accept
  the updated hash on next `brew upgrade`.
- **Workflow fails with `Resource not accessible by integration`** — the
  `HOMEBREW_TAP_PAT` secret is missing, expired, or scoped to the wrong repo.
  Re-create per step 2 above.
- **Workflow times out waiting for `SHA256SUMS`** — `release.yml` failed.
  Inspect that workflow's logs; once it succeeds, re-run
  `release-homebrew.yml` for the same tag via `workflow_dispatch`.
