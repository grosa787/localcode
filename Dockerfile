# syntax=docker/dockerfile:1.7
#
# LocalCode multi-stage Dockerfile.
#
# Stage 1 (builder): full Bun toolchain — installs deps (frozen), runs the
# canonical `bun run build` pipeline (web bundle → embed-web → bun build CLI).
#
# Stage 2 (runtime): minimal Bun runtime image with ONLY the bundled
# `dist/cli.js` from the builder. Final image targets < 200 MB.
#
# Buildx multi-arch (linux/amd64 + linux/arm64) is handled by the GitHub
# Actions workflow; this Dockerfile is platform-agnostic.

# ---------------------------------------------------------------------------
# Stage 1: build the JS bundle (CLI + embedded web SPA).
# ---------------------------------------------------------------------------
FROM oven/bun:1.1-alpine AS builder

WORKDIR /build

# Copy lockfile + manifests first so dep install caches independently of
# source-only edits. `bun install --frozen-lockfile` mirrors CI.
COPY package.json bun.lock ./
COPY web-frontend/package.json ./web-frontend/

RUN bun install --frozen-lockfile

# Copy the rest of the source. `.dockerignore` excludes dist/, node_modules,
# tests, docs, etc. so this layer stays tight.
COPY . .

# `bun run build` = build:web (Vite) → embed-web (base64 into TS module)
# → build:cli (bun build src/cli.tsx → dist/cli.js with playwright/electron
# externals). Output: dist/cli.js (~14 MB bundled JS).
RUN bun run build && test -f dist/cli.js

# ---------------------------------------------------------------------------
# Stage 2: runtime — Bun runtime + bundle only. No node_modules, no source.
# ---------------------------------------------------------------------------
FROM oven/bun:1.1-alpine

LABEL org.opencontainers.image.title="LocalCode" \
      org.opencontainers.image.description="Local-first AI coding assistant" \
      org.opencontainers.image.source="https://github.com/grosa787/localcode" \
      org.opencontainers.image.url="https://github.com/grosa787/localcode" \
      org.opencontainers.image.documentation="https://github.com/grosa787/localcode/blob/main/docs/DOCKER.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="LocalCode"

# Tiny shim so users can run `localcode` instead of `bun /usr/local/bin/localcode.js`.
COPY --from=builder /build/dist/cli.js /usr/local/bin/localcode.js
RUN printf '#!/bin/sh\nexec bun /usr/local/bin/localcode.js "$@"\n' > /usr/local/bin/localcode \
    && chmod +x /usr/local/bin/localcode

# Default working directory the user is expected to bind-mount their project into.
WORKDIR /workspace

# Web UI default port (configurable via --web-port). Documented for `-p` mapping.
EXPOSE 7777

ENTRYPOINT ["localcode"]
