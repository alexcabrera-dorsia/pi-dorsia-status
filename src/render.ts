/**
 * dorsia-status — pure five-row status renderer.
 *
 * No I/O. `renderStatus(width, snapshot, theme)` returns exactly 5 strings,
 * one per lane: agent, session, work, sessions, control. Empty segments
 * disappear; rows never collapse (padded to width, never to height).
 *
 * Width fitting per row (fixed-lane packer, no spilling between rows):
 *   1. Lay out left + right anchors first.
 *   2. Add visible segments in descending priority.
 *   3. Too wide → compact then evict optional detail by priority.
 *   4. Compact required state where a useful fallback exists, then shrink-widest.
 *   5. Final guard: truncateToWidth.
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
  turn?: number;
  clock?: string;
  /** Recent context-% samples (oldest → newest) for the braille sparkline. */
  history?: number[];
  /** Session wall-clock duration, e.g. "1h24m". */
  duration?: string;
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
/** A light separator within a side; the gap between sides expands to right-align metadata. */
const GROUP_SEP = " \u00b7 "; // " · "
const SIDE_GAP = 2;

/** Map a Tone to the theme color name; "normal" → "text". */
function toneColor(tone?: Tone): "text" | "dim" | "muted" | "accent" | "success" | "warning" | "error" {
  if (!tone || tone === "normal") return "text";
  return tone;
}

/** Strip ANSI escape sequences (CSI/OSC) whole, then newlines/control bytes,
 * so producers can't inject line breaks or leak escape params as text.
 * Stripping only control bytes leaves `[48;2;…m` fragments visible when a
 * producer (e.g. pi-background-tasks) embeds raw truecolor codes. */
function sanitize(s: string | undefined): string {
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

/** Braille sparkline: 7 levels showing recent context-% history (oldest → newest). */
const SPARK = ["⣀", "⣄", "⣆", "⣇", "⣧", "⣷", "⣿"];
const SPARK_N = 8;

/** Build a braille sparkline from recent context-% samples plus the current value. */
function contextSpark(percent: number | null, history?: number[]): string {
  const samples = (history ?? []).slice(-SPARK_N + 1);
  if (percent != null) samples.push(Math.max(0, Math.min(100, percent)));
  if (samples.length === 0) return "⣀";
  // Scale each sample to one of 7 braille levels.
  return samples.map((p) => {
    const i = Math.min(SPARK.length - 1, Math.floor((p / 100) * SPARK.length));
    return SPARK[Math.max(0, i)];
  }).join("");
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
 * Optional detail collapses or disappears before required anchors shrink. When
 * both sides survive, the right block is aligned to the final column.
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
  const totalW = (): number => blockWidth(left) + blockWidth(right) + (left.length && right.length ? SIDE_GAP : 0);
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
      widest.shrinkable = false;
      continue;
    }
    widest.text = truncateToWidth(widest.text, Math.max(1, widest.width - overflow));
    widest.width = visibleWidth(widest.text);
  }

  const dimSep = theme.fg("dim", GROUP_SEP);
  const leftStr = left.map((seg) => seg.text).join(dimSep);
  const rightStr = right.map((seg) => seg.text).join(dimSep);
  if (!leftStr) {
    const gap = " ".repeat(Math.max(0, width - visibleWidth(rightStr)));
    return truncateToWidth(gap + rightStr, width, undefined, true);
  }
  if (!rightStr) return truncateToWidth(leftStr, width, undefined, true);
  const gap = " ".repeat(Math.max(SIDE_GAP, width - visibleWidth(leftStr) - visibleWidth(rightStr)));
  return truncateToWidth(leftStr + gap + rightStr, width, undefined, true);
}

// ── per-row renderers ───────────────────────────────────────────────────────

// ── glyphs ────────────────────────────────────────────────────────────────
// Nerd Font icons identify lanes/metadata; plain UTF markers carry live state.
// All codepoints are locked to the safest Font Awesome band U+F000–U+F2E0.
// All icons are Nerd Font PUA glyphs (Font Awesome band U+F000–U+F2E0),
// verified to render in BlexMono Nerd Font (the installed font).
const GLYPH = {
  // lane badges
  agent: "\uf0e8",   // nf-fa-sitemap (agent/workflow)
  session: "\uf0e4", // nf-fa-tachometer (context/tokens/time)
  work: "\uf07c",   // nf-fa-folder_open (repo/workspace)
  sessions: "\uf0c0", // nf-fa-group (tabs/people)
  control: "\uf013", // nf-fa-gear (control/system)
  // session row
  tokens: "\uf0d1", // nf-oct-database (in/out)
  cost: "\uf155",   // nf-fa-dollar
  turn: "\uf01e",   // nf-fa-rotate (turn)
  clock: "\uf017",  // nf-fa-clock_o
  duration: "\uf017", // nf-fa-clock_o (session wall-clock)
  model: "\uf2d0",  // nf-oct-cpu (provider/model)
  // work row
  branch: "\uf126", // nf-oct-git_branch
  clean: "\uf00c",  // nf-fa-check
  pr: "\uf09b",     // nf-fa-github (PR proxy)
  linear: "\uf0ae", // nf-fa-tasks (Linear/issues)
  // sessions row
  pane: "\uf2d0",   // nf-fa-window_maximize
  deleg: "\uf0ec",  // nf-fa-exchange
  // control row
  todo: "\uf03a",   // nf-fa-list_ul
  mcp: "\uf1e6",    // nf-fa-plug
  orca: "\uf2db",   // nf-fa-microchip
  alert: "\uf06a",  // nf-fa-exclamation_circle
  blocker: "\uf05e", // nf-fa-ban
  me: "\uf007",     // nf-fa-user
  thinking: "\uf0eb", // nf-fa-lightbulb
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

function renderAgentRow(width: number, snap: Snapshot, theme: StatusTheme): string {
  const a = snap.agent;
  const tone = stateTone(a.state);
  const left: Segment[] = [
    { id: "agent-lane", lane: "agent", icon: GLYPH.agent, tone: "accent", priority: 110, side: "left" },
    { id: "agent-state", lane: "agent", icon: stateGlyph(a.state), value: a.state.replace(/-/g, " "), tone, priority: 100, side: "left" },
  ];
  if (a.activity) {
    left.push({ id: "agent-activity", lane: "agent", value: a.activity, tone: "muted", priority: 80, side: "left", optional: true });
  }
  for (const s of snap.segments.agent) {
    if (s.side === "left") left.push(s);
  }

  const right: Segment[] = [];
  if (a.model) {
    right.push({ id: "agent-model", lane: "agent", icon: GLYPH.model, value: a.model, tone: "muted", priority: 70, side: "right", optional: true });
  }
  if (a.routedModel) {
    right.push({ id: "agent-prism-routed", lane: "agent", value: `→ ${a.routedModel}`, tone: "muted", priority: 65, side: "right", optional: true });
  }
  if (a.thinkingOn && a.thinkingLevel && a.thinkingLevel !== "off") {
    right.push({ id: "agent-thinking", lane: "agent", icon: GLYPH.thinking, value: a.thinkingLevel, tone: "accent", priority: 60, side: "right", optional: true });
  }
  for (const s of snap.segments.agent) {
    if (s.side === "right") right.push(s);
  }

  return packRow(width, left, right, theme);
}

function renderSessionRow(width: number, snap: Snapshot, theme: StatusTheme): string {
  const s = snap.session;
  const left: Segment[] = [
    { id: "session-lane", lane: "session", icon: GLYPH.session, tone: "accent", priority: 110, side: "left" },
  ];
  const barTone: Tone = s.percent != null && s.percent >= 90 ? "error" : s.percent != null && s.percent >= 80 ? "warning" : "accent";
  const percent = s.percent == null ? "" : ` ${Math.round(s.percent)}%`;
  left.push({ id: "session-ctx", lane: "session", label: "ctx", value: `${contextSpark(s.percent, s.history)}${percent}`, tone: barTone, priority: 100, side: "left", labelOnly: `ctx${percent || " ?"}` });
  if (s.tokens != null && s.contextWindow) {
    left.push({ id: "session-tokens", lane: "session", icon: GLYPH.tokens, value: `${fmtTokens(s.tokens)}/${fmtTokens(s.contextWindow)}`, tone: "muted", priority: 85, side: "left", optional: true });
  }
  if (s.inputTokens != null || s.outputTokens != null) {
    const io = `↑${fmtTokens(s.inputTokens)} ↓${fmtTokens(s.outputTokens)}`;
    left.push({ id: "session-io", lane: "session", label: "io", value: io, tone: "dim", priority: 75, side: "left", optional: true });
  }
  for (const seg of snap.segments.session) if (seg.side === "left") left.push(seg);

  const right: Segment[] = [];
  const cost = fmtCost(s.costUsd);
  if (cost.text) {
    right.push({ id: "session-cost", lane: "session", icon: GLYPH.cost, value: cost.text, tone: cost.tone, priority: 80, side: "right", optional: true });
  }
  if (s.duration) {
    right.push({ id: "session-duration", lane: "session", icon: GLYPH.duration, value: s.duration, tone: "dim", priority: 72, side: "right", optional: true });
  }
  if (s.costRate) {
    right.push({ id: "session-costrate", lane: "session", icon: GLYPH.cost, value: s.costRate, tone: "muted", priority: 68, side: "right", optional: true });
  }
  if (s.turn != null) {
    right.push({ id: "session-turn", lane: "session", icon: GLYPH.turn, value: `${s.turn}`, tone: "dim", priority: 60, side: "right", optional: true });
  }
  if (s.clock) {
    right.push({ id: "session-clock", lane: "session", icon: GLYPH.clock, value: s.clock, tone: "dim", priority: 50, side: "right", optional: true });
  }
  for (const seg of snap.segments.session) if (seg.side === "right") right.push(seg);

  return packRow(width, left, right, theme);
}

function renderWorkRow(width: number, snap: Snapshot, theme: StatusTheme): string {
  const w = snap.work;
  const left: Segment[] = [
    { id: "work-lane", lane: "work", icon: GLYPH.work, tone: "accent", priority: 110, side: "left" },
  ];
  const ws = sanitize(w.workspace) || sanitize(w.cwdTail);
  if (ws) {
    left.push({ id: "work-ws", lane: "work", value: ws, tone: "accent", priority: 100, side: "left" });
  }
  if (w.worktreeStatus) {
    const statusTone: Tone = /^(clean|ready|done|completed)$/i.test(w.worktreeStatus)
      ? "success"
      : /^(blocked|error|failed)$/i.test(w.worktreeStatus) ? "error" : "muted";
    left.push({ id: "work-status", lane: "work", value: w.worktreeStatus, tone: statusTone, priority: 85, side: "left", optional: true });
  }
  for (const seg of snap.segments.work) if (seg.side === "left") left.push(seg);

  const right: Segment[] = [];
  if (w.branch) {
    const branch = w.branch.replace(/^refs\/heads\//, "");
    right.push({ id: "work-branch", lane: "work", icon: GLYPH.branch, value: branch, tone: "muted", priority: 90, side: "right", optional: true });
  }
  // Git ahead/behind.
  const ab: string[] = [];
  if (w.ahead) ab.push(`↑${w.ahead}`);
  if (w.behind) ab.push(`↓${w.behind}`);
  if (ab.length) {
    right.push({ id: "work-ab", lane: "work", value: ab.join(" "), tone: "dim", priority: 88, side: "right", optional: true });
  }
  const dirtyParts: string[] = [];
  if (w.dirtyAdded) dirtyParts.push(`+${w.dirtyAdded}`);
  if (w.dirtyRemoved) dirtyParts.push(`-${w.dirtyRemoved}`);
  if (w.dirtyUntracked) dirtyParts.push(`!${w.dirtyUntracked}`);
  if (dirtyParts.length) {
    right.push({ id: "work-dirty", lane: "work", value: dirtyParts.join(" "), tone: "warning", priority: 95, side: "right", optional: true });
  }
  if (w.prLink) {
    right.push({ id: "work-pr", lane: "work", icon: GLYPH.pr, value: w.prLink, tone: "accent", priority: 60, side: "right", optional: true, link: w.prUrl });
  }
  if (w.linearLink) {
    right.push({ id: "work-linear", lane: "work", icon: GLYPH.linear, value: w.linearLink, tone: "accent", priority: 55, side: "right", optional: true, link: w.linearUrl });
  }
  for (const seg of snap.segments.work) if (seg.side === "right") right.push(seg);

  return packRow(width, left, right, theme);
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

/** Segment id (sessions lane) that takes over the lead-session role slot:
 *  the live-goal-widget pushes the current goal/task + live agent activity
 *  here (its composeGoalStatus). When present, its value replaces the
 *  "orchestrator" role text and its tone replaces the state tone. */
export const GOAL_ROLE_SEGMENT_ID = "goal-current";

function renderSessionsRow(width: number, snap: Snapshot, theme: StatusTheme): string {
  const s = snap.sessions;
  const left: Segment[] = [
    { id: "sessions-lane", lane: "sessions", icon: GLYPH.sessions, tone: "accent", priority: 110, side: "left" },
  ];

  const me = s.me;
  const goalSeg = snap.segments.sessions.find((seg) => seg.id === GOAL_ROLE_SEGMENT_ID && seg.side === "left");
  const role = sanitize(goalSeg?.value) || sanitize(me?.role) || "orchestrator";
  const meState = me ? sessionStateGlyph(me.state) : { glyph: "●", tone: "accent" as Tone };
  left.push({
    id: "sessions-me", lane: "sessions", icon: GLYPH.me,
    value: `${role} ${meState.glyph}`, tone: goalSeg?.tone ?? meState.tone, priority: 100, side: "left",
  });
  for (const seg of snap.segments.sessions) if (seg.side === "left" && seg.id !== GOAL_ROLE_SEGMENT_ID) left.push(seg);

  // Current session stays left; peer tabs form a deliberately right-anchored block.
  // Siblings show state + type only (no previews, no recency).
  const right: Segment[] = [];
  for (const sib of s.siblings.slice(0, 4)) {
    const sg = sessionStateGlyph(sib.state);
    const alias = sib.alias ?? "?";
    const type = sib.agentType ?? "pi";
    right.push({
      id: `sessions-sib-${alias}`, lane: "sessions", label: `@${alias}`,
      value: `${sg.glyph} ${type}`, tone: sg.tone, priority: 80, side: "right", optional: true,
    });
  }
  if (s.hiddenCount > 0) {
    right.push({ id: "sessions-more", lane: "sessions", label: "hidden", value: `+${s.hiddenCount}`, tone: "dim", priority: 50, side: "right", optional: true });
  }
  for (const seg of snap.segments.sessions) if (seg.side === "right" && seg.id !== GOAL_ROLE_SEGMENT_ID) right.push(seg);

  return packRow(width, left, right, theme);
}

function renderControlRow(width: number, snap: Snapshot, theme: StatusTheme): string {
  const c = snap.control;
  const left: Segment[] = [
    { id: "control-lane", lane: "control", icon: GLYPH.control, tone: "accent", priority: 110, side: "left" },
  ];

  // Error/blocker is highest priority sacred.
  if (c.blocker) {
    left.push({ id: "control-blocker", lane: "control", icon: GLYPH.blocker, value: c.blocker, tone: "error", priority: 100, side: "left" });
  }
  // Transient alert (unknown legacy status), capped at 1.
  if (c.transientAlert) {
    left.push({ id: "control-alert", lane: "control", icon: GLYPH.alert, value: c.transientAlert, tone: "warning", priority: 90, side: "left", optional: true });
  }
  // Keep progress sacred and let the current subject disappear independently.
  if (c.todoTotal != null && c.todoTotal > 0) {
    const done = c.todoDone ?? 0;
    const tone: Tone = done >= c.todoTotal ? "success" : "accent";
    const current = c.todoCurrentId == null ? "" : ` #${c.todoCurrentId}`;
    left.push({ id: "control-todo", lane: "control", icon: GLYPH.todo, value: `${done}/${c.todoTotal}${current}`, tone, priority: 100, side: "left", labelOnly: `${done}/${c.todoTotal}` });
    if (c.todoCurrentSubject) {
      left.push({ id: "control-todo-subject", lane: "control", value: c.todoCurrentSubject, tone: "muted", priority: 60, side: "left", optional: true });
    }
  }
  // Active delegations (count only).
  if (c.activeDelegations != null && c.activeDelegations > 0) {
    left.push({ id: "control-deleg", lane: "control", icon: GLYPH.deleg, label: "deleg", value: `${c.activeDelegations}`, tone: "accent", priority: 70, side: "left", optional: true });
  }
  for (const seg of snap.segments.control) if (seg.side === "left") left.push(seg);

  const right: Segment[] = [];
  // MCP count.
  if (c.mcpEnabled != null) {
    const connected = c.mcpConnected ?? 0;
    const tone: Tone = connected === c.mcpEnabled && c.mcpEnabled > 0 ? "success" : connected > 0 ? "warning" : "error";
    right.push({ id: "control-mcp", lane: "control", icon: GLYPH.mcp, label: "mcp", value: `${connected}/${c.mcpEnabled}`, tone, priority: 80, side: "right", optional: true });
  }
  // Orca freshness.
  if (c.orcaFreshness) {
    const f = c.orcaFreshness;
    const secs = Math.round(f.ageMs / 1000);
    right.push({ id: "control-orca", lane: "control", icon: GLYPH.orca, label: "orca", value: `${f.state} ${secs}s`, tone: f.state === "error" ? "error" : f.state === "stale" ? "warning" : "dim", priority: 50, side: "right", optional: true });
  }
  for (const seg of snap.segments.control) if (seg.side === "right") right.push(seg);

  return packRow(width, left, right, theme);
}

// ── top-level renderer ──────────────────────────────────────────────────────

/**
 * Render exactly 5 status rows for the given width.
 * Rows: agent, session, work, sessions, control. Always 5 strings, padded to width.
 * Each row is wrapped in its lane background color (full-width color-bar).
 */
export function renderStatus(width: number, snapshot: Snapshot, theme: StatusTheme): string[] {
  const w = Math.max(1, width);
  const lanes: Lane[] = ["agent", "session", "work", "sessions", "control"];
  const palette = STATUSLINE_THEMES[currentStatuslineTheme];
  // Inner content renders at w-4 to leave room for 2-space padding at both ends.
  const inner = Math.max(1, w - 4);
  // Each row renders with its lane's pair theme so every segment takes the
  // pair's bold fg — one solid coordinated color bar per row.
  const bodies = [
    renderAgentRow(inner, snapshot, makePairTheme("agent", theme)),
    renderSessionRow(inner, snapshot, makePairTheme("session", theme)),
    renderWorkRow(inner, snapshot, makePairTheme("work", theme)),
    renderSessionsRow(inner, snapshot, makePairTheme("sessions", theme)),
    renderControlRow(inner, snapshot, makePairTheme("control", theme)),
  ];
  return bodies.slice(0, 5).map((body, i) => {
    const pair = palette.pairs[lanes[i]];
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
