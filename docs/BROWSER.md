# Browser sandbox

LocalCode ships an optional headless-Chromium sandbox for the LLM and
the (forthcoming) web UI. One Chromium per chat session, controlled
via Playwright, exposed to the model as eight `browser_*` tools.

## Setup

```sh
bun install
bunx playwright install chromium   # one-time download
```

If Chromium is missing the first browser tool call returns:

> Failed to load Playwright. Install the dep with "bun install" and the
> browser with "bunx playwright install chromium" to enable browser tools.

## Tools

| Tool | Args | Returns |
| --- | --- | --- |
| `browser_navigate` | `{ url }` | `Navigated to <url> — title: <title>` |
| `browser_screenshot` | `{}` | Multimodal PNG (vision-capable models) |
| `browser_click` | `{ selector? } \| { x, y }` | `Clicked <target>` |
| `browser_type` | `{ selector, text }` | `Typed N chars into <selector>` |
| `browser_press_key` | `{ key }` | `Pressed <key>` |
| `browser_evaluate` | `{ js }` | JSON-stringified result, truncated at 8 KB |
| `browser_console_messages` | `{ level? }` | `[level] text` lines, filtered |
| `browser_reload` | `{}` | `Reloaded — <url>` |

None of the eight require approval — they are read-only on the page in
the sense that they cannot escape the sandbox. Side-effects on the
remote site (form submissions, auth flows, etc.) are still possible —
keep that in mind when granting access to internal staging hosts.

## Domain allowlist

Default allowlist: `localhost`, `127.0.0.1`, `*.local`, `file://`.

`navigate()` rejects any URL whose host doesn't match. To extend, pass
`allowDomains` to `createBrowserSession` (or eventually
`config.browser.allowDomains` in `~/.localcode/config.toml`).

## Streaming events

`BrowserSession.subscribe(events)` lets the web runtime tap into:

- `onFrame(frame)` — JPEG screencast frame (~10 fps, q=70) emitted from
  the CDP `Page.screencastFrame` hook in `attachScreencast()`.
- `onCursor(event)` — animation hint emitted before each click/hover/type.
- `onConsole(event)` — page console + `pageerror` events.
- `onError(err)` — non-fatal CDP / dispatch errors.

The session keeps the last 200 console events in a ring buffer and the
most recent screencast frame so a late subscriber receives an
immediate replay.

## Lifecycle

- `createBrowserSession(opts)` does NOT launch Chromium.
- The first tool call (or explicit `start()`) launches it.
- `close()` is idempotent and tears the browser down cleanly. The
  Playwright process is reaped automatically on Bun process exit.

## Tests

```sh
bun test tests/browser/                    # unit tests; no Chromium needed
LOCALCODE_E2E_BROWSER=1 bun test tests/browser/   # adds the e2e smoke
```

The unit suite injects a fake `BrowserLauncher` so the public surface
can be exercised without downloading Chromium.
