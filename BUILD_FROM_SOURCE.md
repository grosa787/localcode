# Building LocalCode from source

This repo (`grosa787/localcode`) is the **public-facing distribution shell**. It contains the README, the installer, the landing page, packaging metadata, and the issue tracker. **It does not contain the source code.**

Active development happens in a separate, private repo at `grosa787/localcode-private`. This document explains why, what that means for you, and how to contribute if you'd like to work on the code.

## Why is the source private?

LocalCode is distributed under the [MIT License](LICENSE) — the **binary** you install is free to use, modify, and redistribute. We chose to keep the **source repository** private for these reasons:

1. **Iteration speed.** A small team without a public-PR review queue can ship faster.
2. **Focused community surface.** Public Issues are the right place to talk about bugs and features. Public Pull Requests against a fast-moving codebase tend to either rot in review or pressure us into landing things we'd rather rewrite.
3. **License preservation.** Anyone who downloaded LocalCode under MIT before this split keeps that license forever. Closing future development does not retroactively close past releases.

We model this after Claude Code, which uses the same pattern: a public repo for installs, docs, and issues; closed source.

## What is in this repo?

- `README.md`, `README.ru.md` — user-facing documentation
- `LICENSE` — MIT terms covering the binary you install
- `install.sh` — the one-line installer; downloads from [Releases](https://github.com/grosa787/localcode/releases)
- `docs/` — user-facing reference (commands, providers, tools, configuration)
- `packages/npm/` — the `npm install -g localcode` shim that downloads + verifies the right release tarball
- `packaging/nfpm.yaml` — DEB and RPM package metadata
- `website/` — the landing page (`grosa787.github.io/localcode`)
- `.github/workflows/` — `release.yml` (build artefacts), `packages.yml` (DEB/RPM), `pages.yml` (landing page deploy), `lockdown.yml` (prevents accidental source leaks)

## How do I install it without building?

You don't need source. From the [Releases](https://github.com/grosa787/localcode/releases) page, every tag publishes:

- `localcode-darwin-x64.tar.gz`
- `localcode-darwin-arm64.tar.gz`
- `localcode-linux-x64.tar.gz`
- `localcode-linux-arm64.tar.gz`
- `SHA256SUMS` (verify every asset)
- `sbom.cyclonedx.json` (full dependency manifest)
- `.deb` and `.rpm` packages for Debian / Fedora-family distros

The recommended path is `install.sh`:

```sh
curl -fsSL https://raw.githubusercontent.com/grosa787/localcode/main/install.sh | bash
```

It auto-detects your platform, downloads the matching tarball, verifies the SHA-256 against `SHA256SUMS`, extracts the binary, and symlinks it into `$HOME/.local/bin/`.

## How do I contribute code?

If you want to work on internals (TUI, adapters, tools, web frontend), see [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version:

1. Open an issue describing what you'd like to change and why.
2. Sign a one-page CLA (we'll send the link).
3. We invite you as an outside collaborator on the private source repo.
4. Submit a PR there.

There is no minimum-prior-contribution gate. We do gate on whether the change is well-scoped and well-justified, which is what the initial issue discussion handles.

## What about forks?

Forks of this public repo will only ever contain the distribution shell, not source. You can:

- Fork to keep a personal copy of the installer or packaging configuration.
- Fork to propose changes to docs / website / packaging (then send a PR back).
- Fork to redistribute the LocalCode binary under MIT in your own channels — that's explicitly permitted by the license.

Forks **cannot** be used to build LocalCode from source, because the source isn't here.

## What about the history?

This public repo retains its full git history, including commits made before the source was moved to private. Anything that was published under MIT remains usable under MIT — that's how open-source licensing works and we have no interest in clawing it back. If you have an old clone and want to build from it, that's fine; we just won't be merging PRs against it from this repo going forward.

If we ever decide to re-publish source under a different license (AGPL, BUSL, etc.), it will be announced clearly in `CHANGELOG.md` and on the landing page.

## Security disclosures

Don't post security issues in public. Email `security@<see-website-contact>` or use GitHub's "[Report a security vulnerability](https://github.com/grosa787/localcode/security/advisories/new)" flow on this repo. We'll respond within 5 business days.

## Questions

Open an issue. We read every one.
