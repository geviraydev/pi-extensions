# pi-extensions

A small collection of [pi](https://pi.dev) extensions.

| Extension | What it does |
| --- | --- |
| [`oc-go/`](./oc-go) | `/oc-go`: OpenCode Go subscription quota, local per-key/per-model breakdown, and a stored-key pool. |

Each extension is a directory with an `index.ts` entry point, which is also the
layout pi auto-discovers in `~/.pi/agent/extensions/*/index.ts`.

## Scope

Public mainly so it is easy to share with my team. These are minimal
extensions built for a specific need, not attempts to be complete provider
packages. Where a mature alternative exists, the extension README points at
it and documents what is deliberately out of scope; the
[pi package gallery](https://pi.dev/packages) lists broader coverage.

## Use an extension

Symlink the extension into pi's global extensions directory:

```
ln -s "$(pwd)/oc-go" ~/.pi/agent/extensions/oc-go
```

Then run `/reload` inside pi, or start a new session. Cloning this repository
directly into `~/.pi/agent/extensions` also works, as does pointing pi at the
extension path from the `extensions` array in `~/.pi/agent/settings.json`.

## Development

Run `npm install` once, then `npm run typecheck`. Edit the files in this
repository and run `/reload` in pi; the symlinked copy picks up the changes
without any install step.

## License

MIT, see [LICENSE](./LICENSE).
