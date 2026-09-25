/**
 * dorsia-status — four-row status footer for pi.
 *
 * Sole owner of ctx.ui.setFooter(). Renders exactly 4 rows every render:
 *   1. MODEL   — provider/model, thinking level, context %, token I/O, cost,
 *                time spent working, cost/hr (live agent state lives in the
 *                editor-border working indicator instead)
 *   2. WORK    — git branch, diff +/-, PR + Linear links (OSC 8 clickable)
 *   3. FLEET   — active peer/subagent count, delegations, per-peer summaries
 *   4. CONTROL — MCP health, Orca freshness, honcho/external segments, alerts
 *
 * Compat bridge: unknown setStatus() keys surface in CONTROL (capped at 1).
 *
 * Event-bus protocol:
 *   dorsia-status:segment/v1          — {op:"upsert"|"remove", id, lane, icon?, label?, value?, tone?, priority, side, maxWidth?, expiry?}
 *   dorsia-status:request-snapshot/v1 — footer emits after mount; producers republish
 *   dorsia-status:sessions/v1         — published normalized Orca sessions snapshot
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { emptySnapshot, renderStatus, sanitize, setStatuslineTheme, type Lane, type Segment, type SessionInfo, type SessionsLane, type StatuslineThemeId, type Snapshot, type StatusTheme, STATUSLINE_THEMES } from "./render.ts";
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

  // Session wall-clock start (cost rate).
  let sessionStartedAt = 0;

  // Working-time clock: ticks ONLY while the agent is actively thinking or
  // writing inside a turn. Paused while tools execute and while waiting for
  // user input — pure model-work time, nothing else.
  let workedMs = 0;
  let workClockRunning = false;
  let workClockSince = 0;

  function pauseWorkClock(): void {
    if (!workClockRunning) return;
    workedMs += Date.now() - workClockSince;
    workClockRunning = false;
  }

  function resumeWorkClock(): void {
    if (workClockRunning) return;
    workClockRunning = true;
    workClockSince = Date.now();
  }

  // Cost accumulators — persisted via custom session entries so /reload and
  // session resume keep the totals (in-memory state alone zeroes on reload).
  let sessionCostUsd: number | undefined;
  let subagentSpendUsd = 0;
  const COST_ENTRY_TYPE = "dorsia-status:cost";

  function persistCost(): void {
    try {
      pi.appendEntry(COST_ENTRY_TYPE, { sessionCostUsd, subagentSpendUsd, workedMs });
    } catch {
      /* persistence is best effort */
    }
  }

  /** Restore cost totals from the last persisted custom entry (reload/resume). */
  function restoreCost(ctx: ExtensionContext): void {
    try {
      const entries = ctx.sessionManager.getEntries() as { type?: string; customType?: string; data?: { sessionCostUsd?: number; subagentSpendUsd?: number; workedMs?: number } }[];
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.type === "custom" && e.customType === COST_ENTRY_TYPE && e.data) {
          sessionCostUsd = typeof e.data.sessionCostUsd === "number" ? e.data.sessionCostUsd : undefined;
          subagentSpendUsd = typeof e.data.subagentSpendUsd === "number" ? e.data.subagentSpendUsd : 0;
          workedMs = typeof e.data.workedMs === "number" ? e.data.workedMs : 0;
          snapshot.session.costUsd = sessionCostUsd;
          snapshot.sessions.subagentSpendUsd = subagentSpendUsd;
          snapshot.session.workTimeMs = workedMs > 0 ? workedMs : undefined;
          return;
        }
      }
    } catch {
      /* restore is best effort */
    }
  }

  // ── session summary + current topic (row 4) ─────────────────────────────

  /** Rolling digest of recent tool activity, oldest → newest. */
  const ACTIVITY_MAX = 12;
  let activityLog: string[] = [];
  /** Thinking monitor: accumulated reasoning of the current episode (prompt input). */
  const THINK_BUFFER_MAX = 4000;
  let thinkingBuffer = "";
  let summaryFingerprint = "";
  let lastSummaryAt = 0;
  let summaryInFlight = false;
  const SUMMARY_MIN_INTERVAL_MS = 45_000;
  const SUMMARY_MODEL = process.env.PI_STATUS_SUMMARY_MODEL ?? "hyper/glm-5.3-flash";

  /** The hyper provider ships as a pi package (extension) — locate it so the
   *  headless summary run can load JUST that provider (fast, no other
   *  extensions, no MCP connections). Falls back to normal discovery. */
  const HYPER_PROVIDER_EXT = join(homedir(), ".pi/agent/npm/node_modules/@charmland/pi-hyper-provider/src/index.ts");

  function describeToolArgs(tool: string, args: unknown): string {
    const a = (args ?? {}) as Record<string, unknown>;
    if (tool === "read" || tool === "write" || tool === "edit") {
      const p = typeof a.path === "string" ? a.path : typeof a.to === "string" ? a.to : "";
      const base = p ? p.split("/").filter(Boolean).slice(-2).join("/") : "";
      return `${tool} ${base}`.trim();
    }
    if (tool === "bash") {
      const cmd = typeof a.command === "string" ? a.command.replace(/\s+/g, " ").slice(0, 60) : "";
      return `bash ${cmd}`.trim();
    }
    return tool;
  }

  function recordActivity(tool: unknown, args: unknown): void {
    if (typeof tool !== "string") return;
    activityLog.push(describeToolArgs(tool, args));
    if (activityLog.length > ACTIVITY_MAX) activityLog.shift();
  }

  /** Digest of what the thinking summary is based on — skips identical
   *  regeneration attempts. */
  function summaryDigest(): string {
    return JSON.stringify([thinkingBuffer.slice(-800), activityLog.slice(-6)]);
  }

  function buildSummaryPrompt(): string {
    const activity = activityLog.length ? activityLog.slice(-8).map((a) => `- ${a}`).join("\n") : "- (none yet)";
    return [
      "You are the live status line of a coding agent's UI, updated in place.",
      "Below is the tail of the agent's reasoning stream plus its recent tool activity.",
      "Write ONE short sentence (max 70 characters) describing what is happening right now.",
      "Present tense, plain ASCII, no quotes, no markup, no emoji. Be specific; do not mention the user or any prompt.",
      "",
      "Reasoning stream (abridged, oldest first):",
      thinkingBuffer,
      "",
      "Recent agent activity:",
      activity,
      "",
      "Reply with ONLY the summary line.",
    ].join("\n");
  }

  /** Refresh the row-4 thinking summary with a cheap headless one-shot model
   *  run while the agent thinks. Fire-and-forget: keeps the previous text on
   *  failure, throttled and change-gated so it never burns tokens needlessly. */
  async function refreshThinkingSummary(): Promise<void> {
    if (summaryInFlight) return;
    if (agentState.kind === "idle") return; // only while a turn is active
    if (!thinkingBuffer.trim() && activityLog.length === 0) return;
    const now = Date.now();
    if (now - lastSummaryAt < SUMMARY_MIN_INTERVAL_MS) return;
    const digest = summaryDigest();
    if (digest === summaryFingerprint) return; // nothing new to summarize
    summaryInFlight = true;
    try {
      // `--no-extensions` + explicit `-e` for the hyper provider: the summary
      // run is a bare one-shot completion — no tools, no MCP, no session.
      const hyperExtAvailable = existsSync(HYPER_PROVIDER_EXT);
      const args = [
        "-p", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes",
        "--no-context-files", "--no-tools", "--thinking", "off",
        "--model", SUMMARY_MODEL,
      ];
      if (hyperExtAvailable) args.push("--no-extensions", "-e", HYPER_PROVIDER_EXT);
      args.push("--", buildSummaryPrompt());
      const result = await pi.exec("pi", args, { timeout: 90_000 });
      if (result.code === 0) {
        const line = sanitize(result.stdout.split("\n").find((l) => l.trim()) ?? "");
        if (line) {
          snapshot.control.thinkingSummary = line.slice(0, 80);
          summaryFingerprint = digest;
          lastSummaryAt = Date.now();
          invalidate(true);
        }
      }
    } catch {
      /* keep previous summary on failure */
    } finally {
      summaryInFlight = false;
    }
  }

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

  /** In-flight tool calls (id → tool+args) for the activity digest. */
  const pendingTools = new Map<string, { tool: string; args: unknown }>();

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
      s.percent ?? "", s.tokens ?? "", s.costUsd ?? "", s.workTimeMs ?? "",
      s.costRate ?? "",
      w.branch ?? "", w.workspace ?? "", w.dirtyAdded ?? "", w.dirtyRemoved ?? "",
      w.ahead ?? "", w.behind ?? "", w.prLink ?? "", w.prUrl ?? "",
      w.linearLink ?? "", w.linearUrl ?? "",
      ss.siblings.length, ss.hiddenCount, ss.me?.role ?? "",
      ss.subagentsRunning ?? "", ss.subagentSpendUsd ?? "",
      c.thinkingSummary ?? "",
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

  function updateAgentLane(ctx?: ExtensionContext): void {
    const { state, activity } = stateToActivity(agentState);
    snapshot.agent = { state, activity, model: joinedModelId(currentModel, currentProvider), routedModel, thinkingLevel, thinkingOn };
    syncWorkingMessage(ctx);
  }

  // ── granular working message (pi-core editor-border indicator) ──────────

  let lastWorkingMessage: string | undefined;

  /** Map the agent-state machine to the working-status message shown in the
   *  editor's top border. `undefined` → pi's default "Working (esc to interrupt)". */
  function workingMessageFor(state: AgentState): string | undefined {
    switch (state.kind) {
      case "thinking": return "thinking";
      case "writing": return "writing";
      case "calling-tools": return state.tool === "planning" ? "planning" : `running ${state.tool}`;
      case "reading": return `reading ${state.path}`;
      case "editing": return `editing ${state.path}`;
      default: return undefined; // working / idle → pi's default message
    }
  }

  /** Push the current state into pi's built-in working indicator. Guarded so
   *  high-frequency streaming events only touch the UI on actual transitions. */
  function syncWorkingMessage(ctx?: ExtensionContext): void {
    if (ctx?.mode !== "tui") return;
    const message = workingMessageFor(agentState);
    if (message === lastWorkingMessage) return;
    try {
      ctx.ui.setWorkingMessage(message);
      lastWorkingMessage = message; // only mark synced after the call succeeded
    } catch {
      /* best effort — indicator is cosmetic; leave unmarked so we retry */
    }
  }

  function updateSessionLane(ctx?: ExtensionContext): void {
    const now = Date.now();
    if (!ctx) {
      updateWorkTime(now);
      return;
    }
    const usage = ctx.getContextUsage?.();
    const percent = usage?.percent ?? null;
    const elapsed = sessionStartedAt ? now - sessionStartedAt : 0;
    const costRate = fmtCostRate(sessionCostUsd, elapsed);
    updateWorkTime(now);
    snapshot.session = {
      percent,
      tokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? null,
      costRate,
      // Cost and token I/O accumulate from message events; keep whatever we have.
      inputTokens: snapshot.session.inputTokens,
      outputTokens: snapshot.session.outputTokens,
      costUsd: sessionCostUsd,
      workTimeMs: snapshot.session.workTimeMs,
    };
  }

  /** Working time: banked segments + the live open segment (when running). */
  function updateWorkTime(now: number): void {
    const live = workClockRunning ? now - workClockSince : 0;
    const total = workedMs + live;
    snapshot.session.workTimeMs = total > 0 ? total : undefined;
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
    workClockRunning = false;
    workClockSince = 0;
    workedMs = 0;
    activityLog = [];
    summaryFingerprint = "";
    lastSummaryAt = 0;
    pendingTools.clear();
    thinkingBuffer = "";
    snapshot.control.thinkingSummary = undefined;
    runningSubagents.clear();
    snapshot.sessions.subagentsRunning = 0;
    lastFingerprint = "";
    restoreCost(ctx);
    if (!ctx.isIdle()) resumeWorkClock(); // reloaded mid-turn
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
          // Extension statuses → control-row segments. pi-honcho publishes its
          // connection state here; render it as its own status cell instead of
          // the generic transient alert. Genuinely unknown keys still surface
          // as one transient alert (compat bridge).
          if (footerDataRef) {
            const unknowns: string[] = [];
            for (const [key, value] of footerDataRef.getExtensionStatuses()) {
              if (!value) continue;
              if (!KNOWN_STATUS_KEYS.has(key)) unknowns.push(value);
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
    poller = startOrcaPolling(pi, (lane, freshness, meta) => updateSessionsLane(lane, freshness, meta), {
      linearOrgUrlKey: process.env.PI_LINEAR_ORG_URL_KEY ?? "dorsia",
    });

    updateAgentLane(ctx);
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

  // ── subagent fleet events (pi-subagents) ────────────────────────────────

  const runningSubagents = new Set<string>();

  eventUnsubs.push(
    pi.events.on("subagents:started", (data) => {
      const d = data as { id?: string } | undefined;
      if (!d?.id) return;
      runningSubagents.add(d.id);
      snapshot.sessions.subagentsRunning = runningSubagents.size;
      invalidate();
    }),

    pi.events.on("subagents:created", (data) => {
      const d = data as { id?: string } | undefined;
      if (!d?.id) return;
      runningSubagents.add(d.id);
      snapshot.sessions.subagentsRunning = runningSubagents.size;
      invalidate();
    }),

    // Terminal events carry the whole run's spend as a pi Usage.
    pi.events.on("subagents:completed", (data) => {
      const d = data as { id?: string; usage?: { cost?: { total?: number } } } | undefined;
      if (!d) return;
      if (d.id) runningSubagents.delete(d.id);
      const cost = d.usage?.cost?.total;
      if (cost != null) {
        subagentSpendUsd += cost;
        snapshot.sessions.subagentSpendUsd = subagentSpendUsd;
        persistCost();
      }
      snapshot.sessions.subagentsRunning = runningSubagents.size;
      invalidate();
    }),

    pi.events.on("subagents:failed", (data) => {
      const d = data as { id?: string; usage?: { cost?: { total?: number } } } | undefined;
      if (!d) return;
      if (d.id) runningSubagents.delete(d.id);
      const cost = d.usage?.cost?.total;
      if (cost != null) {
        subagentSpendUsd += cost;
        snapshot.sessions.subagentSpendUsd = subagentSpendUsd;
        persistCost();
      }
      snapshot.sessions.subagentsRunning = runningSubagents.size;
      invalidate();
    }),
  );

  // ── agent state machine events ──────────────────────────────────────────

  pi.on("agent_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools = 0;
    resumeWorkClock();
    agentState = { kind: "working" };
    void refreshThinkingSummary();
    updateAgentLane(ctx);
    invalidate();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    pauseWorkClock();
    persistCost(); // bank workedMs at the turn boundary
    thinkingBuffer = "";
    activeTools = 0;
    agentState = { kind: "idle" };
    updateAgentLane(ctx);
    invalidate();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    pauseWorkClock();
    persistCost(); // bank workedMs at the settle boundary
    thinkingBuffer = "";
    activeTools = 0;
    agentState = { kind: "idle" };
    updateAgentLane(ctx);
    invalidate();
  });

  pi.on("message_update", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const ev = event.assistantMessageEvent;
    if (!ev) return;
    switch (ev.type) {
      case "thinking_start":
        thinkingBuffer = "";
        agentState = { kind: "thinking" };
        break;
      case "thinking_delta":
        agentState = { kind: "thinking" };
        thinkingBuffer += typeof ev.delta === "string" ? ev.delta : "";
        if (thinkingBuffer.length > THINK_BUFFER_MAX) thinkingBuffer = thinkingBuffer.slice(-THINK_BUFFER_MAX);
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
    // While thinking, keep the summary fresh (throttled inside).
    if (agentState.kind === "thinking") void refreshThinkingSummary();
    updateAgentLane(ctx);
    // Fuse in-flight usage.
    const msg = event.message;
    if (msg && msg.role === "assistant" && msg.usage) {
      const u = msg.usage as { input?: number; output?: number; cost?: { total?: number } };
      snapshot.session.inputTokens = u.input;
      snapshot.session.outputTokens = u.output;
      if (u.cost?.total != null && u.cost.total !== sessionCostUsd) {
        sessionCostUsd = u.cost.total;
        persistCost();
      }
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
      if (u.cost?.total != null && u.cost.total !== sessionCostUsd) {
        sessionCostUsd = u.cost.total;
        persistCost();
      }
      updateSessionLane(ctx);
      invalidate();
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (activeTools === 0) pauseWorkClock(); // tools run: the clock waits
    activeTools++;
    void refreshThinkingSummary();
    const tool = event.toolName;
    const args = (event.args ?? {}) as Record<string, unknown>;
    if (event.toolCallId) pendingTools.set(event.toolCallId, { tool, args });
    if (tool === "read") {
      agentState = { kind: "reading", path: truncatePath(args.path) };
    } else if (tool === "write" || tool === "edit") {
      agentState = { kind: "editing", path: truncatePath(args.path ?? args.to) };
    } else {
      agentState = { kind: "calling-tools", tool };
    }
    updateAgentLane(ctx);
    invalidate();
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools = Math.max(0, activeTools - 1);
    if (activeTools === 0) {
      const idle = ctx.isIdle();
      if (!idle) resumeWorkClock(); // back to model work — never while idle
      agentState = idle ? { kind: "idle" } : { kind: "working" };
      void refreshThinkingSummary();
    }
    // Activity digest: successful tool runs only.
    const pending = event.toolCallId ? pendingTools.get(event.toolCallId) : undefined;
    if (pending) {
      pendingTools.delete(event.toolCallId);
      if (!event.isError) recordActivity(pending.tool, pending.args);
    }
    updateAgentLane(ctx);
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
    updateAgentLane(ctx);
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
    updateAgentLane(ctx);
    invalidate();
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    thinkingLevel = event.level;
    thinkingOn = !!thinkingLevel && thinkingLevel !== "off";
    updateAgentLane(ctx);
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
