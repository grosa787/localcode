# Scoop (Windows)

LocalCode is distributed for Windows through [Scoop](https://scoop.sh), the
command-line installer for Windows. The published manifest lives in the
external bucket repository [`grosa787/scoop-bucket`](https://github.com/grosa787/scoop-bucket)
and is refreshed automatically by the `release-scoop.yml` GitHub Action on every
tagged release.

## Install (end users)

```powershell
# 1. Install Scoop itself if you do not already have it.
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression

# 2. Add the LocalCode bucket.
scoop bucket add localcode https://github.com/grosa787/scoop-bucket

# 3. Install LocalCode.
scoop install localcode

# 4. Verify.
localcode --version
```

Update later with:

```powershell
scoop update localcode
```

Uninstall with:

```powershell
scoop uninstall localcode
```

## What the manifest provides

- `localcode.exe` placed on `PATH` automatically by Scoop.
- Architecture-aware install: 64-bit installs the `x64` build. ARM64 is wired
  in the manifest but published only when the upstream release ships a
  `localcode-win-arm64.zip` artifact (Bun does not currently ship a standalone
  runtime for Windows ARM64, so x64 is the default channel today).
- `scoop checkver localcode` queries the GitHub Releases API of
  `grosa787/localcode` so users can audit drift between manifest and release.

## Maintainer setup (one-time)

The auto-update workflow (`release-scoop.yml`) needs to push commits to a
separate repository, so the default `GITHUB_TOKEN` is not enough. Configure:

1. **Create the bucket repository** at `grosa787/scoop-bucket` if it does not
   yet exist. Initialise it with an empty `bucket/` directory and a short
   README pointing users at this docs page.

2. **Create a fine-grained personal access token**:
   - GitHub → Settings → Developer settings → Personal access tokens →
     Fine-grained tokens → **Generate new token**.
   - Resource owner: `grosa787` (or whichever GitHub account owns
     `scoop-bucket`).
   - Repository access: **Only select repositories** → `grosa787/scoop-bucket`.
   - Repository permissions: **Contents: Read and write**.
   - Expiry: pick the policy you are comfortable with (the workflow only runs
     on tagged releases, so a long expiry is reasonable).

3. **Add the token as a repository secret** in `grosa787/localcode`
   (Settings → Secrets and variables → Actions → New repository secret):
   - Name: `SCOOP_BUCKET_PAT`
   - Value: the token from step 2.

The workflow refuses to run when the secret is missing — it prints a clear
error pointing back to this document.

## How releases reach the bucket

```
git tag v0.X.Y  ──►  release.yml (builds + uploads localcode-win-x64.zip)
                ─►  release-scoop.yml
                     ├─ downloads the Windows zip(s) + .sha256
                     ├─ verifies checksums
                     ├─ renders dist/scoop/localcode.json with the new
                     │   version + hash placeholders substituted
                     └─ commits + pushes bucket/localcode.json to
                        grosa787/scoop-bucket on the default branch
```

The template at `dist/scoop/localcode.json` is the single source of truth for
manifest shape. Edits there flow to the bucket on the next release.

## Manual republish

If a release was tagged before `release-scoop.yml` existed (or it failed for
transient reasons) you can re-run it by hand:

1. Open the **Actions** tab in `grosa787/localcode`.
2. Pick **Release Scoop Manifest**.
3. Click **Run workflow**, enter the tag (e.g. `v0.20.0`), and confirm.

The job is idempotent: if `bucket/localcode.json` is already in sync it exits
without creating an empty commit.

## Troubleshooting

- **`scoop install localcode` reports "couldn't match 'localcode'"** — the
  bucket has not been added or the manifest filename is wrong. Re-run
  `scoop bucket add localcode https://github.com/grosa787/scoop-bucket`,
  then `scoop update`.
- **`Hash check failed`** — the zip was rebuilt after the manifest was
  published (or the wrong artifact is on the release). Trigger
  `release-scoop.yml` manually for that tag to refresh the hash.
- **Workflow fails with "SCOOP_BUCKET_PAT is not set"** — see the
  maintainer setup section above; the secret must exist on
  `grosa787/localcode`.
