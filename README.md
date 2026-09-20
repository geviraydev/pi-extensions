# pi-extensions

Personal [pi](https://pi.dev) extensions. The repository root is the global
extensions directory itself (`~/.pi/agent/extensions/`), so cloning this repo
into that path is all pi needs to pick everything up. No `pi install`, no
settings entries, no symlinks.

| Extension | What it does |
| --- | --- |
| [`usage/`](./usage) | `/usage`: provider subscription quota plus a local per-key, per-model breakdown. Currently implements the opencode-go (OpenCode Zen) provider. |

Pi installs third-party packages under `~/.pi/agent/npm/` and
`~/.pi/agent/git/`, so this directory stays personal.

## Install on a new machine

```
git clone git@github.com:geviraydev/pi-extensions.git ~/.pi/agent/extensions
```

If the directory already exists and is not empty, clone elsewhere and copy the
extension directories into it instead. Then run `/reload` inside pi or start a
new session.
