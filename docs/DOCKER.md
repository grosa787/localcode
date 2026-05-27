# Docker

LocalCode ships as a multi-arch Docker image to GitHub Container Registry:

```
ghcr.io/grosa787/localcode:latest   # rolling tag for the latest release
ghcr.io/grosa787/localcode:v0.22.0  # immutable per-release tag
ghcr.io/grosa787/localcode:0.22.0   # same image, no `v` prefix
```

Supported platforms: **`linux/amd64`** and **`linux/arm64`**.

## TL;DR

```sh
# TUI (requires an interactive TTY)
docker run -it --rm ghcr.io/grosa787/localcode:latest

# Web UI (port-mapped, no TTY needed)
docker run --rm -p 7777:7777 ghcr.io/grosa787/localcode:latest \
  --web --web-host 0.0.0.0 --no-open

# Real-world usage: mount your project + persist config + pass API key
docker run -it --rm \
  -v "$(pwd):/workspace" \
  -v "$HOME/.localcode:/root/.localcode" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  ghcr.io/grosa787/localcode:latest
```

## Authentication (pulling)

The image is **public** — no `docker login` required to `docker pull`.

If you ever need to authenticate against GHCR (e.g. for rate limits, or
pulling from a private fork), use a GitHub personal access token with
`read:packages`:

```sh
echo "$GHCR_PAT" | docker login ghcr.io -u <your-github-username> --password-stdin
```

## TUI mode (default)

The default `ENTRYPOINT` runs the terminal UI, which requires both **`-i`**
(stdin attached) and **`-t`** (TTY allocated) — without them ink will exit
immediately with `Raw mode is not supported on the current process.stdin`.

```sh
docker run -it --rm \
  -v "$(pwd):/workspace" \
  -v "$HOME/.localcode:/root/.localcode" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  ghcr.io/grosa787/localcode:latest
```

| Flag                                       | Why                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `-it`                                      | TUI needs interactive stdin + TTY for keystrokes / ANSI / colors.         |
| `--rm`                                     | Remove the container on exit so it doesn't pile up.                       |
| `-v "$(pwd):/workspace"`                   | Bind-mount your code so the model can read/write it.                      |
| `-v "$HOME/.localcode:/root/.localcode"`   | Persist config, sessions DB, memory, skills across runs.                  |
| `-e <PROVIDER>_API_KEY=...`                | Pass cloud credentials in (never bake them into the image).               |

The container's `WORKDIR` is `/workspace`, so omitting an explicit positional
path makes LocalCode treat your mounted project as the active project root.

## Web mode (`--web`)

The web UI doesn't need a TTY, but you do need to bind it to `0.0.0.0`
inside the container (the default `127.0.0.1` won't be reachable from your
host) and map the port:

```sh
docker run --rm \
  -p 7777:7777 \
  -v "$(pwd):/workspace" \
  -v "$HOME/.localcode:/root/.localcode" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  ghcr.io/grosa787/localcode:latest \
  --web --web-host 0.0.0.0 --no-open
```

Then open the printed URL (look for the CSRF-tokened
`http://0.0.0.0:7777/#token=...`) in your browser. Substitute `0.0.0.0`
with `127.0.0.1` (or your machine's hostname) for the browser address bar.

`--no-open` is required inside containers because there is no host browser
to spawn; the URL is still printed to stdout.

## Connecting to a local LLM (Ollama / LM Studio)

Cloud providers (OpenAI / Anthropic / OpenRouter / Gemini) work
out-of-the-box once you pass the API key. For **local** backends running
on the Docker host, the container has to reach them:

- **macOS / Windows (Docker Desktop):** use `host.docker.internal` as the
  hostname when configuring LocalCode's backend URL:

  ```
  http://host.docker.internal:11434   # Ollama
  http://host.docker.internal:1234    # LM Studio
  ```

- **Linux:** add `--add-host=host.docker.internal:host-gateway` to your
  `docker run` so the same name resolves to the host's gateway:

  ```sh
  docker run -it --rm \
    --add-host=host.docker.internal:host-gateway \
    -v "$(pwd):/workspace" \
    -v "$HOME/.localcode:/root/.localcode" \
    ghcr.io/grosa787/localcode:latest
  ```

  Then on the LLM host make sure the server is bound to all interfaces
  (`OLLAMA_HOST=0.0.0.0 ollama serve`, or LM Studio "Serve on Local
  Network").

## Environment variables

LocalCode reads provider API keys from env when no explicit `apiKey` is set
in `~/.localcode/config.toml`. Pass them with `-e`:

```sh
docker run -it --rm \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  -e GEMINI_API_KEY="$GEMINI_API_KEY" \
  ghcr.io/grosa787/localcode:latest
```

For bulk env passthrough, use an env-file:

```sh
docker run -it --rm --env-file ~/.localcode/env.list \
  -v "$(pwd):/workspace" \
  -v "$HOME/.localcode:/root/.localcode" \
  ghcr.io/grosa787/localcode:latest
```

## Persisting state

Mount `/root/.localcode` to keep everything LocalCode writes:

```
~/.localcode/config.toml          # global config (provider, model, profile)
~/.localcode/sessions.db          # SQLite — full chat history
~/.localcode/memory/              # per-project memory entries
~/.localcode/skills/              # global markdown skills
~/.localcode/updates/             # update cache
```

If the host file doesn't yet exist, create the directory first so Docker
doesn't auto-create a root-owned file:

```sh
mkdir -p ~/.localcode
docker run -it --rm \
  -v "$HOME/.localcode:/root/.localcode" \
  ghcr.io/grosa787/localcode:latest
```

## Project-level config

The project's `.localcode/` directory (LOCALCODE.md, settings.json,
arch.toml, sensitive-files.toml, skills/, memory/) lives **inside the
bind-mounted workspace**, so `-v "$(pwd):/workspace"` already takes care
of it.

## docker-compose example

```yaml
# compose.yaml
services:
  localcode:
    image: ghcr.io/grosa787/localcode:latest
    stdin_open: true                # -i
    tty: true                       # -t
    working_dir: /workspace
    volumes:
      - ./:/workspace
      - ~/.localcode:/root/.localcode
    environment:
      - OPENAI_API_KEY
      - ANTHROPIC_API_KEY
      - OPENROUTER_API_KEY
      - GEMINI_API_KEY
    # Override for web mode:
    # ports: ["7777:7777"]
    # command: ["--web", "--web-host", "0.0.0.0", "--no-open"]
```

Then: `docker compose run --rm localcode` (TUI).

## Building locally

The Dockerfile lives at the repo root. To build a local single-arch image
(no push):

```sh
docker build -t localcode:dev .
docker run -it --rm localcode:dev --version
```

For a multi-arch build mirroring the release workflow (requires `buildx`):

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t localcode:multi \
  --load .                          # `--load` only works for a single platform
```

To push to your own GHCR namespace:

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/<you>/localcode:dev \
  --push .
```

## Image size

The runtime image is built FROM `oven/bun:1.1-alpine` and contains only
`/usr/local/bin/localcode.js` (the bundled CLI, ~14 MB) plus the Bun
runtime — no `node_modules`, no source tree, no tests, no docs. The
target uncompressed size is **< 200 MB** per architecture.

## CI / release workflow

`.github/workflows/release-docker.yml` builds + pushes on every `v*` tag
push (and on `workflow_dispatch` for manual re-publishes). It uses
`docker/buildx` for linux/amd64 + linux/arm64, publishes provenance + SBOM
attestations, and tags every release with three names:

- `:latest` (rolling)
- `:vX.Y.Z` (tag literal)
- `:X.Y.Z` (numeric, for tooling that strips the `v`)

### Auth in CI

The workflow auto-prefers a repo / org secret named **`GHCR_PAT`** (a
classic PAT with `write:packages`) over the default `GITHUB_TOKEN`. For
pushes to `ghcr.io/${{ github.repository_owner }}/localcode` the default
token's `packages: write` scope is sufficient — `GHCR_PAT` is only needed
when:

- you push to a namespace different from `repository_owner` (e.g. an
  org-owned image from a personal-repo workflow), or
- the org has disabled `GITHUB_TOKEN` write access to packages.

## Caveats

- **No native compilation.** The image runs `bun /usr/local/bin/localcode.js`
  rather than a `bun build --compile`'d native binary. Native compile per
  arch would need separate `linux-x64` and `linux-arm64` builders; the
  JS-bundle approach is simpler, smaller, and keeps `--web` / `playwright`
  externals working identically across arches.
- **Playwright / browser tools.** The CLI marks `playwright` and
  `chromium-bidi` as **externals** in the bundle. The browser tools
  (`browser_navigate`, `browser_click`, etc.) will fail inside this image
  unless you extend it with a Playwright-bundled base
  (`mcr.microsoft.com/playwright`) — by default LocalCode runs without
  them. PRs welcome for a `:browser` variant.
- **Sub-agent worktrees.** `git worktree` requires `git` inside the
  container. The base image is Alpine; if you need `git`, install it with
  `apk add --no-cache git` in a derived image, or use the host's
  `~/.localcode` mount and run agents on the host instead.
- **SQLite WAL across mounts.** Bind-mounting `~/.localcode` works fine
  for normal use; concurrent access from both host and container at the
  same time is undefined (use one or the other).
- **No auto-open browser.** Always pass `--no-open` when using `--web`
  inside the container.
