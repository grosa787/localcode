# `run_command` Sandbox

LocalCode wraps every `run_command` invocation in an OS-native isolation
envelope so that even pre-approved commands (under `autoApprove`,
`dontAsk`/`bypassPermissions` profiles, or `--dangerously-allow-all`)
cannot freely write outside the project root or open network sockets
when the user has tightened the policy.

The sandbox layer is **defense-in-depth** — it sits in addition to the
existing approval prompts, dangerous-pattern denylist, and permission
profiles. It is not a substitute for any of them.

## Default behaviour per platform

| Platform | Backend on `auto` | Available when |
|----------|-------------------|----------------|
| macOS    | `sandbox-exec`    | Always (system binary at `/usr/bin/sandbox-exec`) |
| Linux    | `firejail`        | `firejail` package installed (probes `$PATH` + `/usr/bin`, `/usr/local/bin`, `/opt/firejail/bin`) |
| Linux (no firejail) | `none` (passthrough with warning) | Always |
| Windows  | `none` (TBD)      | Always (no native sandbox yet) |
| Other    | `none` (passthrough with warning) | Always |

When the requested backend is unavailable, the factory falls back to
the `none` runner and logs a one-time warning so the user knows
sandboxing is off.

## Configuration

Add a `[sandbox]` section to `~/.localcode/config.toml`:

```toml
[sandbox]
# 'auto' picks the best native backend for the platform.
# Explicit values: 'sandbox-exec' | 'firejail' | 'docker' | 'none'.
backend = "auto"

# When false, the sandbox blocks outbound network sockets. Default
# true because most dev commands (bun install, git clone, ...) need
# network access.
allowNetwork = true

# Absolute paths the command may write to in addition to the project
# root. The project root and platform scratch zones (/tmp, /private/tmp,
# etc. on macOS) are always allowed.
allowWritePaths = [
  "/Users/me/.npm",
  "/Users/me/.cache/bun",
]

# Upper wall-clock cap in milliseconds. Default 120_000 (2 minutes).
# The existing 30-second `run_command` envelope still applies on top.
timeoutMs = 120000

# Image used by the `docker` backend. Defaults to `alpine:latest` —
# the smallest image that ships `sh`. Ignored by other backends.
# dockerImage = "alpine:3.20"
```

All fields are optional — absence yields the defaults above.

## Per-call opt-out

The model can request a passthrough execution for a single command via
the `sandbox: false` argument:

```json
{"command": "docker build .", "sandbox": false}
```

The user still approves the call (the sandbox is independent of the
approval prompt). Use this only when the sandbox profile is genuinely
incompatible with the command (e.g. invoking docker from inside a
sandboxed environment).

## Backend internals

### `sandbox-exec` (macOS)

Generates a Scheme profile string at runtime:

```
(version 1)
(deny default)
(allow process*)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow file-read*)
(allow file-write*
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (subpath "/private/var/tmp")
  (subpath "/tmp")
  (subpath "<cwd>")
  (subpath "<allowWritePath_1>")
  ...
)
(allow network*)              ;; when allowNetwork=true
;; network denied             ;; when allowNetwork=false
```

Then runs `sandbox-exec -p <profile> sh -c <cmd>`.

**Note:** `sandbox-exec` is officially deprecated by Apple but remains
shipped on every macOS release including Sonoma (14) and Sequoia (15).
LocalCode ships it until Apple removes the binary; on a hypothetical
Tahoe release that drops it, the factory's `existsSync(/usr/bin/sandbox-exec)`
check will fall back to `none` and log a warning.

### `firejail` (Linux)

Runs the command as:

```
firejail --quiet --read-only=/ --private-tmp \
  [--net=none] \
  --read-write=<cwd> \
  [--read-write=<allowWritePath_1>] ... \
  sh -c <cmd>
```

`firejail` is the canonical Linux user-mode sandbox. Install with
`apt install firejail` (Debian/Ubuntu), `pacman -S firejail` (Arch),
`dnf install firejail` (Fedora), or `apk add firejail` (Alpine).

### `docker` (opt-in)

Runs the command inside an ephemeral container with the working
directory bind-mounted at `/workspace`:

```
docker run --rm -i \
  -w /workspace \
  -v <cwd>:/workspace \
  [-v <allowWritePath_i>:<allowWritePath_i>] \
  [--network=none] \
  <image> \
  sh -c <cmd>
```

Requires a running Docker daemon. Slower than the native backends
(per-call container spin-up) but offers the strongest isolation. Set
`config.sandbox.dockerImage` to use a custom image; the default
`alpine:latest` is the smallest image shipping a POSIX `sh`.

### `none` (passthrough)

Direct `execa('sh', ['-c', cmd])` — no isolation. Emits a one-time
process-level warning on first use. Useful for:

- Hosts without a native sandbox backend.
- Diagnosing whether a failure is caused by the sandbox profile.
- Workflows that intentionally need full host access.

## Disable sandboxing entirely

Set `backend = "none"` in the config:

```toml
[sandbox]
backend = "none"
```

Or use the per-call opt-out (`{"sandbox": false}`) for individual
commands while leaving the default policy intact.

## Failure modes

The sandbox layer is **best-effort and never blocks tool execution**:

1. If the configured backend's binary is missing at runtime, the
   factory falls back to `none` and warns once per process.
2. If the runner throws a spawn-level error (e.g. seccomp denial,
   missing capability), the tool catches it, warns, and re-runs the
   command directly via `execa`. The model still sees a `ToolResult`
   with `success: true` or `false` based on the actual command exit.
3. Sandbox profile generation errors are not silently swallowed — a
   bug in the profile builder will surface as a tool failure on the
   next invocation.

## Security caveats

This layer does NOT defend against:

- Reads of files anywhere on the host (the profile allows `file-read*`
  globally on macOS; firejail mounts `/` read-only). Secrets in the
  user's home dir remain readable. If you need read isolation, set
  `backend = "docker"` and the model only sees the bind-mounted paths.
- Side channels via `/proc`, `sysctl`, env vars, or process arguments.
- Network exfiltration when `allowNetwork = true` (the default).
- Privilege-escalation flaws in the backend itself.

Defense-in-depth means combining the sandbox with: per-command
approval, the dangerous-command denylist, the secret-scanner hook,
and conservative `allowWritePaths` lists.
