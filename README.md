# herdr-openclaw

A [herdr](https://herdr.dev) plugin that makes **OpenClaw TUI panes first-class agents** —
they show up in `herdr agent list` and the sidebar with live `idle` / `working` / `blocked`
state, the model in use, context usage, and how long the current run has been going.

## Why a plugin is needed

herdr detects agents from data-driven TOML manifests, and it ships with 21 of them
(`claude`, `codex`, `hermes`, `cursor`, …). OpenClaw is not among them, and **you cannot
add it by writing a manifest**: manifests are only loaded for agent ids herdr already
knows. Dropping in an `openclaw.toml` is silently ignored — no error, it just never
appears.

So this plugin takes the other route. A small watcher process parses the OpenClaw TUI
status line and reports state through `herdr pane report-agent`, whose `--agent` argument
accepts any label. From herdr's point of view the pane then behaves like any other agent.

The full reverse-engineering log — every contract this plugin depends on, and how it was
verified — is in [`docs/findings-2026-08-12.md`](docs/findings-2026-08-12.md).

## Requirements

- herdr **0.8.0+**, including **0.9.0** (`pane report-agent` and friends)
- OpenClaw **2026.7.x** or **2026.8.x** (status-line format; see [Upstream drift](#upstream-drift))
- Node **20+**
- macOS and Linux. Nothing in the code is macOS-specific — paths are XDG, signals are
  POSIX. Linux is now covered: verified on Ubuntu 24.04 with herdr 0.9.0 and OpenClaw
  2026.8.2, so `linux` is in `platforms`.

## Install

```sh
git clone https://github.com/gejiliang/herdr-openclaw.git
herdr plugin link /path/to/herdr-openclaw --enabled
herdr server reload-config
```

The plugin's `[[startup]]` hook reconciles stale state and launches the watcher in the
background. Verify:

```sh
herdr plugin list | grep herdr-openclaw
node /path/to/herdr-openclaw/bin/status.mjs
```

> `[[startup]]` only fires when the herdr **server** starts. If herdr is already running,
> trigger it once with
> `herdr plugin action invoke watch-restart --plugin herdr-openclaw`.

## Usage

Just start OpenClaw in any pane — no special command:

```sh
openclaw tui      # connects to the Gateway (recommended)
openclaw chat     # alias for tui --local
```

Within a few seconds the pane appears in `herdr agent list` as `openclaw`.

Two commands you may occasionally need — note that they have **opposite** constraints:

| Command | Where to run it | Where output goes |
|---|---|---|
| `node <repo>/bin/status.mjs` | Any directory **if you use an absolute path**; a relative `bin/status.mjs` requires `cd`ing to the repo root | straight to your terminal |
| `herdr plugin action invoke watch-restart --plugin herdr-openclaw` | any directory (goes over the socket; the server resolves paths from `plugin_root`) | **not to your terminal** — read it with `herdr plugin log list` |

## State mapping

| OpenClaw status line | herdr state |
|---|---|
| `gateway connected \| idle`, `aborted` | `idle` |
| busy line: `⠧ noodling… • 2s \| gateway connected` | `working` |
| `auth`, approval / confirmation prompts | `blocked` |
| `error`, `disconnected` | `unknown` |

Two things worth knowing:

**While a run is active, OpenClaw replaces the status line with a structurally inverted
one** — activity first, connection state last, elapsed time in between — rather than
swapping a word in the idle format. The waiting phrase is drawn from a configurable list
(`noodling`, `kerfuffling`, `twiddling thumbs`, …), so this plugin matches on *shape*,
never on a word list.

**Approval prompts outrank the reported activity.** When OpenClaw asks for confirmation
the status line may still read `waiting`, but for an orchestrator that means "a human is
needed", so it is reported as `blocked`.

## Notifications

You get a notification when a run finishes or when OpenClaw needs you:

| Transition | Notification | Sound |
|---|---|---|
| `working` → finished | `OpenClaw · <agent>` finished, with elapsed time and pane id | `done` |
| any → `blocked` | `OpenClaw · <agent>` needs you | `request` |

> Note: the notification strings themselves are currently in Chinese
> (`… 跑完了` / `… 需要你`). They are defined in `lib/notify.mjs`; a PR to make them
> localisable is welcome.

**Delivery, position, delay and rate limiting are entirely herdr's** — `notification.show`
already routes through your `[ui.toast]` settings (its result codes are `shown` /
`disabled` / `rate_limited` / `no_foreground_client`). Switch `ui.toast.delivery` to
`system` and these notifications follow, with no plugin-side change.

Three deliberate behaviours:

- **Only "finished" and "needs input".** Errors and disconnects are not announced, matching
  how herdr describes notifications for its native agents.
- **The pane you are looking at does not interrupt you** ("background agent finishes").
- **Restarting the watcher does not replay anything.** A freshly adopted pane has no prior
  state, so you never get a burst of notifications for results you already saw.

### Configuration

Plugin settings live in the config directory herdr provides
(`herdr plugin config-dir herdr-openclaw`):

```jsonc
// ~/.config/herdr/plugins/config/herdr-openclaw/config.json
{
  "notify": true,          // master switch
  "sound": "on",           // "off" = still shows, just silent
  "notifyFocused": false   // true = notify even for the pane you are viewing
}
```

Changes take effect immediately; no watcher restart needed.

> Do **not** try `[ui.sound.agents] openclaw = "off"` in herdr's own config. That key is an
> enum of herdr's known agents — `herdr config check` reports
> `unknown config key ui.sound.agents.openclaw; ignoring key` (while `hermes` in the same
> file is accepted). It would leave a permanent warning in your config check.

Tuning knobs, via environment variables on the watcher:
`HERDR_OPENCLAW_POLL_MS` (default 1200) and `HERDR_OPENCLAW_DISCOVERY_MS` (default 5000).

## Driving OpenClaw from an orchestrator

Two of herdr's agent commands do not work on plugin-reported agents, so this repo ships
equivalents:

```sh
# Send a prompt. Returns once submission is confirmed; --wait blocks until the run settles.
node bin/prompt.mjs <pane_id> "your question" --wait --timeout 120000
# -> {"ok":true,"submitted":true,"evidence":"busy","state":"idle","elapsed":"32s"}

# Read back. --transcript strips status/info/separator chrome and leaves the conversation.
node bin/read.mjs <pane_id> --lines 40 --transcript
node bin/read.mjs <pane_id> --json      # transcript plus the raw screen
```

`prompt.mjs` **never fires and forgets**. Sending text without a separate Enter leaves it
sitting in the input box while the caller believes work is underway — a failure mode far
more dangerous than an error. So after sending text and Enter it requires one of three
pieces of evidence before reporting success:

1. the TUI entered `busy` — the run really started
2. herdr's `state_change_seq` changed — covers runs too fast to catch `busy`
3. the session id changed

With none of them it returns `{"ok":false,"error":"not_submitted"}` along with the tail of
the screen. It also refuses any pane whose **foreground process** is not `openclaw-tui`,
because a screen-text check alone is not safe: any shell pane displaying a sample status
line would pass it, and text plus Enter in a shell is a command.

## Differences from native agents

Working: `agent list` / `get` / `wait --until` / `focus` / `rename`, all four states, the
sidebar entry — plus `display_agent` and `tokens`, which native agents do not have.

Not working, and what to use instead:

| Native | Plugin agent | Use instead |
|---|---|---|
| `agent prompt` | `agent_not_ready: not an active named agent` | `bin/prompt.mjs` |
| `agent read` | exit code 0 but **empty output** | `bin/read.mjs` |
| `agent send-keys` | same as `agent prompt` | `pane send-keys` |
| `agent explain` | `does not have a detected agent label` | watcher log (`--verbose`) |
| `agent start --kind openclaw` | `--kind` is a compiled-in enum | start `openclaw tui` yourself |
| `agent_session` | cannot be written from a plugin | session id is parsed and shown in the sidebar |

The root cause for the first three is a single missing capability: "active named agent"
status is granted only by `agent start`, and `--kind` cannot be extended. If herdr ever
ships an `openclaw` agent id, most of this plugin becomes unnecessary.

Out of reach entirely (fixed on herdr's side):

- **Per-agent config keys** accept only known agent names.
- **Sidebar per-agent colours** come from a fixed list, so `openclaw` uses the default.

## Known limitations

- **`agent_session` cannot be set.** `report-agent-session` exits 0 but `agent get` keeps
  returning `null`; the field appears to be reserved for agents herdr started itself. Do
  not use it as a key for OpenClaw sessions.
- **Waiting on completion needs `agent wait --until done idle`.** Passing only `idle` hangs
  until timeout: herdr derives a terminal `done` from "was working, now idle", and a plugin
  can only report the four base states.
- **State is polled**, not pushed: ~1.2 s for adopted panes, ~5 s to discover new ones.
- **Several panes can report the same session id** when they attach to the same Gateway
  session. herdr tracks per pane, so this is harmless.
- **The watcher is not supervised.** If it dies, state freezes until the next
  `watch-restart`. Its log is appended to and never rotated.

## Upstream drift

Both sides move fast: `pane.report_agent` is the herdr 0.8.0 shape, and the OpenClaw status
line changes between releases. **After upgrading either, run:**

```sh
node bin/watch.mjs --once --verbose
```

and confirm three things: the pane is discovered, its state is parsed, and
`herdr agent get <pane>` shows `display_agent` and `tokens`.

## Development

```sh
npm test                              # 55 tests, all pure functions
node bin/watch.mjs --once --verbose   # one pass, shows what it found and reported
```

`lib/detect.mjs` is pure and does no I/O, so parser changes can be tested offline against
captured samples. When you change the parsing rules, **add a real captured sample** rather
than a hand-written one:

```sh
herdr pane read <pane> --source detection --lines 12 --format text
```

Narrow panes are a separate case that must be covered too: the TUI drops the `gateway `
prefix and hard-wraps the info line (this is not terminal wrapping — `recent-unwrapped`
wraps identically). Both shapes are in `test/detect.test.mjs`.

## License

Apache-2.0. See [LICENSE](LICENSE).
