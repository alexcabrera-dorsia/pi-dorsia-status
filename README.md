# pi-dorsia-status

Four-row custom footer for [pi](https://pi.dev). Sole owner of `ctx.ui.setFooter()` — renders exactly 4 rows every frame:

1. **MODEL** — the selected model, thinking level, context percent with `↑input ↓output` tokens, session cost, time spent working, and cost per hour
2. **WORK** — git branch, diff footprint (`+added -removed !untracked`), upstream position (`↑ahead ↓behind`), worktree status, PR and Linear links (clickable OSC-8)
3. **FLEET** — active peer count, running pi-subagents (`sub N`), in-flight delegations (`deleg N`), and a broad summary per peer with a hidden-tab count
4. **CONTROL** — one live sentence describing what the agent is doing right now

Nord palette by default; switch at runtime with `/statusline-theme` (`c64` / `grayscale` / `no-bg` / `nord`).

All content packs to the left. When a row runs out of width it collapses compact fallbacks, evicts optional cells by priority, then shrinks the widest segment, so the required cells in each row survive down to very narrow terminals.

## The live status sentence

Row 4 is generated, not derived. While a turn is active the extension keeps a rolling buffer of the agent's reasoning stream, taken from pi's `thinking_delta` events, and runs a cheap headless completion against it:

```
pi -p --no-session --no-extensions -e <hyper-provider> --no-tools \
   --thinking off --model hyper/glm-5.3-flash -- "<reasoning tail + recent tool activity>"
```

It asks for one short sentence (max 70 characters) describing what is happening right now, and each refresh replaces the previous sentence. `--no-extensions` keeps the child from loading MCP servers or any other extension; the explicit `-e` path keeps the hyper provider available, because that provider ships as a package. Refreshes are throttled to once every 45 seconds and skipped entirely when the reasoning buffer and activity log are unchanged, so an idle session spends nothing. `session_start` restores the totals from the last `dorsia-status:cost` entry, so a reload does not reset them. Set `PI_STATUS_SUMMARY_MODEL` to use a different model for the sentence.

## Costs and the work clock

Session cost comes from assistant message usage. Subagent spend comes from pi-subagents' `subagents:completed` and `subagents:failed` events, which carry `usage.cost.total`. The two never overlap, because a subagent's child session runs its own extension instance and its messages never reach the parent. Row 1 shows the total, and when subagents have spent anything it adds the breakdown: `$1.04 · sub $0.31`.

The time cell is a work clock, not a stopwatch. It ticks while the model is thinking or writing, pauses while a tool executes, and stays stopped between turns. It never counts tool execution or time spent waiting for input.

## Prism auto-routed model

When running `hyper/prism`, the model row shows the model the router actually picked, read from the `X-Prism-Model-Name` / `X-Prism-Model-Id` response headers via pi's `after_provider_response` hook. Renders as `hyper/prism → <model>`; cleared on model switch, repopulates on the next response.

## Working indicator

The extension mirrors its state machine into pi's built-in working indicator through `ctx.ui.setWorkingMessage`, so the input border reads `thinking`, `writing`, `planning`, `running bash`, or `reading render.ts` instead of a static `Working`.

## Statusline segment bus

External producers extend the footer over pi's event bus, on the `dorsia-status:segment/v1` channel, with an envelope of `{ op: "upsert" | "remove", id, lane, icon?, label?, value?, tone?, priority, side?, maxWidth?, optional?, link? }`. The lane names remain `agent`, `session`, `work`, `sessions`, and `control`; the agent and session lanes both render on row 1, `sessions` renders on row 3, and `control` segments render on row 4 after the sentence. `dorsia-status:request-snapshot/v1` asks producers to republish after a remount.

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
