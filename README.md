# pi-extensions

Personal collection of [pi](https://pi.dev) extensions.

| Extension | What it does |
| --- | --- |
| [`usage/`](./usage) | `/usage`: provider subscription quota plus a local per-key, per-model breakdown. Currently implements the opencode-go (OpenCode Zen) provider. |

Each extension is a directory with an `index.ts` entry point, which is also the
layout pi auto-discovers in `~/.pi/agent/extensions/*/index.ts`.

## Scope

Personal collection, public mainly so it is easy to share with my team. These
are minimal extensions built for a specific need, not attempts to be complete
provider packages. Where a mature alternative exists, the extension README
points at it; for example, `usage/` here covers opencode-go only, while the
[pi package gallery](https://pi.dev/packages) lists broader usage extensions
for many providers.

## Use an extension

Symlink the extension into pi's global extensions directory:

```
ln -s "$(pwd)/usage" ~/.pi/agent/extensions/usage
```

Then run `/reload` inside pi, or start a new session. Cloning this repository
directly into `~/.pi/agent/extensions` also works, as does pointing pi at the
extension path from the `extensions` array in `~/.pi/agent/settings.json`.

## Development

Edit the files in this repository and run `/reload` in pi; the symlinked copy
picks up the changes without any install step.

## License

MIT, see [LICENSE](./LICENSE).
