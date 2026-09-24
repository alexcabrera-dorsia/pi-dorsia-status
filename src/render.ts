/**
 * dorsia-status — pure four-row status renderer.
 *
 * No I/O. `renderStatus(width, snapshot, theme)` returns exactly 4 strings,
 * one per row: model, work, fleet, control. Empty segments disappear; rows
 * never collapse (padded to width, never to height).
 *
 * The underlying data model keeps five lanes (agent, session, work, sessions,
 * control) for segment-bus compatibility; the agent + session lanes merge
 * onto row 1. Former right-side metadata packs onto the left — the expanding
 * gap read as dead space.
 *
 * Width fitting per row (fixed-lane packer, no spilling between rows):
 *   1. Add visible segments in descending priority.
 *   2. Too wide → compact then evict optional detail by priority.
 *   3. Compact required state where a useful fallback exists, then shrink-widest.
 *   4. Final guard: truncateToWidth.
 */

import { hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── shared types ───────────────────────────────────────────────────────────

export type Lane = "agent" | "session" | "work" | "sessions" | "control";
export type Side = "left" | "right";
/** Tones map to theme colors: normal→text, dim→dim, muted→muted, accent→accent, success→success, warning→warning, error→error. */
export type Tone = "normal" | "dim" | "muted" | "accent" | "success" | "warning" | "error";

/** A single piece of status content produced by lifecycle handlers or the segment bus. */
export interface Segment {
  id: string;
  lane: Lane;
  icon?: string;
  label?: string;
  value?: string;
  tone?: Tone;
  priority: number;
  side: Side;
  maxWidth?: number;
  /** Optional segments are evicted first on overflow. Defaults to false (sacred). */
  optional?: boolean;
  /** Compact fallback text used when required state cannot fit at full detail. */
  labelOnly?: string;
  /** When set, label+value render as an underlined OSC 8 hyperlink to this URL. */
  link?: string;
}

export interface AgentLane {
  state: "idle" | "working" | "thinking" | "writing" | "calling-tools" | "reading" | "editing" | "done" | "error";
  activity: string;
  /** Joined provider/model id, e.g. "anthropic/claude-opus-4.5". */
  model?: string;
  /** Auto-routed model reported by hyper/prism via X-Prism-Model-Name/-Id response headers. */
  routedModel?: string;
  thinkingLevel?: string;
  thinkingOn?: boolean;
}

export interface SessionLane {
  percent: number | null;
  tokens: number | null;
  contextWindow: number | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Cumulative time the agent spent working (busy), in ms. */
  workTimeMs?: number;
  /** Cost burn rate, e.g. "$1.20/hr". */
  costRate?: string;
}

export interface WorkLane {
  workspace?: string;
  cwdTail?: string;
  branch?: string | null;
  dirtyAdded?: number;
  dirtyRemoved?: number;
  dirtyUntracked?: number;
  ahead?: number;
  behind?: number;
  prLink?: string;
  prUrl?: string;
  linearLink?: string;
  linearUrl?: string;
  worktreeStatus?: string;
}

export interface SessionInfo {
  paneKey?: string;
  tabId?: string;
  alias?: string;
  agentType?: string;
  state?: string;
  toolName?: string;
  title?: string;
  lastAssistantMessagePreview?: string;
  recency?: number;
  isMe?: boolean;
  /** Role label for the lead session (e.g. "orchestrator"). */
  role?: string;
}

export interface OrcaFreshness {
  ageMs: number;
  state: "fresh" | "stale" | "error";
}

export interface SessionsLane {
  me?: SessionInfo;
  siblings: SessionInfo[];
  hiddenCount: number;
  /** pi-subagents currently running. */
  subagentsRunning?: number;
  /** Cumulative spend of completed subagents this session, in USD. */
  subagentSpendUsd?: number;
}

export interface ControlLane {
  todoDone?: number;
  todoTotal?: number;
  todoCurrentId?: number;
  todoCurrentSubject?: string;
  activeDelegations?: number;
  mcpConnected?: number;
  mcpEnabled?: number;
  orcaFreshness?: OrcaFreshness;
  /** Unknown legacy setStatus() keys, capped at 1. */
  transientAlert?: string;
  /** Agentically generated single-sentence summary of what is happening. */
  thinkingSummary?: string;
  blocker?: string;
}

export interface Snapshot {
  agent: AgentLane;
  session: SessionLane;
  work: WorkLane;
  sessions: SessionsLane;
  control: ControlLane;
  /** External-producer segments keyed by lane. */
  segments: Record<Lane, Segment[]>;
}

/** Minimal theme surface the renderer needs. The real Theme duck-types to this. */
export interface StatusTheme {
  fg(color: Tone | "text", text: string): string;
  bg(color: string, text: string): string;
}

/** Statusline theme: how each lane gets its colors.
 *  - c64:       bold saturated bg + contrasting bold fg (solid color bars)
 *  - grayscale: dark gray bg + light gray fg per lane (muted bars)
 *  - no-bg:     no background; lane color applied to fg text only (flat text)
 *  - nord:      Nord palette — polar-night bgs alternating per row with
 *               frost/aurora accent fgs, bold (coordinated color bars)
 *  Each theme provides a per-lane (bg, fg) pair + whether to fill the row bg. */
export type StatuslineThemeId = "c64" | "grayscale" | "no-bg" | "nord";

export interface StatuslinePalette {
  /** Per-lane (bg, fg) truecolor pairs. */
  pairs: Record<Lane, { bg: string; fg: string }>;
  /** When true, each row is padded to full width and wrapped in its lane bg. */
  fillBg: boolean;
  /** When true, text is bold. */
  bold: boolean;
}

const C64_PAIRS: Record<Lane, { bg: string; fg: string }> = {
  agent:    { bg: "200;50;50",   fg: "255;255;255" },  // red + white
  session:  { bg: "220;130;30",  fg: "0;0;0"       },  // orange + black
  work:     { bg: "50;170;50",   fg: "0;0;0"       },  // green + black
  sessions: { bg: "50;80;200",   fg: "255;255;255" },  // blue + white
  control:  { bg: "180;50;180",  fg: "255;255;255" },  // purple + white
};

const GRAYSCALE_PAIRS: Record<Lane, { bg: string; fg: string }> = {
  agent:    { bg: "40;40;40",   fg: "220;220;220" },
  session:  { bg: "52;52;52",   fg: "200;200;200" },
  work:     { bg: "64;64;64",   fg: "180;180;180" },
  sessions: { bg: "48;48;48",   fg: "210;210;210" },
  control:  { bg: "56;56;56",   fg: "190;190;190" },
};

// no-bg: fg colors echo the C64 lane hues on a transparent background.
const NO_BG_PAIRS: Record<Lane, { bg: string; fg: string }> = {
  agent:    { bg: "0;0;0",      fg: "220;80;80"   },  // red text
  session:  { bg: "0;0;0",      fg: "230;140;40"  },  // orange text
  work:     { bg: "0;0;0",      fg: "80;190;80"   },  // green text
  sessions: { bg: "0;0;0",      fg: "80;110;220"  },  // blue text
  control:  { bg: "0;0;0",      fg: "190;80;190"  },  // purple text
};

// Nord: polar-night bgs (#2e3440 = 46;52;64, #3b4252 = 59;66;82) alternate
// per row; foregrounds are frost/aurora accents — frost cyan #88c0d0,
// aurora yellow #ebcb8b, aurora green #a3be8c, frost blue #81a1c1,
// aurora purple #b48ead.
const NORD_PAIRS: Record<Lane, { bg: string; fg: string }> = {
  agent:    { bg: "46;52;64",   fg: "136;192;208" },  // polar night + frost cyan
  session:  { bg: "59;66;82",   fg: "235;203;139" },  // polar night + aurora yellow
  work:     { bg: "46;52;64",   fg: "163;190;140" },  // polar night + aurora green
  sessions: { bg: "59;66;82",   fg: "129;161;193" },  // polar night + frost blue
  control:  { bg: "46;52;64",   fg: "180;142;173" },  // polar night + aurora purple
};

export const STATUSLINE_THEMES: Record<StatuslineThemeId, StatuslinePalette> = {
  c64:       { pairs: C64_PAIRS,       fillBg: true,  bold: true  },
  grayscale: { pairs: GRAYSCALE_PAIRS, fillBg: true,  bold: false },
  "no-bg":   { pairs: NO_BG_PAIRS,    fillBg: false, bold: false },
  nord:      { pairs: NORD_PAIRS,     fillBg: true,  bold: true  },
};

/** Current active theme. Changed at runtime via `/statusline-theme`.
 *  Defaults to "nord" — the house palette on this config. */
export let currentStatuslineTheme: StatuslineThemeId = "nord";

/** Switch the active statusline theme. Called by the `/statusline-theme` command. */
export function setStatuslineTheme(id: StatuslineThemeId): void {
  currentStatuslineTheme = id;
}

/** Backward-compat: the Nord pairs (used by tests that import LANE_PAIR). */
export const LANE_PAIR: Record<Lane, { bg: string; fg: string }> = NORD_PAIRS;

/** Build a per-row StatusTheme that forces the lane's pair fg onto every
 *  segment, so the whole row is one coordinated color bar. */
function makePairTheme(lane: Lane, _base: StatusTheme): StatusTheme {
  const palette = STATUSLINE_THEMES[currentStatuslineTheme];
  const pair = palette.pairs[lane];
  const bold = palette.bold ? "\x1b[1m" : "";
  const boldRst = palette.bold ? "\x1b[22m" : "";
  return {
    fg: (_color, text) => `${bold}\x1b[38;2;${pair.fg}m${text}\x1b[39m${boldRst}`,
    bg: (_color, text) => `\x1b[48;2;${pair.bg}m${text}\x1b[49m`,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

const BLANK = "";
/** Light separator between segments; also joins the former right block onto the left. */
const GROUP_SEP = " \u00b7 "; // " · "

/** Map a Tone to the theme color name; "normal" → "text". */
function toneColor(tone?: Tone): "text" | "dim" | "muted" | "accent" | "success" | "warning" | "error" {
  if (!tone || tone === "normal") return "text";
  return tone;
}

/** Strip ANSI escape sequences (CSI/OSC) whole, then newlines/control bytes,
 * so producers can't inject line breaks or leak escape params as text.
 * Stripping only control bytes leaves `[48;2;…m` fragments visible when a
 * producer (e.g. pi-background-tasks) embeds raw truecolor codes. */
export function sanitize(s: string | undefined): string {
  if (!s) return "";
  return s
    .replace(/\x1b\[[0-9;:?<=> \-/]*[@-~]/g, "") // CSI: ESC [ params final
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC: ESC ] … BEL/ST
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, " ")
    .trim();
}

/** Sanitize a link URL: cut at the first control byte (ESC/OSC injection can't
 *  smuggle text past it), then require http(s). Non-conforming links render as plain text. */
function sanitizeLink(url: string | undefined): string {
  if (!url) return "";
  const clean = url.split(/[\x00-\x1f\x7f]/)[0].trim();
  return /^https?:\/\//.test(clean) ? clean : "";
}

/** Build a visible cell: semantic icon, quiet label, semantic value.
 *  When seg.link is a valid http(s) URL, the label+value become an
 *  underlined OSC 8 hyperlink (clickable wherever the host TUI resolves
 *  link clicks; pi-tui is OSC 8-aware for width/truncation). */
function segText(seg: Segment, theme: StatusTheme): string {
  const icon = sanitize(seg.icon);
  const label = sanitize(seg.label);
  const value = sanitize(seg.value);
  const tone = toneColor(seg.tone);
  const iconPart = icon ? theme.fg(tone, icon) : "";
  let body = [label ? theme.fg("dim", label) : "", value ? theme.fg(tone, value) : ""]
    .filter(Boolean)
    .join(" ");
  const link = sanitizeLink(seg.link);
  if (link && body) body = `\x1b[4m${hyperlink(body, link)}\x1b[24m`;
  return [iconPart, body].filter(Boolean).join(" ");
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Format a millisecond duration compactly, e.g. "42s", "12m", "1h24m". */
function fmtDuration(ms: number): string {
  if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / MIN);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

function fmtCost(usd: number | undefined): { text: string; tone: Tone } {
  if (usd == null) return { text: "", tone: "normal" };
  const text = `$${usd.toFixed(2)}`;
  if (usd >= 5) return { text, tone: "error" };
  if (usd >= 1) return { text, tone: "warning" };
  return { text, tone: "muted" };
}

// ── width fitter ─────────────────────────────────────────────────────────────

interface PackedSeg {
  text: string; // already styled
  width: number; // visible width
  priority: number;
  optional: boolean;
  shrinkable: boolean;
  /** Compact fallback text or null if already collapsed/unavailable. */
  labelText: string | null;
}

/**
 * Pack left and right segments into one width-safe row.
 * Optional detail collapses or disappears before required anchors shrink.
 * Both sides pack onto the left: the former right block is appended after the
 * left block (joined with GROUP_SEP) rather than right-aligned via a gap.
 */
export function packRow(
  width: number,
  leftSegs: Segment[],
  rightSegs: Segment[],
  theme: StatusTheme,
): string {
  const toPacked = (s: Segment): PackedSeg => {
    const fit = (text: string): string => s.maxWidth == null ? text : truncateToWidth(text, Math.max(1, s.maxWidth));
    const text = fit(segText(s, theme));
    const labelText = s.labelOnly ? fit(segText({ ...s, label: undefined, value: s.labelOnly }, theme)) : null;
    return { text, width: visibleWidth(text), priority: s.priority, optional: !!s.optional, shrinkable: true, labelText };
  };

  const left = leftSegs.slice().sort((a, b) => b.priority - a.priority).map(toPacked).filter((s) => s.width > 0);
  const right = rightSegs.slice().sort((a, b) => b.priority - a.priority).map(toPacked).filter((s) => s.width > 0);

  const blockWidth = (segs: PackedSeg[]): number =>
    segs.reduce((sum, seg) => sum + seg.width, 0) + Math.max(0, segs.length - 1) * visibleWidth(GROUP_SEP);
  // Blocks now join with GROUP_SEP instead of an expanding gap.
  const totalW = (): number =>
    blockWidth(left) + blockWidth(right) + (left.length && right.length ? visibleWidth(GROUP_SEP) : 0);
  const all = () => [
    ...left.map((seg, index) => ({ seg, side: "left" as const, index })),
    ...right.map((seg, index) => ({ seg, side: "right" as const, index })),
  ];

  // Keep compact icon/labels when useful, but never sacrifice required state
  // merely to preserve optional values.
  while (totalW() > width) {
    const collapsible = all()
      .filter(({ seg }) => seg.optional && seg.labelText != null)
      .sort((a, b) => a.seg.priority - b.seg.priority || b.seg.width - a.seg.width)[0];
    if (!collapsible) break;
    collapsible.seg.text = collapsible.seg.labelText!;
    collapsible.seg.width = visibleWidth(collapsible.seg.text);
    collapsible.seg.labelText = null;
  }

  while (totalW() > width) {
    const victim = all().filter(({ seg }) => seg.optional).sort((a, b) => a.seg.priority - b.seg.priority)[0];
    if (!victim) break;
    (victim.side === "left" ? left : right).splice(victim.index, 1);
  }

  while (totalW() > width) {
    const collapsible = all().map(({ seg }) => seg).filter((seg) => seg.labelText != null).sort((a, b) => b.width - a.width)[0];
    if (!collapsible) break;
    collapsible.text = collapsible.labelText!;
    collapsible.width = visibleWidth(collapsible.text);
    collapsible.labelText = null;
    collapsible.shrinkable = false;
  }

  while (totalW() > width) {
    const widest = all().map(({ seg }) => seg).filter((seg) => seg.shrinkable).sort((a, b) => b.width - a.width)[0];
    if (!widest) break;
    const overflow = totalW() - width;
    if (widest.width <= overflow) {
      // Stall: no segment can absorb the overflow by shrinking. Evict the
      // lowest-priority remaining segment — including required ones — so the
      // final truncation never clips a surviving cell mid-segment.
      const evict = all().sort((a, b) => a.seg.priority - b.seg.priority)[0];
      if (!evict) break;
      (evict.side === "left" ? left : right).splice(evict.index, 1);
      continue;
    }
    widest.text = truncateToWidth(widest.text, Math.max(1, widest.width - overflow));
    widest.width = visibleWidth(widest.text);
  }

  const dimSep = theme.fg("dim", GROUP_SEP);
  const leftStr = left.map((seg) => seg.text).join(dimSep);
  const rightStr = right.map((seg) => seg.text).join(dimSep);
  // Former right-side metadata appends to the left — no trailing gap, no right anchor.
  if (!leftStr) return truncateToWidth(rightStr, width, undefined, true);
  if (!rightStr) return truncateToWidth(leftStr, width, undefined, true);
  return truncateToWidth(leftStr + dimSep + rightStr, width, undefined, true);
}

// ── per-row renderers ───────────────────────────────────────────────────────

// ── glyphs ────────────────────────────────────────────────────────────────
// Nerd Font icons identify lanes/metadata; plain UTF markers carry live state.
// All codepoints are locked to the safest Font Awesome band U+F000–U+F2E0.
// All icons are Nerd Font PUA glyphs (Font Awesome band U+F000–U+F2E0),
// verified to render in BlexMono Nerd Font (the installed font).
const GLYPH = {
  // model row
  session: "\uf0e4", // nf-fa-tachometer (context window meter)
  cost: "\uf155",   // nf-fa-dollar
  duration: "\uf0e7", // nf-fa-bolt (time spent working)
  model: "\uf2d0",  // nf-oct-cpu (provider/model)
  thinking: "\uf0eb", // nf-fa-lightbulb (thinking level)
  // work row
  branch: "\uf126", // nf-oct-git_branch
  pr: "\uf09b",     // nf-fa-github (PR proxy)
  linear: "\uf0ae", // nf-fa-tasks (Linear/issues)
  // fleet row
  sessions: "\uf0c0", // nf-fa-group (peers/tabs)
  deleg: "\uf0ec",  // nf-fa-exchange (delegations)
};

function stateTone(state: AgentLane["state"]): Tone {
  switch (state) {
    case "idle": return "muted";
    case "working": return "accent";
    case "thinking": return "accent";
    case "writing": return "accent";
    case "calling-tools": return "accent";
    case "reading": return "muted";
    case "editing": return "muted";
    case "done": return "success";
    case "error": return "error";
    default: return "normal";
  }
}

function stateGlyph(state: AgentLane["state"]): string {
  switch (state) {
    case "idle": return "○";
    case "working": return "●";
    case "thinking": return "◐";
    case "writing": return "✎";
    case "calling-tools": return "◆";
    case "reading": return "◉";
    case "editing": return "✎";
    case "done": return "✓";
    case "error": return "!";
  }
}

function sessionStateGlyph(state: string | undefined): { glyph: string; tone: Tone } {
  switch (state) {
    case "working": case "running": return { glyph: "●", tone: "accent" };
    case "thinking": return { glyph: "◐", tone: "accent" };
    case "idle": return { glyph: "○", tone: "muted" };
    case "done": case "completed": case "success": return { glyph: "✓", tone: "success" };
    case "error": case "failed": return { glyph: "!", tone: "error" };
    case "blocked": return { glyph: "⊘", tone: "warning" };
    default: return { glyph: "○", tone: "muted" };
  }
}

/** Segment id (sessions lane) carrying the current goal/task + live agent
 *  activity, pushed by the live-goal-widget. Renders as a fleet-row segment. */
export const GOAL_ROLE_SEGMENT_ID = "goal-current";

function renderModelRow(width: number, snap: Snapshot, theme: StatusTheme): string {
  const a = snap.agent;
  const s = snap.session;
  const left: Segment[] = [];

  // Selected model + thinking level.
  if (a.model) {
    left.push({ id: "model-id", lane: "agent", icon: GLYPH.model, value: a.model, tone: "accent", priority: 120, side: "left" });
  }
  if (a.routedModel) {
    left.push({ id: "agent-prism-routed", lane: "agent", value: `→ ${a.routedModel}`, tone: "muted", priority: 118, side: "left", optional: true });
  }
  if (a.thinkingOn && a.thinkingLevel && a.thinkingLevel !== "off") {
    left.push({ id: "model-thinking", lane: "agent", icon: GLYPH.thinking, value: a.thinkingLevel, tone: "muted", priority: 115, side: "left", optional: true });
  }

  // Context window: percent + token I/O in one cell (tachometer glyph).
  const barTone: Tone = s.percent != null && s.percent >= 90 ? "error" : s.percent != null && s.percent >= 80 ? "warning" : "accent";
  const percent = s.percent == null ? "?%" : `${Math.round(s.percent)}%`;
  const io = s.inputTokens != null || s.outputTokens != null ? ` ↑${fmtTokens(s.inputTokens)} ↓${fmtTokens(s.outputTokens)}` : "";
  left.push({ id: "session-ctx", lane: "session", icon: GLYPH.session, value: `${percent}${io}`, tone: barTone, priority: 110, side: "left", labelOnly: percent });

  // Cost, time spent working, burn rate. The cost cell is required — it
  // survives eviction; only extreme truncation cuts it. When subagents have
  // spent anything, the total folds their spend in and a compact "sub" cell
  // carries the breakdown:  $0.73 · sub $0.31
  const subSpend = snap.sessions.subagentSpendUsd ?? 0;
  const cost = fmtCost((s.costUsd ?? 0) + subSpend || undefined);
  if (cost.text) {
    left.push({ id: "session-cost", lane: "session", icon: GLYPH.cost, value: cost.text, tone: cost.tone, priority: 90, side: "left" });
  }
  if (subSpend > 0) {
    left.push({ id: "session-cost-sub", lane: "session", label: "sub", value: `$${subSpend.toFixed(2)}`, tone: "muted", priority: 89, side: "left", optional: true });
  }
  if (s.workTimeMs != null && s.workTimeMs > 0) {
    left.push({ id: "session-worktime", lane: "session", icon: GLYPH.duration, value: fmtDuration(s.workTimeMs), tone: "dim", priority: 85, side: "left", optional: true });
  }
  if (s.costRate) {
    left.push({ id: "session-costrate", lane: "session", icon: GLYPH.cost, value: s.costRate, tone: "muted", priority: 80, side: "left", optional: true });
  }

  // External segments from the agent + session lanes pack here too.
  for (const seg of [...snap.segments.agent, ...snap.segments.session]) left.push(seg);

  return packRow(width, left, [], theme);
}

function renderWorkRow(width: number, snap: Snapshot, theme: StatusTheme): string {
  const w = snap.work;
  const left: Segment[] = [];

  // Branch — fall back to cwd tail when detached/no git.
  if (w.branch) {
    const branch = w.branch.replace(/^refs\/heads\//, "");
    left.push({ id: "work-branch", lane: "work", icon: GLYPH.branch, value: branch, tone: "accent", priority: 110, side: "left" });
  } else if (w.cwdTail) {
    left.push({ id: "work-cwd", lane: "work", value: sanitize(w.cwdTail), tone: "muted", priority: 110, side: "left" });
  }

  // Diff footprint.
  const dirtyParts: string[] = [];
  if (w.dirtyAdded) dirtyParts.push(`+${w.dirtyAdded}`);
  if (w.dirtyRemoved) dirtyParts.push(`-${w.dirtyRemoved}`);
  if (w.dirtyUntracked) dirtyParts.push(`!${w.dirtyUntracked}`);
  if (dirtyParts.length) {
    left.push({ id: "work-dirty", lane: "work", value: dirtyParts.join(" "), tone: "warning", priority: 100, side: "left", optional: true });
  }

  // Position vs upstream.
  const ab: string[] = [];
  if (w.ahead) ab.push(`↑${w.ahead}`);
  if (w.behind) ab.push(`↓${w.behind}`);
  if (ab.length) {
    left.push({ id: "work-ab", lane: "work", value: ab.join(" "), tone: "dim", priority: 95, side: "left", optional: true });
  }

  // Worktree state (Orca-managed or git status word).
  if (w.worktreeStatus) {
    const statusTone: Tone = /^(clean|ready|done|completed)$/i.test(w.worktreeStatus)
      ? "success"
      : /^(blocked|error|failed)$/i.test(w.worktreeStatus) ? "error" : "muted";
    left.push({ id: "work-status", lane: "work", value: w.worktreeStatus, tone: statusTone, priority: 90, side: "left", optional: true });
  }

  // Linked PR + Linear ticket.
  if (w.prLink) {
    left.push({ id: "work-pr", lane: "work", icon: GLYPH.pr, value: w.prLink, tone: "accent", priority: 90, side: "left", optional: true, link: w.prUrl });
  }
  if (w.linearLink) {
    left.push({ id: "work-linear", lane: "work", icon: GLYPH.linear, value: w.linearLink, tone: "accent", priority: 85, side: "left", optional: true, link: w.linearUrl });
  }
  for (const seg of snap.segments.work) left.push(seg);

  return packRow(width, left, [], theme);
}

/** Sibling states that count as actively working in the fleet view. */
const FLEET_ACTIVE_STATES = new Set(["working", "running", "thinking", "calling-tools", "reading", "editing"]);

/** Broad per-sibling summary width — enough to orient, not enough to crowd. */
const FLEET_SUMMARY_WIDTH = 28;

function renderFleetRow(width: number, snap: Snapshot, theme: StatusTheme): string {
  const s = snap.sessions;
  const left: Segment[] = [];

  // Headline: how many peers are actively working.
  const activeCount = s.siblings.filter((sib) => FLEET_ACTIVE_STATES.has(sib.state ?? "")).length;
  left.push({
    id: "fleet-active", lane: "sessions", icon: GLYPH.sessions,
    value: `${activeCount} active`, tone: activeCount > 0 ? "accent" : "muted", priority: 110, side: "left",
  });

  // In-flight delegations from this session.
  const deleg = snap.control.activeDelegations ?? 0;
  if (deleg > 0) {
    left.push({ id: "fleet-deleg", lane: "sessions", icon: GLYPH.deleg, label: "deleg", value: `${deleg}`, tone: "accent", priority: 100, side: "left", optional: true });
  }

  // pi-subagents: running count (spend shows in the row-1 cost breakdown).
  const subRunning = s.subagentsRunning ?? 0;
  if (subRunning > 0) {
    left.push({ id: "fleet-sub", lane: "sessions", icon: GLYPH.deleg, label: "sub", value: `${subRunning}`, tone: "accent", priority: 98, side: "left", optional: true });
  }

  // Per-sibling: state glyph + broad summary (title, else last message preview).
  for (const sib of s.siblings.slice(0, 4)) {
    const sg = sessionStateGlyph(sib.state);
    const alias = sib.alias ?? "?";
    const type = sib.agentType ?? "pi";
    const summary = sanitize(sib.title) || sanitize(sib.lastAssistantMessagePreview);
    left.push({
      id: `sessions-sib-${alias}`, lane: "sessions", label: `@${alias}`,
      value: summary ? `${sg.glyph} ${summary}` : `${sg.glyph} ${type}`,
      tone: sg.tone, priority: 80, side: "left", optional: true, maxWidth: FLEET_SUMMARY_WIDTH,
    });
  }
  if (s.hiddenCount > 0) {
    left.push({ id: "sessions-more", lane: "sessions", label: "hidden", value: `+${s.hiddenCount}`, tone: "dim", priority: 50, side: "left", optional: true });
  }
  // External segments (incl. goal-current) pack onto the fleet row.
  for (const seg of snap.segments.sessions) left.push(seg);

  return packRow(width, left, [], theme);
}

function renderControlRow(width: number, snap: Snapshot, theme: StatusTheme): string {
  const c = snap.control;
  const left: Segment[] = [];

  // The row carries exactly one thing: a single-sentence summary of what the
  // agent is doing right now. Each refresh replaces the previous sentence.
  if (c.thinkingSummary) {
    left.push({ id: "control-thinking-summary", lane: "control", icon: GLYPH.thinking, value: c.thinkingSummary, tone: "accent", priority: 130, side: "left", maxWidth: 70 });
  }
  return packRow(width, left, [], theme);
}

// ── top-level renderer ──────────────────────────────────────────────────────

/**
 * Render exactly 4 status rows for the given width.
 * Rows: model (agent+session lanes), work, fleet (sessions), control. Always 4
 * strings, padded to width. Each row is wrapped in its lane background color
 * (full-width color-bar).
 */
export function renderStatus(width: number, snapshot: Snapshot, theme: StatusTheme): string[] {
  const w = Math.max(1, width);
  // Row → lane pairing: the model row reuses the agent pair (the session lane
  // merged into it); work, fleet, control keep their own pairs.
  const rowLanes: Lane[] = ["agent", "work", "sessions", "control"];
  const palette = STATUSLINE_THEMES[currentStatuslineTheme];
  // Inner content renders at w-4 to leave room for 2-space padding at both ends.
  const inner = Math.max(1, w - 4);
  // Each row renders with its lane's pair theme so every segment takes the
  // pair's bold fg — one solid coordinated color bar per row.
  const bodies = [
    renderModelRow(inner, snapshot, makePairTheme("agent", theme)),
    renderWorkRow(inner, snapshot, makePairTheme("work", theme)),
    renderFleetRow(inner, snapshot, makePairTheme("sessions", theme)),
    renderControlRow(inner, snapshot, makePairTheme("control", theme)),
  ];
  return bodies.slice(0, 4).map((body, i) => {
    const pair = palette.pairs[rowLanes[i]];
    // 2-space padding inside the bar at both ends.
    const padded = `  ${body}  `;
    let row = visibleWidth(padded) <= w ? padded : truncateToWidth(padded, w, undefined, true);
    // Pad the visible content to full width so the bg bar spans the row.
    const pad = w - visibleWidth(row);
    if (pad > 0) row += " ".repeat(pad);
    // no-bg theme: no background fill — just the text (pair fg already applied).
    if (!palette.fillBg) return row;
    // Wrap the whole row in the lane's truecolor background.
    return `\x1b[48;2;${pair.bg}m${row}\x1b[49m`;
  });
}

/** Empty snapshot for startup. */
export function emptySnapshot(): Snapshot {
  return {
    agent: { state: "idle", activity: "" },
    session: { percent: null, tokens: null, contextWindow: null },
    work: {},
    sessions: { siblings: [], hiddenCount: 0 },
    control: {},
    segments: { agent: [], session: [], work: [], sessions: [], control: [] },
  };
}
