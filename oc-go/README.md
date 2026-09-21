# oc-go

A pi extension that adds an `/oc-go` command for provider subscription
quota, a local per-key, per-model breakdown, a small stored-key pool, and the
active key name in the footer. Currently implements the opencode-go
(OpenCode Zen) provider: its quota client lives in `opencode-go.ts`, while the
local aggregation in `local-usage.ts` still has opencode-go paths and window
semantics baked in.

It is loaded from `~/.pi/agent/extensions/oc-go/` (a symlink into this
repository works) and is auto-discovered by pi, so no `pi install` or settings
entry is needed.

## Why this exists

A minimal extension, written after the OpenCode console replaced the
workspace page and the slow, partial replacement made checking which models
were consuming a quota window inconvenient. It implements the one provider in
use and the one view that was missing; it is not a general provider usage
package.

## What it does

- Footer status: `oc-go (work) 5h 2% · 7d 32% · 30d 0%`, colored at 70% and
  90%, with reset countdowns only while a window is close to its limit. The
  parenthesized name comes from the stored key or its label; a key with
  neither shows its fingerprint.
- `/oc-go`: card with the server quota for the rolling (5h), weekly, and
  monthly windows, followed by the active key's per-model usage and then a
  block per other stored/labeled key (totals plus its top models).
- `/oc-go` also manages the key pool and switching; see Commands.
- `opencode_usage` tool: lets the model check quota and breakdown.

## Commands

- `/oc-go`, `/oc-go usage`, `/oc-go status` - quota and local breakdown.
- `/oc-go keys` - stored keys with each one's quota.
- `/oc-go add <name> [key]` - store a key. In TUI it offers the current login
  (with its fingerprint) or a typed key; non-interactive modes adopt the
  current login. Prefer the dialog or `add <name>` over passing the secret as
  a command argument, which lands in the editor input history.
- `/oc-go use <name>` - log in with a stored key.
- `/oc-go rm <name>` - remove a stored key.
- `/oc-go label <name>` - label the active key.
- `/oc-go help` - list the commands.

Typing `/oc-go ` shows the subcommands with descriptions in autocomplete, and
`use` and `rm` complete stored key names.

## Data sources

- Quota: `GET <baseUrl>/usage` with the credentials pi stores for the
  `opencode-go` provider. Exact and per-key, regardless of where usage
  happened.
- Breakdown: local only.
  - pi session files in `~/.pi/agent/sessions/` (exact tokens and cost).
  - OpenCode client DB (`~/.local/share/opencode/opencode.db`) when its stored
    key fingerprint matches the active pi key; cost estimated from per-token
    rates learned from pi sessions.
- Attribution: at session start and whenever the key changes, a
  `opencode-go-key` entry with a 12-char SHA-256 fingerprint of the active key
  is appended to the session. No secret is stored.
- Usage recorded before key tracking has no fingerprint, and usage under a
  fingerprint that is neither stored nor labeled has no name. Both are shown
  as `unattributed` instead of being mixed into a named key.
- The OpenCode client DB has no key history. Its rows are attributed to the
  key currently in its auth file, and rows older than that file's last
  modification count as unattributed rather than being assigned to it.

## Key pool and auth

Stored keys live in `~/.pi/agent/opencode-go-usage-keys.json` (plaintext,
mode 0600), shaped as `{ "keys": [{ "name", "key" }] }`.

- `/oc-go add <name>` in the TUI asks whether to adopt the current effective
  key (showing its fingerprint) or to enter one. `/oc-go add <name> <key>`
  takes a key explicitly without a dialog, and non-interactive modes adopt
  the effective key.
- `/oc-go use <name>` logs in with that stored key through pi's credential
  store (`ModelRuntime.login`), which writes `auth.json` under its file lock
  and refreshes the in-memory credential state. The switch is immediate and
  persists across restarts, and quota, footer, fingerprints, and attribution
  all follow it. There is no runtime override, and `auth` is just a normal
  key name.
- Before a switch, if the outgoing login is not stored under another name, it
  is parked as a pool entry named `auth` while that name is free, so it is
  not lost. If a key named `auth` already exists, the outgoing login is left
  unsaved and the notification says so.
- `/login` and `/oc-go use` both write `auth.json`, so the last writer wins.
  `/logout` clears it; the keys stay in the pool.
- `pi --api-key` sets a runtime override that shadows `auth.json` for that
  process. `/oc-go use` clears it before logging in.
- Adding a key also writes the label `fingerprint -> name`, which names the
  key in the footer, report rows, and `/oc-go keys`. Sessions and reports
  only ever hold fingerprints, never secrets. `rm` keeps the label, so past
  usage keeps its name, and `label` names a key that was never stored.
- Labels live in `~/.pi/agent/opencode-go-usage-labels.json`.

## Limits

- Usage from other machines is not visible locally. Window percentages are
  still exact; the breakdown only covers this machine.
- The monthly window follows the server's reset time (30-day cycle).
- OpenCode Go quota is per workspace. Keys from the same workspace report the
  same windows, so stored keys are attribution labels, not independent
  budgets.
- The OpenCode client part uses `node:sqlite` and needs Node 22.5+; without it
  only pi sessions are aggregated.
- The pool file has no cross-process lock. Two pi instances editing it at the
  same time can overwrite each other; failing to parse disables `/oc-go`
  management until the file is fixed.
- Switching uses pi's private `ModelRuntime` (`login` and the runtime API key
  slot) through the same access path as pi's own `/login` and `--api-key`
  handling. A pi internal change could break it until pi exposes a public
  credential API.

## Manual checks

Interactive checks that only make sense inside pi:

1. `/oc-go add work` adopts the current login; `/oc-go keys` shows both
   quotas.
2. `/oc-go use <name>` flips the footer to `oc-go (name)` and the report key
   line.
3. A turn after `use` records a new `opencode-go-key` entry, so the next
   report separates keys instead of collapsing them into `unattributed`.
4. With an un-stored login, `use` parks it as `auth` and the notification says
   so; with `pi --api-key`, `/oc-go keys` shows `active: runtime override` and
   `use` clears it.

## Relationship to other extensions

This extension registers `/oc-go`. If another extension registers the same
command, pi keeps both and numbers them by load order (`/oc-go:1`,
`/oc-go:2`), so check which one answers before trusting the output.

The closest packages as of September 21, 2026:

- [`@lnilluv/pi-opencode-go-rotation`](https://www.npmjs.com/package/@lnilluv/pi-opencode-go-rotation)
  (1.5.3) - OpenCode Go key pool with reactive 429 handling, quota-block
  tracking, cooldowns, a stall watchdog, and automatic rotation. It switches
  with a process runtime override and reports quota per key, but has no local
  usage breakdown.
- [`pi-opencodego`](https://www.npmjs.com/package/pi-opencodego) (0.1.5) -
  OpenCode Go provider with a developer-role compatibility fix, automatic
  rotation with session affinity (to preserve the prefix cache), and
  usage/cost logging with a browser quota panel.
- [`pi-multi-account`](https://www.npmjs.com/package/pi-multi-account)
  (1.22.0) - automatic failover and rotation across subscription providers;
  OpenCode Go is not supported.
- [`@narumitw/pi-usage`](https://www.npmjs.com/package/@narumitw/pi-usage)
  (0.60.10) - quota and balance display for many providers, including the
  OpenCode Go windows; display only.
- [`@specode/pi-subscription-usage`](https://www.npmjs.com/package/@specode/pi-subscription-usage)
  (1.0.2) - quota display for Codex, OpenCode Go, Grok, and Kimi; display
  only.
- [`@zhcsyncer/pi-meter`](https://www.npmjs.com/package/@zhcsyncer/pi-meter)
  (0.4.4) - local token/cost ledger with a dashboard by model, project, and
  session, plus subscription windows for Claude, Codex, SuperGrok, and
  Ollama Cloud. No OpenCode Go, no per-key attribution.
- `pi-quota-monitoring`, `@latentminds/pi-quotas`, `@hk_net/pi-usage-bars`,
  `pi-usage-meters` - other quota displays.

This extension's niche is the local per-key, per-model breakdown of each
OpenCode Go quota window: a key fingerprint is recorded per request, so usage
from different keys stays separate, and stored keys get per-key quota. It
switches by writing a real `auth.json` login instead of a runtime override,
so the choice survives restarts. It deliberately has no automatic rotation,
cooldown, or 429 handling; use one of the rotation packages if that is
wanted. If another package grows the per-key, per-model view, this one can be
retired.

## Files

- `index.ts` - extension registration, command, tool, rendering.
- `opencode-go.ts` - opencode-go quota client and window ranges.
- `local-usage.ts` - pi session and OpenCode DB aggregation.
- `keys.ts` - key fingerprints, session attribution entries, labels.
- `key-pool.ts` - stored keys and credential login.
