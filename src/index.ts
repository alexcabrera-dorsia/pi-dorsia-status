/**
 * dorsia-status — five-row status footer for pi.
 *
 * Sole owner of ctx.ui.setFooter(). Renders exactly 5 rows every render:
 *   1. AGENT    — local agent state, current tool/file, model, thinking level
 *   2. SESSION  — context bar + %, tokens, cost, turn, clock
 *   3. WORK     — Orca workspace name / cwd tail, git branch + dirty, PR/Linear
 *   4. SESSIONS — [me] + sibling pi sessions as Orca tabs in this worktree
 *   5. CONTROL  — todo progress, delegations, transient alert, MCP/skills, Orca freshness
 *
 * Subsumes agent-state-status.ts (state machine folded inline below).
 * Compat bridge: unknown setStatus() keys surface in CONTROL (capped at 1).
 *
 * Event-bus protocol:
 *   dorsia-status:segment/v1          — {op:"upsert"|"remove", id, lane, icon?, label?, value?, tone?, priority, side, maxWidth?, expiry?}
 *   dorsia-status:request-snapshot/v1 — footer emits after mount; producers republish
 *   dorsia-status:sessions/v1         — published normalized Orca sessions snapshot
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { emptySnapshot, renderStatus, setStatuslineTheme, type Lane, type Segment, type SessionInfo, type SessionsLane, type StatuslineThemeId, type Snapshot, type StatusTheme, STATUSLINE_THEMES } from "./render.ts";
import { normalizeSessions, startOrcaPolling, type OrcaPoller, type WorktreeMeta } from "./orca.ts";

const SEGMENT_CHANNEL = "dorsia-status:segment/v1";
const SNAPSHOT_REQUEST_CHANNEL = "dorsia-status:request-snapshot/v1";
const SESSIONS_CHANNEL = "dorsia-status:sessions/v1";
const MCP_STATUS_CHANNEL = "pi-mcp-adapter/status/v1";

/** Status keys we consume natively — excluded from the compat bridge. */
const KNOWN_STATUS_KEYS = new Set(["agent-state", "thinking-state", "mcp-skills", "todos", "cli-delegate", "ponytail"]);


// ── agent state machine (folded from agent-state-status.ts) ─────────────────

type AgentState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "thinking" }
  | { kind: "writing" }
  | { kind: "calling-tools"; tool: string }
  | { kind: "reading"; path: string }
  | { kind: "editing"; path: string };

function truncatePath(path: unknown, max = 20): string {
  if (typeof path !== "string" || !path) return "";
  const base = path.split(/[\\/]/).pop() || path;
  if (base.length <= max) return base;
  return `…${base.slice(-(max - 1))}`;
}

function stateToActivity(state: AgentState): { state: Snapshot["agent"]["state"]; activity: string } {
  switch (state.kind) {
    case "idle": return { state: "idle", activity: "" };
    case "working": return { state: "working", activity: "" };
    case "thinking": return { state: "thinking", activity: "thinking" };
    case "writing": return { state: "writing", activity: "writing" };
    case "calling-tools": return { state: "calling-tools", activity: state.tool };
    case "reading": return { state: "reading", activity: `read ${state.path}` };
    case "editing": return { state: "editing", activity: `edit ${state.path}` };
  }
}

// ── provider/model joining (Q3+Q4) ───────────────────────────────────────

/** Parse a joined provider/model id (e.g. "anthropic/claude-opus-4.5"). */
function joinedModelId(modelId: string | undefined, provider?: string | undefined): string | undefined {
  if (!modelId) return undefined;
  // Already joined (e.g. "anthropic/claude-opus-4.5") — keep the full id.
  if (modelId.includes("/")) return modelId;
  // Bare id: prefix with the provider if known.
  const p = provider ?? process.env.PI_PROVIDER;
  if (p) return `${p}/${modelId}`;
  return modelId;
}

// ── session duration + cost rate (Q8) ───────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;

function fmtDuration(ms: number): string {
  if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / MIN);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

function fmtCostRate(usd: number | undefined, ms: number): string | undefined {
  if (usd == null || ms <= 0) return undefined;
  const hours = ms / HOUR;
  if (hours < 1 / 60) return undefined; // need at least ~1 min
  return `$${(usd / hours).toFixed(2)}/hr`;
}

// ── git ahead/behind (Q9) ───────────────────────────────────────────────────

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // /statusline-theme [c64|grayscale|no-bg] — switch the footer color theme.
  // No arg → present a selectable list via ctx.ui.select.
  pi.registerCommand("statusline-theme", {
    description: "Switch the statusline footer color theme: c64 (bold bars), grayscale (muted bars), no-bg (flat colored text), or nord (polar-night bars with frost/aurora accents).",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const id = args.trim().toLowerCase() as StatuslineThemeId;
      if (id && id in STATUSLINE_THEMES) {
        setStatuslineTheme(id);
        invalidate(true); // force re-render so the change is visible immediately
        ctx.ui.notify(`Statusline theme: ${id}`, "info");
        return;
      }
      // No arg (or unknown) → show a selectable list.
      const options = (Object.keys(STATUSLINE_THEMES) as StatuslineThemeId[]).map(
        (k) => `${k} — ${k === "c64" ? "bold saturated color bars" : k === "grayscale" ? "muted gray bars" : k === "nord" ? "polar-night bars, frost/aurora accents" : "flat colored text, no background"}`,
      );
      const choice = await ctx.ui.select("Statusline theme", options);
      if (!choice) return; // user cancelled
      const chosen = choice.split(" ")[0] as StatuslineThemeId;
      setStatuslineTheme(chosen);
      invalidate(true);
      ctx.ui.notify(`Statusline theme: ${chosen}`, "info");
    },
  });

  let snapshot: Snapshot = emptySnapshot();
  let tuiRef: TUI | undefined;
  let themeRef: StatusTheme | undefined;
  let footerDataRef: ReadonlyFooterDataProvider | undefined;
  let poller: OrcaPoller | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let branchUnsub: (() => void) | undefined;
  let eventUnsubs: (() => void)[] = [];
  let lastFingerprint = "";
  let turnCount = 0;

  // Agent state machine state.
  let agentState: AgentState = { kind: "idle" };
  let activeTools = 0;
  let currentModel: string | undefined;
  let currentProvider: string | undefined;
  let routedModel: string | undefined;
  let thinkingLevel: string | undefined;
  let thinkingOn = false;

  // Session wall-clock start (Q8: duration + cost rate).
  let sessionStartedAt = 0;

  // Context-% history ring buffer for the braille sparkline (Q5).
  const HISTORY_N = 8;
  let ctxHistory: number[] = [];
  let lastHistoryAt = 0;

  // Git ahead/behind cache (Q9). Refreshed asynchronously; read synchronously per render.
  let gitAbCache: { ref: string; ts: number; result: { ahead: number; behind: number } | null } | null = null;
  let gitAbInFlight = false;

  /** Refresh ahead/behind vs upstream asynchronously (pi.exec is async). Reads are sync via gitAbCache. */
  async function refreshAheadBehind(ctx: ExtensionContext | undefined, branch: string | null | undefined): Promise<void> {
    if (!ctx || !branch || gitAbInFlight) return;
    const cwd = ctx.cwd;
    const ref = `${cwd}:${branch}`;
    const now = Date.now();
    if (gitAbCache && gitAbCache.ref === ref && now - gitAbCache.ts < 5_000) return;
    gitAbInFlight = true;
    try {
      const count = async (range: string): Promise<number | null> => {
        const r = await pi.exec("git", ["-C", cwd, "rev-list", "--count", range], { timeout: 3000 });
        if (r.code !== 0) return null;
        const n = parseInt(r.stdout.trim(), 10);
        return Number.isNaN(n) ? null : n;
      };
      // @{u} = upstream; fall back to origin/<branch>.
      let ahead = await count(`${branch}@{u}..HEAD`);
      let behind = await count(`HEAD..${branch}@{u}`);
      if (ahead == null || behind == null) {
        ahead = await count(`origin/${branch}..HEAD`);
        behind = await count(`HEAD..origin/${branch}`);
      }
      gitAbCache = { ref, ts: now, result: ahead == null || behind == null ? null : { ahead, behind } };
    } catch {
      gitAbCache = { ref, ts: now, result: null };
    } finally {
      gitAbInFlight = false;
    }
  }

  // Delegation ids seen live (delegation:lane emits update per in-flight entry, remove on completion).
  const activeDelegations = new Set<string>();

  // Segment registry: lane → id → Segment.
  const segmentStore = new Map<Lane, Map<string, Segment>>();

  function allSegments(lane: Lane): Segment[] {
    const m = segmentStore.get(lane);
    if (!m) return [];
    // Filter expired segments.
    const now = Date.now();
    const out: Segment[] = [];
    for (const seg of m.values()) {
      const s = seg as Segment & { expiry?: number };
      if (s.expiry != null && s.expiry < now) continue;
      out.push(seg);
    }
    return out;
  }

  function rebuildSegments(): void {
    snapshot.segments = {
      agent: allSegments("agent"),
      session: allSegments("session"),
      work: allSegments("work"),
      sessions: allSegments("sessions"),
      control: allSegments("control"),
    };
  }

  function fingerprint(snap: Snapshot): string {
    const a = snap.agent;
    const s = snap.session;
    const w = snap.work;
    const ss = snap.sessions;
    const c = snap.control;
    return [
      a.state, a.activity, a.model ?? "", a.routedModel ?? "", a.thinkingLevel ?? "", a.thinkingOn,
      s.percent ?? "", s.tokens ?? "", s.costUsd ?? "", s.turn ?? "",
      s.duration ?? "", s.costRate ?? "", (s.history ?? []).join(","),
      w.branch ?? "", w.workspace ?? "", w.dirtyAdded ?? "", w.dirtyRemoved ?? "",
      w.ahead ?? "", w.behind ?? "", w.prLink ?? "", w.prUrl ?? "",
      w.linearLink ?? "", w.linearUrl ?? "",
      ss.siblings.length, ss.hiddenCount, ss.me?.role ?? "",
      c.todoDone ?? "", c.todoTotal ?? "", c.activeDelegations ?? "",
      c.mcpConnected ?? "", c.mcpEnabled ?? "",
      c.orcaFreshness?.state ?? "", c.blocker ?? "", c.transientAlert ?? "",
      JSON.stringify(Object.values(snap.segments).map((segs) => segs.map((x) => [x.id, x.value, x.link]))),
    ].join("|");
  }

  function invalidate(force = false): void {
    if (!tuiRef || !themeRef) return;
    rebuildSegments();
    const fp = fingerprint(snapshot);
    if (!force && fp === lastFingerprint) return;
    lastFingerprint = fp;
    tuiRef.requestRender();
  }

  function updateAgentLane(): void {
    const { state, activity } = stateToActivity(agentState);
    snapshot.agent = { state, activity, model: joinedModelId(currentModel, currentProvider), routedModel, thinkingLevel, thinkingOn };
  }

  function updateSessionLane(ctx?: ExtensionContext): void {
    const clock = new Date().toTimeString().slice(0, 5);
    if (!ctx) {
      snapshot.session = { ...snapshot.session, clock, turn: turnCount };
      return;
    }
    const usage = ctx.getContextUsage?.();
    const percent = usage?.percent ?? null;
    // Sample context % into the history ring buffer (throttled to ≥2s apart).
    const now = Date.now();
    if (percent != null && now - lastHistoryAt >= 2_000) {
      ctxHistory.push(percent);
      if (ctxHistory.length > HISTORY_N) ctxHistory.shift();
      lastHistoryAt = now;
    }
    const elapsed = sessionStartedAt ? now - sessionStartedAt : 0;
    const duration = elapsed > 0 ? fmtDuration(elapsed) : undefined;
    const costRate = fmtCostRate(snapshot.session.costUsd, elapsed);
    snapshot.session = {
      percent,
      tokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? null,
      clock,
      turn: turnCount,
      history: ctxHistory.slice(),
      duration,
      costRate,
      // Cost and token I/O accumulate from message events; keep whatever we have.
      inputTokens: snapshot.session.inputTokens,
      outputTokens: snapshot.session.outputTokens,
      costUsd: snapshot.session.costUsd,
    };
  }

  function updateWorkLane(ctx?: ExtensionContext): void {
    const branch = footerDataRef?.getGitBranch() ?? undefined;
    const meta = poller?.meta;
    const cwdTail = ctx ? ctx.cwd.split("/").filter(Boolean).slice(-2).join("/") : snapshot.work.cwdTail;
    const abBranch = branch ?? snapshot.work.branch;
    void refreshAheadBehind(ctx, abBranch); // fire-and-forget; reads use the cache below
    const ab = gitAbCache && gitAbCache.ref === `${ctx?.cwd}:${abBranch}` ? gitAbCache.result : null;
    snapshot.work = {
      workspace: meta?.displayName ?? undefined,
      cwdTail,
      branch: branch ?? undefined,
      ahead: ab?.ahead,
      behind: ab?.behind,
      worktreeStatus: meta?.status,
      prLink: meta?.prLink,
      prUrl: meta?.prUrl,
      linearLink: meta?.linearLink,
      linearUrl: meta?.linearUrl,
      dirtyAdded: snapshot.work.dirtyAdded,
      dirtyRemoved: snapshot.work.dirtyRemoved,
      dirtyUntracked: snapshot.work.dirtyUntracked,
    };
  }

  function updateSessionsLane(lane: SessionsLane, freshness: { ageMs: number; state: "fresh" | "stale" | "error" }, meta?: WorktreeMeta): void {
    snapshot.sessions = lane;
    snapshot.control.orcaFreshness = freshness;
    if (meta) {
      snapshot.work.workspace = meta.displayName ?? snapshot.work.workspace;
      snapshot.work.worktreeStatus = meta.status ?? snapshot.work.worktreeStatus;
      snapshot.work.prLink = meta.prLink ?? snapshot.work.prLink;
      snapshot.work.prUrl = meta.prUrl ?? snapshot.work.prUrl;
      snapshot.work.linearLink = meta.linearLink ?? snapshot.work.linearLink;
      snapshot.work.linearUrl = meta.linearUrl ?? snapshot.work.linearUrl;
    }
    invalidate();
  }

  // ── segment bus ─────────────────────────────────────────────────────────

  function handleSegment(data: unknown): void {
    const d = data as Partial<Segment> & { op?: string; expiry?: number } | undefined;
    if (!d || typeof d.id !== "string" || typeof d.lane !== "string") return;
    const lane = d.lane as Lane;
    if (!segmentStore.has(lane)) segmentStore.set(lane, new Map());
    const store = segmentStore.get(lane)!;
    if (d.op === "remove") {
      store.delete(d.id);
    } else {
      // Cap segment content before registration.
      const seg: Segment = {
        id: d.id,
        lane,
        icon: typeof d.icon === "string" ? d.icon.slice(0, 4) : undefined,
        label: typeof d.label === "string" ? d.label.slice(0, 40) : undefined,
        value: typeof d.value === "string" ? d.value.slice(0, 120) : undefined,
        tone: d.tone,
        priority: typeof d.priority === "number" ? d.priority : 50,
        side: d.side === "right" ? "right" : "left",
        maxWidth: typeof d.maxWidth === "number" ? d.maxWidth : undefined,
        optional: d.optional,
        link: typeof d.link === "string" ? d.link.slice(0, 300) : undefined,
      };
      if (typeof d.expiry === "number") (seg as Segment & { expiry?: number }).expiry = d.expiry;
      store.set(d.id, seg);
    }
    invalidate();
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // Reset state.
    snapshot = emptySnapshot();
    agentState = ctx.isIdle() ? { kind: "idle" } : { kind: "working" };
    activeTools = 0;
    turnCount = 0;
    currentModel = ctx.model?.id;
    currentProvider = (ctx.model as { provider?: string } | undefined)?.provider ?? process.env.PI_PROVIDER;
    routedModel = undefined;
    thinkingLevel = ctx.thinkingLevel ?? undefined;
    thinkingOn = !!thinkingLevel && thinkingLevel !== "off";
    sessionStartedAt = Date.now();
    ctxHistory = [];
    lastHistoryAt = 0;
    lastFingerprint = "";
    // Lead session role label (Q13).
    snapshot.sessions.me = { ...snapshot.sessions.me, isMe: true, state: "working", role: "orchestrator" };

    // Mount the footer.
    ctx.ui.setFooter((tui, theme, footerData) => {
      tuiRef = tui;
      themeRef = theme as unknown as StatusTheme;
      footerDataRef = footerData;

      // Git branch updates.
      branchUnsub?.();
      branchUnsub = footerData.onBranchChange(() => {
        updateWorkLane(ctx);
        invalidate();
      });

      // Request producer snapshots (no-replay fix).
      try {
        pi.events.emit(SNAPSHOT_REQUEST_CHANNEL, { at: Date.now() });
      } catch { /* best effort */ }

      return {
        render(width: number): string[] {
          // Compat bridge: unknown setStatus() keys → one transient alert.
          if (footerDataRef) {
            const unknowns: string[] = [];
            for (const [key, value] of footerDataRef.getExtensionStatuses()) {
              if (!KNOWN_STATUS_KEYS.has(key) && value) unknowns.push(value);
            }
            snapshot.control.transientAlert = unknowns[0];
          }
          updateSessionLane(ctx);
          updateWorkLane(ctx);
          return renderStatus(width, snapshot, themeRef!);
        },
        dispose(): void {
          // handled at session_shutdown
        },
        invalidate(): void {
          lastFingerprint = "";
        },
      };
    });

    // Start Orca polling.
    poller?.dispose();
    poller = startOrcaPolling(pi, (lane, freshness, meta) => updateSessionsLane(lane, freshness, meta));

    updateAgentLane();
    updateSessionLane(ctx);
    updateWorkLane(ctx);
    invalidate(true);

    // Clock tick: once a minute.
    clockTimer = setInterval(() => {
      updateSessionLane();
      invalidate();
    }, 60_000);
    clockTimer.unref?.();
  });

  // ── agent state machine events ──────────────────────────────────────────

  pi.on("agent_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools = 0;
    agentState = { kind: "working" };
    updateAgentLane();
    invalidate();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools = 0;
    agentState = { kind: "idle" };
    updateAgentLane();
    invalidate();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools = 0;
    agentState = { kind: "idle" };
    updateAgentLane();
    invalidate();
  });

  pi.on("message_update", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const ev = event.assistantMessageEvent;
    if (!ev) return;
    switch (ev.type) {
      case "thinking_start":
      case "thinking_delta":
        agentState = { kind: "thinking" };
        break;
      case "text_delta":
        agentState = { kind: "writing" };
        break;
      case "toolcall_start":
      case "toolcall_delta":
        agentState = { kind: "calling-tools", tool: "planning" };
        break;
      default:
        return;
    }
    updateAgentLane();
    // Fuse in-flight usage.
    const msg = event.message;
    if (msg && msg.role === "assistant" && msg.usage) {
      const u = msg.usage as { input?: number; output?: number; cost?: { total?: number } };
      snapshot.session.inputTokens = u.input;
      snapshot.session.outputTokens = u.output;
      if (u.cost?.total != null) snapshot.session.costUsd = u.cost.total;
    }
    invalidate();
  });

  pi.on("message_end", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const msg = event.message;
    if (msg?.role === "assistant" && msg.usage) {
      const u = msg.usage as { input?: number; output?: number; cost?: { total?: number } };
      snapshot.session.inputTokens = u.input;
      snapshot.session.outputTokens = u.output;
      if (u.cost?.total != null) snapshot.session.costUsd = u.cost.total;
      updateSessionLane(ctx);
      invalidate();
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools++;
    const tool = event.toolName;
    const args = (event.args ?? {}) as Record<string, unknown>;
    if (tool === "read") {
      agentState = { kind: "reading", path: truncatePath(args.path) };
    } else if (tool === "write" || tool === "edit") {
      agentState = { kind: "editing", path: truncatePath(args.path ?? args.to) };
    } else {
      agentState = { kind: "calling-tools", tool };
    }
    updateAgentLane();
    invalidate();
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools = Math.max(0, activeTools - 1);
    if (activeTools === 0) {
      agentState = ctx.isIdle() ? { kind: "idle" } : { kind: "working" };
    }
    updateAgentLane();
    invalidate();
  });

  pi.on("turn_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    turnCount = event.turnIndex;
    updateSessionLane(ctx);
    invalidate();
  });

  pi.on("model_select", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    currentModel = event.model?.id;
    currentProvider = (event.model as { provider?: string } | undefined)?.provider ?? process.env.PI_PROVIDER;
    routedModel = undefined; // repopulates from the next prism-routed response
    updateAgentLane();
    invalidate();
  });

  // Prism auto-routing surfaces the resolved model via X-Prism-Model-Name/-Id
  // response headers (hyper.charm.land/v1/chat/completions). Show it next to the
  // provider/model id.
  // ponytail: the event doesn't say which model the request was for, so a
  // subagent running a non-prism hyper model can briefly clobber the value — it
  // self-corrects on the next main-loop response.
  pi.on("after_provider_response", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const routed = event.headers["x-prism-model-name"] ?? event.headers["x-prism-model-id"];
    if (!routed || routed === routedModel) return;
    routedModel = routed;
    updateAgentLane();
    invalidate();
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    thinkingLevel = event.level;
    thinkingOn = !!thinkingLevel && thinkingLevel !== "off";
    updateAgentLane();
    invalidate();
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    updateSessionLane(ctx);
    invalidate(true);
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    invalidate();
  });

  // ── existing event producers ────────────────────────────────────────────

  eventUnsubs.push(
    pi.events.on("goal-todo:state-updated", (data) => {
      const d = data as { tasks?: { id: number; status: string; subject?: string }[] } | undefined;
      if (!d?.tasks) return;
      const done = d.tasks.filter((t) => t.status === "completed").length;
      const inProgress = d.tasks.find((t) => t.status === "in_progress");
      snapshot.control.todoDone = done;
      snapshot.control.todoTotal = d.tasks.length;
      snapshot.control.todoCurrentId = inProgress?.id;
      snapshot.control.todoCurrentSubject = inProgress?.subject;
      invalidate();
    }),

    pi.events.on("delegation:lane", (data) => {
      const d = data as { type?: string; lane?: { id?: string } } | undefined;
      const id = d?.lane?.id;
      if (!id) return;
      if (d?.type === "remove") activeDelegations.delete(id);
      else activeDelegations.add(id);
      snapshot.control.activeDelegations = activeDelegations.size;
      invalidate();
    }),

    pi.events.on(MCP_STATUS_CHANNEL, (data) => {
      const snap = data as { servers?: { disabled?: boolean }[]; connectedCount?: number; disabledCount?: number } | undefined;
      if (!snap || !Array.isArray(snap.servers)) return;
      const total = snap.servers.length;
      const disabled = typeof snap.disabledCount === "number" ? snap.disabledCount : snap.servers.filter((s) => s?.disabled === true).length;
      snapshot.control.mcpEnabled = total - disabled;
      snapshot.control.mcpConnected = typeof snap.connectedCount === "number" ? snap.connectedCount : 0;
      invalidate();
    }),

    // Segment bus.
    pi.events.on(SEGMENT_CHANNEL, handleSegment),
  );

  // ── shutdown ────────────────────────────────────────────────────────────

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    for (const unsub of eventUnsubs) unsub();
    eventUnsubs = [];
    branchUnsub?.();
    branchUnsub = undefined;
    if (clockTimer) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
    poller?.dispose();
    poller = undefined;
    segmentStore.clear();
    ctx.ui.setFooter(undefined);
    tuiRef = undefined;
    themeRef = undefined;
    footerDataRef = undefined;
  });
}
