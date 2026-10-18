# pi-notify

Desktop notifications for Pi questions, permission requests, and final readiness.
Extracted from the ORGM `pi-harness` bundle.

## Install

```bash
pi install git:github.com/osmargm1202/pi-notify
```

Also included in `git:github.com/osmargm1202/pi-harness`.

## Behavior

- Question tools: `ask_user_question`, `question`.
- Permission tools: `ask_user_permission`, `request_permission`,
  `permission_request`, `confirm_permission` (case-insensitive).
- Final readiness: `agent_settled`, **not** `agent_end`. Pi can retry, compact,
  or process queued continuations after a low-level `agent_end`.
- Aborted settlement does not notify. Completion stays silent in recognized
  subagent runtimes; questions and permissions can still request attention.
- Completion says “Ready for input.” rather than asserting work succeeded:
  Pi 1.3.0's settled event exposes `aborted`, not a success/error outcome.
- Bodies are whitespace-normalized and limited to 220 UTF-16 code units.
  Completion never includes assistant response text.
- Native desktop notifications work independently of Pi's TUI/RPC/JSON/print
  rendering. Nothing is written to Pi's stdout, and no UI capability is required.
- ORGM `extensions.notify.enabled: false` disables registration when loaded.
  Per-feature `questions`/`permissions`/`done` switches are not consulted.

### Backends

| Environment | Backend | Notes |
| --- | --- | --- |
| Linux | `notify-send` | Normal urgency, transient, requested 8-second expiry; Kitty focus/desktop-entry hints when available. |
| Distrobox / recognized containers | `distrobox-host-exec notify-send` | Preferred when detected and available; otherwise falls back to local `notify-send`. |
| macOS | `osascript` | Escapes AppleScript strings. Notification settings control display. |
| WSL | `powershell.exe` | Windows toast, XML and PowerShell escaping, UTF-16LE encoded command. |
| Native Windows | `powershell.exe` | Same toast backend; detects availability with `where.exe`, without requiring `sh`. |

Missing commands and notification failures are silent and never block tool
execution with an error. Backend availability is cached per runtime/session and
rechecked on `session_start`. POSIX probes use non-login shells to preserve PATH.

No processes, probes, or timers start during extension discovery. Notification
clients are tracked, unreferenced, killed on operation cancellation (when Pi
supplies `ctx.signal`), and bounded by a 5-second client timeout. This timeout is
separate from the desktop notification's requested display lifetime. Exit/error
removes timers and abort listeners. Idempotent `session_shutdown` cleanup handles
reload, session replacement, and quit; `session_start` starts with fresh state.

## Pi 1.3.0 compatibility audit

Audited against the installed host at
`/home/osmarg/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`
(version **1.3.0**), including the complete `docs/extensions.md`, lifecycle
examples `examples/extensions/notify.ts` and `titlebar-spinner.ts`, and the
installed event declarations and settlement implementation. Related packages,
configuration, settings, lifecycle overview, TUI and RPC UI docs were reviewed.

The development host dependency is pinned to **exactly `1.3.0`**. The runtime
peer remains `"@earendil-works/pi-coding-agent": "*"` per Pi package guidance;
no host runtime is bundled. Older Pi releases without `agent_settled` are **not
verified** and will not produce completion notifications (no early-event fallback).

### Verification results

Environment: Linux, Node **v22.23.3**, npm **10.9.9**, TypeScript **5.9.3**.
Pi 1.3.0 declares Node **>=22.19.0**.

- `npm install --ignore-scripts`: passed; 119 packages added, 120 audited,
  **0 vulnerabilities**. Dependency deprecation warning: `node-domexception@1.0.0`.
- `npm ci --ignore-scripts`: passed; clean lockfile install, 119 packages added,
  120 audited, **0 vulnerabilities** (same dependency deprecation warning).
- `npm test`: **26 passed, 0 failed, 0 skipped**. Every process probe and
  notification launch is mocked; **no actual desktop notifications are sent**.
  Includes Pi 1.3.0's actual extension loader, event registration, multiple
  low-level ends before settlement, abort suppression, process exit/error/timeout,
  cancellation, repeated shutdown, reload/session replacement, per-runtime cache
  isolation, every backend, argument escaping, Unicode PowerShell, unavailable
  backends, aliases, subagents, and malformed/truncated question bodies.
- `npm run typecheck`: passed, strict/no emit over extensions and tests
  (`skipLibCheck` skips dependency declarations).
- `npm run pack:check`: passed; the notification-process helper is included,
  development dependencies/tests are not bundled.
- `git diff --check`: passed.

### Remaining gaps

- OS display/delivery was deliberately **not** tested. Linux notification daemons,
  Kitty focus integration, Distrobox host routing, macOS permissions, Windows/WSL
  WinRT toast support and app identity (`Pi`) still need real-machine smoke tests.
  Daemons/OS policy may ignore expiry or suppress notifications entirely.
- Mocked lifecycle dispatch verifies notification boundaries, but there was no
  live model run exercising Pi's retries, compaction, or queued continuations.
- Availability probes are synchronous but bounded (500 ms per local probe,
  1 second for the Distrobox host probe); they cannot be interrupted mid-probe.
- Cleanup kills the tracked client, not arbitrary remote/descendant processes.
  Delivered notifications cannot be retracted by abort/shutdown. Abrupt process
  termination that bypasses Pi shutdown cannot guarantee cleanup.
- No verification on other Pi/Node versions. Node's mocked timer API emits an
  expected experimental warning during the timeout regression.

## Development

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
npm run pack:check
```

Entry point: `extensions/notify.ts`. Notification resource ownership:
`extensions/lib/notification-process.ts`.
