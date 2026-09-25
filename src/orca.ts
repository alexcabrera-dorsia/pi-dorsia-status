/**
 * dorsia-status — Orca integration.
 *
 * Detects Orca via ORCA_PANE_KEY. If absent, returns an inert poller.
 * Polls `orca terminal list --worktree active --json` (sibling tabs) and
 * `orca worktree ps --json` (current-worktree agent states) on adaptive TTLs,
 * joins terminal panes to agents by paneKey, and emits a normalized SESSIONS
 * snapshot on pi.events channel `dorsia-status:sessions/v1`.
 *
 * Polling policy (from the plan §4):
 *   - terminals: 2s while any local tab is working, 5s when idle/done
 *   - worktrees: 5s when work exists, 15s when idle
 *   - one scheduler wakes at the nearest due feed; never more than one
 *     request in flight per feed
 *   - failures retain last good snapshot; exponential backoff to 60s
 *   - timers unref'd; dispose() on session_shutdown
 *
 * CLI version note (v1.4.182): no `--host` flag exists. Local targeting is
 * omission of `--environment`; only add `--environment <name>` when a saved
 * remote is explicitly selected (not implemented here — local only).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OrcaFreshness, SessionInfo, SessionsLane } from "./render.ts";

// ── env identity ────────────────────────────────────────────────────────────

export interface OrcaEnv {
  worktreeId?: string;
  tabId?: string;
  paneKey?: string;
  active: boolean;
}

/** Read Orca identity from the environment. */
export function orcaEnv(env: NodeJS.ProcessEnv = process.env): OrcaEnv {
  const paneKey = env.ORCA_PANE_KEY;
  return {
    worktreeId: env.ORCA_WORKTREE_ID,
    tabId: env.ORCA_TAB_ID,
    paneKey,
    active: typeof paneKey === "string" && paneKey.length > 0,
  };
}

// ── raw CLI shapes (defensive — fields may be missing/malformed) ────────────

export interface RawTerminal {
  paneKey?: string;
  tabId?: string;
  handle?: string;
  title?: string;
  writable?: boolean;
  connected?: boolean;
  lastMessagePreview?: string;
  lastActivityAt?: number;
  updatedAt?: number;
}

export interface RawAgent {
  paneKey?: string;
  state?: string;
  agentType?: string;
  toolName?: string;
  prompt?: string;
  lastAssistantMessage?: string;
  interrupted?: boolean;
  stateStartedAt?: number;
  updatedAt?: number;
}

export interface RawWorktree {
  id?: string;
  displayName?: string;
  name?: string;
  branch?: string;
  status?: string;
  /** Board column: todo | in-progress | in-review | completed. */
  workspaceStatus?: string;
  /** Current orca shape: linkedPR: { number, state } (null when unlinked). */
  linkedPR?: { number?: number; state?: string } | null;
  /** GitHub issue/PR number linked via `orca worktree set --issue` (PRs share
   *  GitHub's issue numbering; set when the PR itself is not detectable). */
  linkedIssue?: number | null;
  /** Linear issue identifier linked via `orca worktree set --linear-issue`. */
  linkedLinearIssue?: string | null;
  /** Linear workspace url key (e.g. "dorsia"); often absent from metadata. */
  linkedLinearIssueOrganizationUrlKey?: string | null;
  /** Present on `worktree current` records: e.g. "github:elomi-inc/dorsia-monorepo". */
  projectId?: string;
  repo?: string;
  /** Legacy string fields from older orca shapes. */
  prLink?: string;
  pr?: string;
  linearLink?: string;
  linearIssue?: string;
  agents?: RawAgent[];
}

/** One-shot current-worktree metadata (display name, branch, status, links). */
export interface WorktreeMeta {
  displayName?: string;
  branch?: string;
  status?: string;
  prLink?: string;
  prUrl?: string;
  linearLink?: string;
  linearUrl?: string;
}

// ── normalization (exported for tests) ──────────────────────────────────────

const STATE_PRIORITY: Record<string, number> = {
  error: 0, failed: 0, blocked: 1, working: 2, running: 2, thinking: 3,
  idle: 4, done: 5, completed: 5, success: 5,
};

/** Derive PR display label + URL from a raw worktree record.
 *  Handles the current `linkedPR: {number, state}` shape (URL built from the
 *  `github:owner/repo` projectId when available) and the legacy `prLink`/`pr`
 *  string shape (used verbatim when it is already an http URL). */
export function prFromRaw(w: RawWorktree, projectIdFallback?: string): { label?: string; url?: string } {
  const n = w.linkedPR?.number;
  if (typeof n === "number") {
    const projectId = typeof w.projectId === "string" && w.projectId ? w.projectId : projectIdFallback;
    const m = typeof projectId === "string" ? /^github:([^/\s]+)\/([^\s]+)$/.exec(projectId.trim()) : null;
    return {
      label: `#${n}`,
      url: m ? `https://github.com/${m[1]}/${m[2]}/pull/${n}` : undefined,
    };
  }
  // GitHub issue/PR number linked via `orca worktree set --issue`. GitHub
  // shares numbering between issues and PRs, and /issues/N redirects to the
  // pull-request view, so the URL is safe for either.
  if (typeof w.linkedIssue === "number") {
    const projectId = typeof w.projectId === "string" && w.projectId ? w.projectId : projectIdFallback;
    const m = typeof projectId === "string" ? /^github:([^/\s]+)\/([^\s]+)$/.exec(projectId.trim()) : null;
    return {
      label: `#${w.linkedIssue}`,
      url: m ? `https://github.com/${m[1]}/${m[2]}/issues/${w.linkedIssue}` : undefined,
    };
  }
  const legacy = w.prLink ?? w.pr;
  if (typeof legacy === "string" && legacy.trim()) {
    const clean = legacy.trim();
    if (/^https?:\/\//.test(clean)) {
      return { label: `#${clean.split("/").pop() || "PR"}`, url: clean };
    }
    return { label: clean };
  }
  return {};
}

/** Shortstat: " 3 files changed, 12 insertions(+), 4 deletions(-)" → { added, removed }.
 *  Missing clauses mean zero for that side. */
export function parseDiffShortstat(out: string): { added: number; removed: number } {
  const num = (re: RegExp): number => {
    const m = re.exec(out);
    const n = m ? Number.parseInt(m[1], 10) : 0;
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  };
  return {
    added: num(/(\d+) insertion/),
    removed: num(/(\d+) deletion/),
  };
}

/** Count untracked entries in `git status --porcelain` output. */
export function countUntracked(porcelain: string): number {
  let n = 0;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("??")) n++;
  }
  return n;
}

/** Derive Linear display label + URL from legacy string fields. */
export function linearFromRaw(w: RawWorktree, orgUrlKeyFallback?: string): { label?: string; url?: string } {
  const identifier = typeof w.linkedLinearIssue === "string" ? w.linkedLinearIssue.trim() : "";
  if (identifier) {
    const org = (typeof w.linkedLinearIssueOrganizationUrlKey === "string" && w.linkedLinearIssueOrganizationUrlKey.trim())
      ? w.linkedLinearIssueOrganizationUrlKey.trim()
      : orgUrlKeyFallback;
    return { label: identifier, url: org ? `https://linear.app/${org}/issue/${identifier}` : undefined };
  }
  const legacy = w.linearLink ?? w.linearIssue;
  if (typeof legacy === "string" && legacy.trim()) {
    const clean = legacy.trim();
    if (/^https?:\/\//.test(clean)) return { url: clean };
    return { label: clean };
  }
  return {};
}

function statePriority(state: string | undefined): number {
  return STATE_PRIORITY[state ?? ""] ?? 6;
}

/** Pick the highest-priority agent record for a multi-pane tab. */
function pickAgent(agents: RawAgent[]): RawAgent | undefined {
  if (agents.length === 0) return undefined;
  return agents.slice().sort((a, b) => {
    const d = statePriority(a.state) - statePriority(b.state);
    if (d !== 0) return d;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  })[0];
}

/**
 * Join terminal panes to agents by paneKey and produce the normalized SESSIONS
 * lane. Aliases (@1, @2, ...) are assigned by `assignAlias` — the caller owns
 * alias stability across polls (session-lifetime, never reused).
 *
 * @param terminals  from `orca terminal list --worktree active --json`
 * @param agents     agents[] of the current worktree from `orca worktree ps --json`
 * @param env        local Orca identity (marks `isMe`)
 * @param assignAlias (tabId) => alias string; stable per tab
 */
export function normalizeSessions(
  terminals: RawTerminal[],
  agents: RawAgent[],
  env: OrcaEnv,
  assignAlias: (tabId: string) => string,
): SessionsLane {
  const byPane = new Map<string, RawAgent[]>();
  for (const a of agents) {
    if (!a.paneKey) continue;
    const list = byPane.get(a.paneKey) ?? [];
    list.push(a);
    byPane.set(a.paneKey, list);
  }

  const me: SessionInfo = { isMe: true, paneKey: env.paneKey, tabId: env.tabId, state: "working" };
  const siblings: SessionInfo[] = [];

  // Group terminals by tabId: multi-pane tab = one cell with highest-priority pane.
  const byTab = new Map<string, RawTerminal[]>();
  for (const t of terminals) {
    const tabId = t.tabId ?? t.paneKey ?? "";
    if (!tabId) continue;
    const list = byTab.get(tabId) ?? [];
    list.push(t);
    byTab.set(tabId, list);
  }

  for (const [tabId, terms] of byTab) {
    if (env.tabId && tabId === env.tabId) {
      // Fill in my own tab info from the polled data.
      const agent = pickAgent(terms.flatMap((t) => (t.paneKey ? (byPane.get(t.paneKey) ?? []) : [])));
      if (agent) {
        me.agentType = agent.agentType;
        me.state = agent.state;
        me.toolName = agent.toolName;
        me.lastAssistantMessagePreview = agent.lastAssistantMessage?.slice(0, 80);
      }
      me.alias = "me";
      continue;
    }
    const allAgents = terms.flatMap((t) => (t.paneKey ? (byPane.get(t.paneKey) ?? []) : []));
    const agent = pickAgent(allAgents);
    const term = terms[0];
    const recency = Math.max(...terms.map((t) => t.lastActivityAt ?? t.updatedAt ?? 0), agent?.updatedAt ?? 0);
    siblings.push({
      paneKey: terms.map((t) => t.paneKey).find(Boolean),
      tabId,
      alias: assignAlias(tabId),
      agentType: agent?.agentType,
      state: agent?.state ?? "idle",
      toolName: agent?.toolName,
      title: term?.title,
      lastAssistantMessagePreview: agent?.lastAssistantMessage?.slice(0, 80),
      recency,
      isMe: false,
    });
  }

  // Order: attention → working → idle → done → recency.
  siblings.sort((a, b) => {
    const d = statePriority(a.state) - statePriority(b.state);
    if (d !== 0) return d;
    return (b.recency ?? 0) - (a.recency ?? 0);
  });

  const shown = siblings.slice(0, 4);
  return { me, siblings: shown, hiddenCount: Math.max(0, siblings.length - shown.length) };
}

// ── poller ──────────────────────────────────────────────────────────────────

export interface OrcaPoller {
  /** Last good sessions lane (undefined until first successful poll). */
  readonly sessions: SessionsLane | undefined;
  /** Current freshness of the Orca data. */
  readonly freshness: OrcaFreshness;
  /** Current-worktree metadata from `orca worktree current --json`. */
  readonly meta: WorktreeMeta | undefined;
  /** Stop all timers. */
  dispose(): void;
}

interface FeedState {
  name: "terminals" | "worktrees";
  nextDue: number;
  inFlight: boolean;
  generation: number;
  consecutiveFailures: number;
  lastResult?: unknown;
}

const TERM_TTL_ACTIVE = 2_000;
const TERM_TTL_IDLE = 5_000;
const TREE_TTL_ACTIVE = 5_000;
const TREE_TTL_IDLE = 15_000;
const BACKOFF_CAP = 60_000;
const CALL_TIMEOUT = 5_000;
const FRESH_WARN_AFTER_POLLS = 2;
const FRESH_ERROR_MS = 30_000;

/**
 * Start the Orca poller. Returns an inert poller when ORCA_PANE_KEY is absent
 * or the `orca` binary is not found.
 *
 * onSnapshot(lane, freshness) is called whenever the normalized sessions lane
 * changes (fingerprinted — unchanged polls don't notify).
 */
export function startOrcaPolling(
  pi: ExtensionAPI,
  onSnapshot: (sessions: SessionsLane, freshness: OrcaFreshness, meta: WorktreeMeta | undefined) => void,
  options?: { environment?: string; execImpl?: typeof pi.exec; linearOrgUrlKey?: string },
): OrcaPoller {
  const env = orcaEnv();
  const exec = options?.execImpl ?? ((cmd: string, args: string[], opts?: { timeout?: number }) => pi.exec(cmd, args, opts));

  const state: {
    sessions: SessionsLane | undefined;
    lastGoodAt: number;
    meta: WorktreeMeta | undefined;
    /** Cached projectId from `worktree current` — `worktree ps` entries lack it, but linkedPR URLs need owner/repo. */
    projectId?: string;
    fingerprint: string;
    aliases: Map<string, string>;
    nextAlias: number;
    disposed: boolean;
    timer?: ReturnType<typeof setTimeout>;
    missedExpectedPolls: number;
  } = {
    sessions: undefined,
    lastGoodAt: 0,
    meta: undefined,
    fingerprint: "",
    aliases: new Map(),
    nextAlias: 1,
    disposed: false,
    missedExpectedPolls: 0,
  };

  const assignAlias = (tabId: string): string => {
    let a = state.aliases.get(tabId);
    if (!a) {
      a = String(state.nextAlias++);
      state.aliases.set(tabId, a);
    }
    return a;
  };

  function freshness(): OrcaFreshness {
    if (!state.lastGoodAt) return { ageMs: 0, state: "error" };
    const ageMs = Date.now() - state.lastGoodAt;
    if (ageMs > FRESH_ERROR_MS) return { ageMs, state: "error" };
    if (state.missedExpectedPolls >= FRESH_WARN_AFTER_POLLS) return { ageMs, state: "stale" };
    return { ageMs, state: "fresh" };
  }

  async function runOrca(args: string[]): Promise<unknown> {
    const fullArgs = options?.environment ? [...args, "--environment", options.environment] : args;
    const res = await exec("orca", [...fullArgs, "--json"], { timeout: CALL_TIMEOUT });
    if (res.code !== 0) throw new Error(`orca ${args[0]} exited ${res.code}: ${res.stderr.slice(0, 200)}`);
    return JSON.parse(res.stdout);
  }

  function publish(): void {
    const lane = state.sessions;
    if (!lane) return;
    const fp = JSON.stringify([lane.siblings.map((s) => [s.tabId, s.state, s.toolName]), lane.hiddenCount]);
    if (fp === state.fingerprint) return;
    state.fingerprint = fp;
    const fresh = freshness();
    onSnapshot(lane, fresh, state.meta);
    try {
      pi.events.emit("dorsia-status:sessions/v1", { sessions: [lane.me, ...lane.siblings].filter(Boolean), orcaFreshness: fresh });
    } catch { /* events bus unavailable — best effort */ }
  }

  // Inert poller: no Orca identity.
  if (!env.active) {
    return {
      get sessions() { return undefined; },
      get freshness() { return { ageMs: 0, state: "error" as const }; },
      get meta() { return undefined; },
      dispose() {},
    };
  }

  const feeds: FeedState[] = [
    { name: "terminals", nextDue: 0, inFlight: false, generation: 0, consecutiveFailures: 0 },
    { name: "worktrees", nextDue: 0, inFlight: false, generation: 0, consecutiveFailures: 0 },
  ];
  let rawTerminals: RawTerminal[] = [];
  let rawAgents: RawAgent[] = [];

  async function pollFeed(feed: FeedState): Promise<void> {
    if (feed.inFlight || state.disposed) return;
    feed.inFlight = true;
    const gen = ++feed.generation;
    try {
      const data =
        feed.name === "terminals"
          ? await runOrca(["terminal", "list", "--worktree", "active"])
          : await runOrca(["worktree", "ps"]);
      // Late result from an older generation → discard.
      if (gen !== feed.generation || state.disposed) return;
      feed.consecutiveFailures = 0;
      state.missedExpectedPolls = 0;
      if (feed.name === "terminals") {
        rawTerminals = Array.isArray(data) ? (data as RawTerminal[]) : Array.isArray((data as { terminals?: unknown[] })?.terminals) ? ((data as { terminals: RawTerminal[] }).terminals) : [];
      } else {
        // Find the current worktree's agents.
        const list = Array.isArray(data) ? (data as RawWorktree[]) : Array.isArray((data as { worktrees?: unknown[] })?.worktrees) ? ((data as { worktrees: RawWorktree[] }).worktrees) : [];
        const current = list.find((w) => env.worktreeId && w.id === env.worktreeId) ?? list[0];
        rawAgents = Array.isArray(current?.agents) ? current.agents : [];
        if (current) {
          const pr = prFromRaw(current, state.projectId);
          const linear = linearFromRaw(current, options?.linearOrgUrlKey);
          state.meta = {
            displayName: current.displayName ?? current.name,
            branch: current.branch,
            status: current.workspaceStatus ?? current.status,
            prLink: pr.label,
            prUrl: pr.url,
            linearLink: linear.label,
            linearUrl: linear.url,
          };
        }
      }
      state.lastGoodAt = Date.now();
      state.sessions = normalizeSessions(rawTerminals, rawAgents, env, assignAlias);
      publish();
    } catch {
      feed.consecutiveFailures++;
      state.missedExpectedPolls++;
    } finally {
      feed.inFlight = false;
      // Adaptive TTL: active when any sibling is working.
      const anyWorking = (state.sessions?.siblings ?? []).some((s) => s.state === "working" || s.state === "running");
      const base = feed.name === "terminals" ? (anyWorking ? TERM_TTL_ACTIVE : TERM_TTL_IDLE) : anyWorking ? TREE_TTL_ACTIVE : TREE_TTL_IDLE;
      const backoff = feed.consecutiveFailures > 0 ? Math.min(BACKOFF_CAP, base * 2 ** feed.consecutiveFailures) : base;
      feed.nextDue = Date.now() + backoff;
    }
  }

  function tick(): void {
    if (state.disposed) return;
    const now = Date.now();
    for (const feed of feeds) {
      if (!feed.inFlight && now >= feed.nextDue) void pollFeed(feed);
    }
    // Freshness recolor can change without a data change.
    publishFreshnessOnly();
    schedule();
  }

  let lastFreshState = "";
  function publishFreshnessOnly(): void {
    const f = freshness();
    if (f.state !== lastFreshState && state.sessions) {
      lastFreshState = f.state;
      onSnapshot(state.sessions, f, state.meta);
    }
  }

  function schedule(): void {
    if (state.disposed) return;
    const now = Date.now();
    const nearest = Math.min(...feeds.map((f) => (f.inFlight ? now + 500 : f.nextDue)));
    const delay = Math.max(100, nearest - now);
    state.timer = setTimeout(tick, delay);
    state.timer.unref?.();
  }

  // One-shot startup metadata (best-effort).
  void (async () => {
    try {
      const data = await runOrca(["worktree", "current"]);
      if (state.disposed) return;
      const w = data as RawWorktree;
      if (typeof w.projectId === "string" && w.projectId) state.projectId = w.projectId;
      const pr = prFromRaw(w);
      const linear = linearFromRaw(w, options?.linearOrgUrlKey);
      state.meta = {
        displayName: w.displayName ?? w.name,
        branch: w.branch,
        status: w.workspaceStatus ?? w.status,
        prLink: pr.label,
        prUrl: pr.url,
        linearLink: linear.label,
        linearUrl: linear.url,
      };
    } catch { /* keep polling; meta stays undefined */ }
  })();

  tick();

  return {
    get sessions() { return state.sessions; },
    get freshness() { return freshness(); },
    get meta() { return state.meta; },
    dispose() {
      state.disposed = true;
      if (state.timer) clearTimeout(state.timer);
    },
  };
}
