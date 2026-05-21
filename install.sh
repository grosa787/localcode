#!/bin/bash
set -e

# LocalCode installer
# - Installs dependencies with Bun
# - Builds the CLI bundle
# - Symlinks the bundle to /usr/local/bin/localcode (sudo)

if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' is not installed. Install it from https://bun.sh first." >&2
  exit 1
fi

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "==> Installing dependencies..."
bun install

echo "==> Building (web + cli)..."
bun run build:web
bun run embed-web
bun build src/cli.tsx --outdir dist --target bun \
  --external react-devtools-core \
  --external playwright \
  --external playwright-core \
  --external chromium-bidi \
  --external electron

chmod +x dist/cli.js

LINK_TARGET="/usr/local/bin/localcode"
echo "==> Linking $SCRIPT_DIR/dist/cli.js -> $LINK_TARGET"
sudo ln -sf "$SCRIPT_DIR/dist/cli.js" "$LINK_TARGET"

echo ""
echo "localcode installed to $LINK_TARGET"
echo "Run 'localcode --help' to get started."
