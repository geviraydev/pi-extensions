# usage

Personal pi extension that adds a `/usage` command for provider subscription
quota plus a local, per-key, per-model breakdown. Currently implements the
opencode-go (OpenCode Zen) provider; provider-specific code is isolated in
`opencode-go.ts`.

It lives at `~/.pi/agent/extensions/usage/` and is auto-discovered by pi, so no
`pi install` or settings entry is needed.

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
  separately as `unattributed` instead of being mixed into a key.

## Limits

- Usage from other machines is not visible locally. Window percentages are
  still exact; the breakdown only covers this machine.
- The monthly window follows the server's reset time (30-day cycle).
- The OpenCode client part uses `node:sqlite` and needs Node 22.5+; without it
  only pi sessions are aggregated.

## Files

- `index.ts` - extension registration, command, tool, rendering.
- `opencode-go.ts` - opencode-go quota client and window ranges.
- `local-usage.ts` - pi session and OpenCode DB aggregation.
- `keys.ts` - key fingerprints, session attribution entries, labels.
