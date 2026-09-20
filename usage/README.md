# usage

Personal pi extension that adds a `/usage` command for provider subscription
quota plus a local, per-key, per-model breakdown. Currently implements the
opencode-go (OpenCode Zen) provider: its quota client lives in
`opencode-go.ts`, while the local aggregation in `local-usage.ts` still has
opencode-go paths and window semantics baked in.

It is loaded from `~/.pi/agent/extensions/usage/` (a symlink into this
repository works) and is auto-discovered by pi, so no `pi install` or settings
entry is needed.

## Why this exists

A minimal personal extension, written after the OpenCode console replaced the
workspace page and the slow, partial replacement made checking which models
were consuming a quota window inconvenient. It implements the one provider in
use and the one view that was missing; it is not a general provider usage
package.

## What it does

- Footer status: `oc-go 5h 2% · 7d 32% · 30d 0%`, colored at 70% and 90%,
  with reset countdowns only while a window is close to its limit.
- `/usage`: card with the server quota for the rolling (5h), weekly, and
  monthly windows, plus per-model usage for each window.
- `/usage label <name>`: names the active API key so reports are readable.
- `opencode_usage` tool: lets the model check quota and breakdown.

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
- Usage recorded before key tracking has no fingerprint and is shown
  separately as `unattributed` instead of being mixed into a key. Requests
  under other credentials are summarized as `other keys` per window.
- The OpenCode client DB has no key history. Its rows are attributed to the
  key currently in its auth file, and rows older than that file's last
  modification count as other keys rather than being assigned to it.

## Limits

- Usage from other machines is not visible locally. Window percentages are
  still exact; the breakdown only covers this machine.
- The monthly window follows the server's reset time (30-day cycle).
- The OpenCode client part uses `node:sqlite` and needs Node 22.5+; without it
  only pi sessions are aggregated.

## Relationship to other usage extensions

This extension registers `/usage`. If another extension that also registers
`/usage` is installed, pi keeps both and numbers them by load order
(`/usage:1`, `/usage:2`), so check which one answers before trusting the
output.

If you want quota across many providers, prefer the established packages in
the [pi package gallery](https://pi.dev/packages). The closest ones as of
September 2026 were:

- [`@narumitw/pi-usage`](https://www.npmjs.com/package/@narumitw/pi-usage) -
many providers including OpenCode Go windows, statusline, settings UI, and
origin validation before credentials are sent.
- [`@specode/pi-subscription-usage`](https://www.npmjs.com/package/@specode/pi-subscription-usage) -
Codex, OpenCode Go, Grok, and Kimi.
- [`pi-opencodego`](https://www.npmjs.com/package/pi-opencodego) - OpenCode
Go/Zen provider extension with multi-key rotation, session affinity, and
usage/cost tracking.
- [`@zhcsyncer/pi-meter`](https://www.npmjs.com/package/@zhcsyncer/pi-meter) -
local usage ledger plus subscription remaining.
- `pi-quota-monitoring`, `@latentminds/pi-quotas`, `@hk_net/pi-usage-bars`,
`pi-usage-meters` - other quota displays.

As of September 2026, none of them showed the local per-key, per-model
breakdown of each quota window, which is the reason this one exists. If one of
them grows that view, this extension can be retired.

## Files

- `index.ts` - extension registration, command, tool, rendering.
- `opencode-go.ts` - opencode-go quota client and window ranges.
- `local-usage.ts` - pi session and OpenCode DB aggregation.
- `keys.ts` - key fingerprints, session attribution entries, labels.
