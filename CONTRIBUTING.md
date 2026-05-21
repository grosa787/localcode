# Contributing to LocalCode

Thanks for wanting to help. Here's how the project is organised and what kinds of contributions we can accept.

## Where things live

- **Public repo (`grosa787/localcode`)** — what you're looking at. Hosts:
  - User-facing docs (`README.md`, `docs/`)
  - The installer (`install.sh`)
  - Release artefacts (downloadable from [Releases](https://github.com/grosa787/localcode/releases))
  - Packaging shims (`packages/npm/`, `packaging/`)
  - Landing page (`website/`)
  - The issue tracker (this is the primary place to report bugs and request features)
- **Private repo (`grosa787/localcode-private`)** — the active source code, tests, and CI. Not publicly browsable.

We chose this split deliberately. The binary you install is open under MIT — you can use, modify, and redistribute the binary freely. The source repository itself is private to give us room to iterate without OSS-style review overhead while still keeping a public surface for bug reports, downloads, and community discussion. See `BUILD_FROM_SOURCE.md` for the trade-offs and contributor path.

## What you can do without source access

These are the highest-leverage contributions and they need zero special access:

### Bug reports

[Open an issue](https://github.com/grosa787/localcode/issues/new). Please include:

- LocalCode version (`localcode --version`)
- OS + architecture (`uname -sm`)
- Bun version (`bun --version`)
- Minimal repro: what you ran, what you expected, what happened
- If relevant: redacted `~/.localcode/config.toml` and the contents of `~/.localcode/logs/` for the failing session

### Feature requests

Open an issue with the `enhancement` label. Tell us:

- The user problem (not the proposed implementation — we'll figure that out together)
- Whether you have a workaround today
- Whether you'd be willing to test a preview build

### Documentation fixes

Anything under `docs/`, `README.md`, `README.ru.md`, and the landing-page content under `website/src/content/` is editable from the public repo. Open a PR; we'll review.

### Packaging contributions

`packaging/nfpm.yaml`, `packages/npm/`, and `install.sh` are all here. Improvements to install reliability, distro support, or `npm`/`brew` integration are welcome via PRs to this repo.

### Landing page

`website/` is a standalone Vite + React site. Stylistic fixes, accessibility improvements, content corrections — all PR-friendly.

## What requires source access

If you want to fix a runtime bug, add a feature, or refactor internals, you need access to the private source repo. Here's how that works:

1. **Open an issue first** describing what you'd like to change and why. This lets us tell you quickly if it's already in flight or out of scope.
2. **Sign a CLA.** We require a short Contributor License Agreement to accept code into the private repo. The CLA is a one-page document; we'll send a link after step 1.
3. **Get invited.** Once the CLA is on file and the scope is agreed, we add you as an outside collaborator to `grosa787/localcode-private` with PR-only access.
4. **Submit a PR** in the private repo. Same review standards as any project — typed (no `any`, no `@ts-ignore`), tested, and the change must be justified in the PR description.

We don't gate access on prior LocalCode contributions — first-time contributors are welcome. We do gate on signal that the change is well-thought-out, which is what step 1 is for.

## What we won't accept

- **Verbatim clones of the source into the public repo.** The lockdown workflow (`.github/workflows/lockdown.yml`) blocks this automatically; please don't try to bypass it.
- **PRs against the public repo that would re-introduce `src/`, `tests/`, `tsconfig.json`, etc.** These belong in the private repo, not here.
- **Telemetry / analytics additions** that send data anywhere without an explicit opt-in. LocalCode is local-first; that's a hard line.
- **Bundled credentials** of any kind in any artefact.

## Licensing

The compiled binary, the installer, the documentation, the landing page, and the npm/deb/rpm packages are licensed under [MIT](LICENSE). You can use, redistribute, fork, or sell them under those terms.

Source contributions you make to the private repo are assigned under the CLA so we can keep the licensing of future binaries consistent. The CLA does not change the license of past releases; anything you've already received under MIT remains MIT.

## Code of conduct

Be kind. Don't dump on contributors who report incomplete bugs — help them refine. Don't engage with adversarial issue threads; let maintainers handle it. The community standard is [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

## Questions?

Open a [Discussion](https://github.com/grosa787/localcode/discussions) (if enabled) or an issue labelled `question`. We read every one.
