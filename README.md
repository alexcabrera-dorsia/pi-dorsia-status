# pi-dorsia-status

Five-row custom footer for [pi](https://pi.dev). Sole owner of `ctx.ui.setFooter()` — renders exactly 5 rows every frame:

1. **AGENT** — agent state, current tool/file, model (incl. the model `hyper/prism` actually routed to), thinking level
2. **SESSION** — context bar + %, tokens, cost, turn, clock
3. **WORK** — Orca workspace / cwd tail, git branch + dirty, PR/Linear links (clickable OSC-8)
4. **SESSIONS** — `[me]` + sibling pi sessions as Orca tabs in this worktree
5. **CONTROL** — todo progress, delegations, transient alerts, MCP/skills, Orca freshness

Nord palette by default; switch at runtime with `/statusline-theme` (`c64` / `grayscale` / `no-bg` / `nord`).

## Prism auto-routed model

When running `hyper/prism`, the agent row shows the model the router actually picked, read from the `X-Prism-Model-Name` / `X-Prism-Model-Id` response headers via pi's `after_provider_response` hook. Renders as `hyper/prism → <model>`; cleared on model switch, repopulates on the next response.

## Install

```
pi install git:github.com/Elomi-inc/pi-dorsia-status.git@v0.1.0
```

Requires a Nerd Font in the terminal.

## Development

```
npm install
npm test      # vitest — render invariants + orca snapshot tests
npm run check # typecheck + tests
```
