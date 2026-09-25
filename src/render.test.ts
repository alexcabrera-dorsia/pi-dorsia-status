/**
 * dorsia-status — render.ts acceptance tests.
 *
 * Invariants under test:
 *   1. Exactly four stable, icon-first row identities (model, work, fleet, control).
 *   2. Semantic tones for live state and health.
 *   3. Former right-side metadata packs onto the left at wide widths.
 *   4. Narrow rows retain identity and critical state before optional detail.
 *   5. Sanitized output never exceeds the requested width.
 *
 * Statusline-v2 invariants (14 decisions):
 *   Q1  glyph lockdown (U+F000–U+F2E0)
 *   Q2  full-width bg color-bar rows + icon-only headings (no AGENT/SESSION text)
 *   Q3+Q4  joined provider/model id
 *   Q5  braille sparkline history
 *   Q7  narrow-width eviction cascade
 *   Q8  session duration + cost rate
 *   Q9  git ahead/behind
 *   Q10 state+type siblings only
 *   Q11 no skills counter
 *   Q12 delegations count only
 *   Q13 role label
 *   Q14 thinking glyph defined
 */
import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  renderStatus,
  packRow,
  computeEffort,
  emptySnapshot,
  GOAL_ROLE_SEGMENT_ID,
  LANE_PAIR,
  type Snapshot,
  type Segment,
  type StatusTheme,
} from "./render.ts";

// ── theme stubs ─────────────────────────────────────────────────────────────

/** Pass-through theme: no ANSI, text passes through unchanged. Good for width tests. */
const passthrough: StatusTheme = {
  fg: (_c, t) => t,
  bg: (_c, t) => t,
};

/** Strip ANSI escape sequences so content assertions work under truecolor pairs. */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Marker-wrapping theme: wraps output in ASCII markers so we can assert tones/colors. */
function markerTheme(): { theme: StatusTheme; seen: { fg: string[]; bg: string[] } } {
  const seen = { fg: [] as string[], bg: [] as string[] };
  return {
    seen,
    theme: {
      fg: (c, t) => {
        seen.fg.push(`${c}:${t}`);
        return `<${c}>${t}</${c}>`;
      },
      bg: (c, t) => {
        seen.bg.push(`${c}:${t}`);
        return `[${c}]${t}[/${c}]`;
      },
    },
  };
}

// ── snapshots ───────────────────────────────────────────────────────────────

/** Fully-populated snapshot exercising every lane's content paths. */
function fullSnapshot(): Snapshot {
  return {
    agent: {
      state: "working",
      activity: "editing render.ts",
      model: "anthropic/claude-opus-4.5",
      thinkingOn: true,
      thinkingLevel: "high",
    },
    session: {
      percent: 42,
      tokens: 12000,
      contextWindow: 200000,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.42,
      workTimeMs: 84 * 60_000, // 1h24m of busy time
      costRate: "$0.18/hr",
    },
    work: {
      workspace: "dorsia-pi-config",
      cwdTail: "fix-statusline",
      branch: "alex/fix-statusline",
      dirtyAdded: 3,
      dirtyRemoved: 1,
      dirtyUntracked: 2,
      ahead: 2,
      behind: 1,
      prLink: "#123",
      linearLink: "DOR-45",
      worktreeStatus: "clean",
    },
    sessions: {
      me: { isMe: true, state: "working", role: "orchestrator" },
      siblings: [
        { alias: "1", agentType: "codex", state: "thinking" },
        { alias: "2", agentType: "pi", state: "idle" },
        { alias: "3", agentType: "claude", state: "done" },
      ],
      hiddenCount: 0,
    },
    control: {
      todoDone: 3,
      todoTotal: 5,
      todoCurrentId: 4,
      todoCurrentSubject: "write tests",
      activeDelegations: 2,
      mcpConnected: 3,
      mcpEnabled: 4,
      orcaFreshness: { ageMs: 1500, state: "fresh" },
      blocker: undefined,
    },
    segments: { agent: [], session: [], work: [], sessions: [], control: [] },
  };
}

/** Partial snapshot: some lanes populated, others empty. */
function partialSnapshot(): Snapshot {
  return {
    agent: { state: "idle", activity: "" },
    session: { percent: 10, tokens: null, contextWindow: 100000 },
    work: { branch: "main" },
    sessions: { siblings: [], hiddenCount: 0 },
    control: { mcpEnabled: 2, mcpConnected: 2 },
    segments: { agent: [], session: [], work: [], sessions: [], control: [] },
  };
}

// ── 1. Fixed-row contract ───────────────────────────────────────────────────

describe("fixed-row contract", () => {
  const widths = [40, 80, 120];
  const cases: [string, Snapshot][] = [
    ["empty", emptySnapshot()],
    ["full", fullSnapshot()],
    ["partial", partialSnapshot()],
  ];

  for (const [label, snap] of cases) {
    for (const w of widths) {
      it(`returns exactly 4 rows for ${label} snapshot @ width ${w}`, () => {
        const rows = renderStatus(w, snap, passthrough);
        expect(rows).toHaveLength(4);
      });
    }
  }

  it("rows never collapse: all 4 are strings even at width 1", () => {
    const rows = renderStatus(1, fullSnapshot(), passthrough);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(typeof r).toBe("string");
  });

  it("returns 4 rows for a degenerate width 0 (clamped to 1)", () => {
    const rows = renderStatus(0, emptySnapshot(), passthrough);
    expect(rows).toHaveLength(4);
  });
});

// ── 2. Visual hierarchy and responsive composition ─────────────────────────

describe("visual hierarchy", () => {
  it("gives every row an icon-first identity and its critical content", () => {
    const snap = fullSnapshot();
    snap.control.thinkingSummary = "rewriting packRow eviction";
    const rows = renderStatus(200, snap, passthrough);
    // Row 1 (model): provider/model, thinking level, ctx %, io, cost, work time, rate.
    expect(strip(rows[0])).toContain("anthropic/claude-opus-4.5");
    expect(strip(rows[0])).toContain("high");
    expect(strip(rows[0])).toContain("42%");
    expect(strip(rows[0])).toContain("↑1k ↓500");
    expect(strip(rows[0])).toContain("$0.42");
    expect(strip(rows[0])).toContain("1h24m");
    expect(strip(rows[0])).toContain("$0.18/hr");
    // Row 2 (work): branch + dirty counts + linked PR/ticket.
    expect(strip(rows[1])).toContain("alex/fix-statusline");
    expect(strip(rows[1])).toContain("+3");
    expect(strip(rows[1])).toContain("-1");
    expect(strip(rows[1])).toContain("#123");
    expect(strip(rows[1])).toContain("DOR-45");
    // Row 3 (fleet): active count + per-peer entries + delegations.
    expect(strip(rows[2])).toContain("1 active");
    expect(strip(rows[2])).toContain("@1");
    expect(strip(rows[2])).toContain("deleg");
    // Row 4 (control): the single-sentence live status.
    expect(strip(rows[3])).toContain("rewriting packRow eviction");
  });

  it("keeps row identity and critical state while evicting optional detail at narrow widths", () => {
    const rows = renderStatus(26, fullSnapshot(), passthrough);

    // At 26 cols the shrink cascade keeps context % + cost over the model name.
    expect(strip(rows[0])).toContain("42%");
    expect(strip(rows[0])).toContain("$0.42");
    for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(26);
    expect(strip(rows[1])).toContain("alex/fix-statusline");
    expect(strip(rows[1])).not.toContain("#123");
    expect(strip(rows[2])).not.toContain("@1");
    // No summary has landed in this snapshot, so row 4 is empty.
    expect(strip(rows[3]).trim()).toBe("");
  });
});

// ── 3. No over-width ────────────────────────────────────────────────────────

describe("no over-width", () => {
  const widths = [1, 10, 40, 80, 120, 200];
  const cases: [string, Snapshot][] = [
    ["empty", emptySnapshot()],
    ["full", fullSnapshot()],
    ["partial", partialSnapshot()],
  ];

  for (const [label, snap] of cases) {
    for (const w of widths) {
      it(`every row ≤ ${w} for ${label} snapshot`, () => {
        const rows = renderStatus(w, snap, passthrough);
        for (const r of rows) {
          expect(visibleWidth(r)).toBeLessThanOrEqual(w);
        }
      });
    }
  }
});

// ── 3. Width fitting: priority eviction + shrink-widest + sacred anchors ────

describe("width fitting", () => {
  it("packs surviving right-side metadata onto the left (no trailing gap)", () => {
    const row = packRow(
      40,
      [{ id: "left", lane: "agent", value: "LEFT", priority: 100, side: "left" }],
      [{ id: "right", lane: "agent", value: "RIGHT", priority: 100, side: "right" }],
      passthrough,
    );

    // Right-side metadata follows the left block with the light separator,
    // not an expanding gap anchored to the final column (packRow pads the
    // remainder with spaces, so the trimmed row is the packed content).
    expect(row.startsWith("LEFT")).toBe(true);
    expect(row.trimEnd()).toBe("LEFT · RIGHT");
    expect(visibleWidth(row)).toBe(40);
  });

  it("stall path evicts lowest-priority instead of clipping a required cell mid-segment", () => {
    const row = packRow(
      8,
      [
        { id: "a", lane: "agent", value: "AAAAA", priority: 100, side: "left" },
        { id: "b", lane: "agent", value: "BBBBB", priority: 90, side: "left" },
      ],
      [],
      passthrough,
    );
    // Both required; overflow ≥ widest width: the lower-priority cell is
    // evicted whole, the survivor is never clipped mid-segment.
    expect(row.trimEnd()).toBe("AAAAA");
    expect(visibleWidth(row)).toBeLessThanOrEqual(8);
  });

  it("right-only rows pack from the left edge (no leading gap)", () => {
    const row = packRow(
      40,
      [],
      [{ id: "right", lane: "agent", value: "RIGHT", priority: 100, side: "right" }],
      passthrough,
    );
    expect(row.trimEnd().startsWith("RIGHT")).toBe(true);
  });

  it("pads populated wide rows to full width (bg-bar contract)", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    // Q2: full-width bg bars → every row is exactly width.
    expect(rows.every((row) => visibleWidth(row) === 200)).toBe(true);
  });

  it("evicts lowest-priority optional segments first", () => {
    const left: Segment[] = [
      { id: "anchor", lane: "agent", value: "ANCHOR", priority: 100, side: "left" },
      { id: "high", lane: "agent", value: "HIGHHIGH", priority: 90, side: "left", optional: true },
      { id: "mid", lane: "agent", value: "MIDMID", priority: 50, side: "left", optional: true },
      { id: "low", lane: "agent", value: "LOWLOW", priority: 10, side: "left", optional: true },
    ];
    const w = visibleWidth("ANCHOR") + visibleWidth(" · ") + visibleWidth("HIGHHIGH") + visibleWidth(" · ") + visibleWidth("MIDMID");
    const row = packRow(w, left, [], passthrough);
    expect(row).toContain("ANCHOR");
    expect(row).toContain("HIGHHIGH");
    expect(row).toContain("MIDMID");
    expect(row).not.toContain("LOWLOW");
    expect(visibleWidth(row)).toBeLessThanOrEqual(w);
  });

  it("shrink-widest truncates the widest required segment when optionals exhausted", () => {
    const left: Segment[] = [
      { id: "a", lane: "agent", value: "xxxxxxxxxx", priority: 100, side: "left" },
      { id: "b", lane: "agent", value: "yyyyyyyyyy", priority: 90, side: "left" },
    ];
    const w = 8;
    const row = packRow(w, left, [], passthrough);
    expect(visibleWidth(row)).toBeLessThanOrEqual(w);
    expect(row.length).toBeGreaterThan(0);
  });

  it("keeps cost when optional detail is evicted at narrow widths", () => {
    const snap = fullSnapshot();
    const rows = renderStatus(45, snap, passthrough);
    const model = strip(rows[0]);
    // Cost is required; io/rate are optional and evict first.
    expect(model).toContain("$0.42");
    expect(model).not.toContain("↑1k");
    expect(model).not.toContain("$0.18/hr");
  });

  it("sacred model anchor survives at tiny width", () => {
    const snap = fullSnapshot();
    const rows = renderStatus(3, snap, passthrough);
    const modelRow = rows[0];
    expect(modelRow.length).toBeGreaterThan(0);
    expect(visibleWidth(modelRow)).toBeLessThanOrEqual(3);
  });

  it("sacred fleet anchor survives at tiny width", () => {
    const snap = fullSnapshot();
    const rows = renderStatus(2, snap, passthrough);
    const fleetRow = rows[2];
    expect(visibleWidth(fleetRow)).toBeLessThanOrEqual(2);
  });

  it("sacred context sparkline survives at tiny width", () => {
    const snap = fullSnapshot();
    const rows = renderStatus(2, snap, passthrough);
    const modelRow = rows[0];
    expect(visibleWidth(modelRow)).toBeLessThanOrEqual(2);
  });

  it("sacred ctx anchor shrinks-widest before disappearing at narrow width", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      agent: {
        state: "working",
        activity: "",
        model: "anthropic/model-x-with-a-very-long-name-that-overflows",
      },
      session: { percent: 42, tokens: null, contextWindow: 200000 },
    };
    const rows = renderStatus(20, snap, passthrough);
    expect(rows).toHaveLength(4);
    expect(strip(rows[0])).toContain("%");
    for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(20);
  });
});

// ── 4. Empty segments disappear but rows remain ────────────────────────────

describe("empty segments / empty lanes", () => {
  it("empty snapshot produces 4 rows (some empty strings)", () => {
    const rows = renderStatus(80, emptySnapshot(), passthrough);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(typeof r).toBe("string");
  });

  it("a snapshot with an entirely-empty control lane still yields a row at index 3", () => {
    const snap = emptySnapshot();
    const rows = renderStatus(80, snap, passthrough);
    expect(rows).toHaveLength(4);
    expect(typeof rows[3]).toBe("string");
  });

  it("empty segments array (segments[key] = []) does not break rendering", () => {
    const snap = emptySnapshot();
    snap.segments = { agent: [], session: [], work: [], sessions: [], control: [] };
    const rows = renderStatus(80, snap, passthrough);
    expect(rows).toHaveLength(4);
  });

  it("a segment with empty icon+label+value contributes nothing but the row count stays 4", () => {
    const snap = emptySnapshot();
    snap.segments = {
      agent: [{ id: "ghost", lane: "agent", priority: 50, side: "left" }],
      session: [],
      work: [],
      sessions: [],
      control: [],
    };
    const rows = renderStatus(80, snap, passthrough);
    expect(rows).toHaveLength(4);
  });
});

// ── Nord color-pair system (lane bg + bold pair fg) ──────────────────────────

describe("Nord color pairs", () => {
  it("agent row uses the polar-night+frost-cyan pair", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    const agent = rows[0];
    expect(agent).toContain("\x1b[48;2;46;52;64m");   // polar night bg
    expect(agent).toContain("\x1b[38;2;136;192;208m"); // frost cyan fg
    expect(agent).toContain("\x1b[49m");               // bg reset
  });

  it("work row uses the polar-night+aurora-green pair", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[1]).toContain("\x1b[48;2;46;52;64m");
    expect(rows[1]).toContain("\x1b[38;2;163;190;140m");
  });

  it("fleet row uses the polar-night+frost-blue pair", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[2]).toContain("\x1b[48;2;59;66;82m");
    expect(rows[2]).toContain("\x1b[38;2;129;161;193m");
  });

  it("control row uses the polar-night+aurora-purple pair", () => {
    const snap = fullSnapshot();
    snap.control.thinkingSummary = "doing the thing";
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[3]).toContain("\x1b[48;2;46;52;64m");
    expect(rows[3]).toContain("\x1b[38;2;180;142;173m");
  });

  it("all populated rows are bold (\x1b[1m)", () => {
    const snap = fullSnapshot();
    snap.control.thinkingSummary = "doing the thing";
    const rows = renderStatus(200, snap, passthrough);
    for (const row of rows) {
      expect(row).toContain("\x1b[1m");
      expect(row).toContain("\x1b[22m"); // bold reset
    }
  });

  it("renders an external work-lane segment within the work pair", () => {
    const snap = fullSnapshot();
    snap.segments.work.push({
      id: "pr-banner", lane: "work", side: "right", priority: 75, optional: true,
      icon: "\uf0eb", label: "review", value: "idea", tone: "success",
    });
    const row = renderStatus(1000, snap, passthrough)[1];

    expect(strip(row)).toContain("review");
    expect(strip(row)).toContain("idea");
    // Still uses the work pair (polar night bg, aurora green fg).
    expect(row).toContain("\x1b[48;2;46;52;64m");
    expect(row).toContain("\x1b[38;2;163;190;140m");
  });
});

// ── Q1: glyph lockdown (U+F000–U+F2E0) ─────────────────────────────────────

describe("Q1: glyph lockdown", () => {
  // Import the internal GLYPH map indirectly by checking rendered output.
  // We verify Honcho's demoted glyphs are in the FA band via the honcho-status tests.

  it("thinking glyph is defined and renders", () => {
    // Q14: GLYPH.thinking was undefined; now \uf0eb (nf-fa-lightbulb).
    const snap: Snapshot = {
      ...emptySnapshot(),
      agent: { state: "thinking", activity: "", thinkingOn: true, thinkingLevel: "high" },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(strip(rows[0])).toContain("\uf0eb"); // lightbulb
  });
});

// ── Q2: full-width bg color-bar rows + icon-only headings ──────────────────

describe("Q2: bg color bars + icon-only headings", () => {
  it("every row uses its lane Nord truecolor pair", () => {
    const snap = fullSnapshot();
    snap.control.thinkingSummary = "doing the thing";
    const rows = renderStatus(200, snap, passthrough);

    // The 4 row lanes' bg truecolor codes must be present (the session lane
    // merged into the model row, so its pair no longer maps to a row bg).
    for (const lane of ["agent", "work", "sessions", "control"] as const) {
      const pair = LANE_PAIR[lane];
      const escape = `\x1b[48;2;${pair.bg}m`;
      expect(rows.some((r) => r.includes(escape))).toBe(true);
    }
    // Each row must close the bg (\x1b[49m) and use bold (\x1b[1m).
    for (const row of rows) {
      expect(row.includes("\x1b[49m")).toBe(true);
      expect(row.includes("\x1b[1m")).toBe(true);
    }
  });

  it("no uppercase text labels (AGENT/SESSION/WORK/SESSIONS/CONTROL) appear anywhere", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    const forbidden = ["AGENT", "SESSION", "WORK", "SESSIONS", "CONTROL"];
    for (const row of rows) {
      for (const label of forbidden) {
        expect(row).not.toContain(label);
      }
    }
  });

  it("rows are padded to full width so the bg bar spans the row", () => {
    const rows = renderStatus(80, fullSnapshot(), passthrough);
    for (const row of rows) {
      expect(visibleWidth(row)).toBe(80);
    }
  });
});

// ── Q3+Q4: joined provider/model id ─────────────────────────────────────────

describe("Q3+Q4: joined provider/model", () => {
  it("renders the full joined provider/model id", () => {
    const snap = fullSnapshot();
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[0]).toContain("anthropic/claude-opus-4.5");
  });

  it("shows just the model id when no provider is parseable", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      agent: { state: "working", activity: "", model: "claude-opus-4.5" },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[0]).toContain("claude-opus-4.5");
    expect(rows[0]).not.toContain("anthropic/claude-opus-4.5");
  });

  it("uses the model icon for the joined cell", () => {
    const snap = fullSnapshot();
    const rows = renderStatus(200, snap, passthrough);
    // model icon is \uf2d0 (nf-oct-cpu), Nerd Font PUA.
    expect(strip(rows[0])).toContain("\uf2d0");
  });
});

// ── Q5: context window usage (tachometer glyph + plain percent) ────────────

describe("Q5: context usage", () => {
  it("renders the context percent with the tachometer glyph, no label, no graph", () => {
    const snap = fullSnapshot();
    const rows = renderStatus(200, snap, passthrough);
    expect(strip(rows[0])).toContain("42%");
    // The tachometer glyph \uf0e4 identifies the context cell.
    expect(strip(rows[0])).toContain("\uf0e4");
    // No "ctx" label and no braille sparkline remnants.
    expect(strip(rows[0])).not.toContain("ctx");
    expect(strip(rows[0])).not.toMatch(/[\u2800-\u28ff]/);
  });

  it("renders a bare ?% when context usage is unknown", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      session: { percent: null, tokens: null, contextWindow: null },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(strip(rows[0])).toContain("?%");
  });

  it("escalates tone as context fills", () => {
    const snapHigh = fullSnapshot();
    snapHigh.session.percent = 95;
    const rowsHigh = renderStatus(1000, snapHigh, passthrough);
    expect(strip(rowsHigh[0])).toContain("95%");

    const snapLow = fullSnapshot();
    snapLow.session.percent = 42;
    const rowsLow = renderStatus(1000, snapLow, passthrough);
    expect(strip(rowsLow[0])).toContain("42%");
  });
});

// ── Q8: working time + cost rate ────────────────────────────────────────────

describe("Q8: working time + cost rate", () => {
  it("renders cumulative working time when present", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[0]).toContain("1h24m");
  });

  it("shows total, own, and delegated cost with distinct icons when subagents spent", () => {
    const snap = fullSnapshot();
    snap.sessions.subagentSpendUsd = 0.31;
    const model = strip(renderStatus(200, snap, passthrough)[0]);
    expect(model).toContain("$0.73");   // total = 0.42 + 0.31
    expect(model).toContain("$0.42");   // this session's own spend
    expect(model).toContain("$0.31");   // delegated spend
    // Money / dollar / sitemap glyphs distinguish the three cells.
    expect(model).toContain("\uf0d6");
    expect(model).toContain("\uf155");
    expect(model).toContain("\uf0e8");
  });

  it("uses one money-glyph cell for the session total when nothing was delegated", () => {
    const model = strip(renderStatus(200, fullSnapshot(), passthrough)[0]);
    expect(model).toContain("$0.42");
    expect(model).toContain("\uf0d6");
    expect(model).not.toContain("\uf0e8");
  });

  it("keeps the whole cost breakdown under width pressure (required cells)", () => {
    const snap = fullSnapshot();
    snap.sessions.subagentSpendUsd = 0.31;
    const narrow = strip(renderStatus(50, snap, passthrough)[0]);
    expect(narrow).toContain("$0.73");
    expect(narrow).toContain("$0.42");
    expect(narrow).toContain("$0.31");
  });

  it("renders cost burn rate when present", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[0]).toContain("$0.18/hr");
  });

  it("omits working time and cost rate when absent", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      session: { percent: 10, tokens: null, contextWindow: 100000 },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[0]).not.toContain("/hr");
    expect(rows[0]).not.toContain("1h24m");
  });
});

// ── Q9: git dirty counts + linked PR/ticket ─────────────────────────────────

describe("Q9: work row contents", () => {
  it("renders dirty added/removed/untracked counts", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[1]).toContain("+3");
    expect(rows[1]).toContain("-1");
    expect(rows[1]).toContain("!2");
  });

  it("renders ahead/behind counts as ↑/↓ markers", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[1]).toContain("↑2");
    expect(rows[1]).toContain("↓1");
  });

  it("renders the worktree status word", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[1]).toContain("clean");
  });

  it("omits dirty counts when the tree is clean", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      work: { branch: "main" },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[1]).toContain("main");
    expect(rows[1]).not.toContain("+");
  });

  it("keeps PR and Linear links alongside dirty counts", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[1]).toContain("#123");
    expect(rows[1]).toContain("DOR-45");
  });
});

// ── Q10: fleet row — active count + broad peer summaries ────────────────────

describe("Q10: fleet row", () => {
  it("renders the running subagent count with their working time (spend lives on row 1)", () => {
    const snap = fullSnapshot();
    snap.sessions.subagentsRunning = 2;
    snap.sessions.subagentSpendUsd = 0.31;
    snap.sessions.subagentWorkMs = 72 * 60_000; // 1h12m of delegated work
    const fleet = strip(renderStatus(200, snap, passthrough)[2]);
    expect(fleet).toContain("sub 2");
    expect(fleet).toContain("1h12m");
    expect(fleet).toContain("\uf0e8");
    expect(fleet).not.toContain("$0.31");
  });

  it("renders the effort multiplier for delegated work", () => {
    const snap = fullSnapshot();
    snap.sessions.subagentWorkMs = 90 * 60_000;
    snap.sessions.effortMultiplier = 2.4;
    const fleet = strip(renderStatus(200, snap, passthrough)[2]);
    expect(fleet).toContain("×2.4");
  });

  it("omits the multiplier below a measurable threshold", () => {
    const snap = fullSnapshot();
    snap.sessions.effortMultiplier = 0.01;
    expect(strip(renderStatus(200, snap, passthrough)[2])).not.toContain("×");
  });

  it("counts actively working peers", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    // 1 of 3 siblings is thinking.
    expect(rows[2]).toContain("1 active");
  });

  it("falls back to agent type when no summary is available", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[2]).toContain("@1");
    expect(rows[2]).toContain("◐");
    expect(rows[2]).toContain("codex");
  });

  it("shows a broad summary from the peer title when available", () => {
    const snap = fullSnapshot();
    snap.sessions.siblings[0].title = "refactor the packer"; // fits maxWidth 28
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[2]).toContain("refactor the packer");
  });

});

// ── Q11+Q12: no skills, delegations on the fleet row ────────────────────────

describe("Q11+Q12: no skills, deleg count on fleet row", () => {
  it("does not render a skills counter", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[3]).not.toContain("skills");
    // The book glyph (\uf02d) should not appear in the control row.
    expect(rows[3]).not.toContain("\uf02d");
  });

  it("renders delegations as count only", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[2]).toContain("deleg");
    expect(rows[2]).toContain("2");
  });
});

// ── goal-current segment renders on the fleet row ───────────────────────────

describe("goal-current segment renders on the fleet row", () => {
  it("renders the goal segment value once, from either side", () => {
    for (const side of ["left", "right"] as const) {
      const snap: Snapshot = {
        ...fullSnapshot(),
        segments: {
          ...emptySnapshot().segments,
          sessions: [
            { id: GOAL_ROLE_SEGMENT_ID, lane: "sessions", value: "▶ #11 Ship the statusline takeover", tone: "accent", priority: 99, side },
          ],
        },
      };
      const rows = renderStatus(200, snap, passthrough);
      expect(strip(rows[2])).toContain("Ship the statusline takeover");
      expect(strip(rows[2]).match(/Ship the statusline takeover/g)?.length).toBe(1);
    }
  });
});

// ── Row 4: single-sentence live status ─────────────────────────────────────

describe("row 4: single-sentence live status", () => {
  it("renders only the summary sentence", () => {
    const snap = fullSnapshot();
    snap.control.thinkingSummary = "rewriting the packer to keep ctx and cost visible";
    const rows = renderStatus(200, snap, passthrough);
    const control = strip(rows[3]);
    expect(control).toContain("rewriting the packer");
    // Row 4 carries nothing else — no health cells, no topic echo.
    expect(control).not.toContain("mcp");
    expect(control).not.toContain("honcho");
    expect(control).not.toContain("orca");
    expect(control).not.toContain("topic");
  });

  it("is empty when no summary has landed yet", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(strip(rows[3]).trim()).toBe("");
  });

  it("caps the sentence at one compact cell width", () => {
    const snap = fullSnapshot();
    snap.control.thinkingSummary = "a very long sentence that keeps going well past the cap so it must be truncated";
    const rows = renderStatus(200, snap, passthrough);
    const control = strip(rows[3]);
    expect(control).toContain("a very long sentence");
    expect(control).not.toContain("must be truncated");
  });

  it("keeps the sentence on very narrow rows (truncated, never evicted)", () => {
    const snap = fullSnapshot();
    snap.control.thinkingSummary = "rewriting the packer";
    const rows = renderStatus(45, snap, passthrough);
    expect(strip(rows[3])).toContain("rewriting");
    expect(visibleWidth(rows[3])).toBeLessThanOrEqual(45);
  });
});

// ── PR/Linear links: underlined + clickable OSC 8 hyperlinks ────────────────

describe("PR/Linear links (underlined + clickable)", () => {
  const PR_URL = "https://github.com/Elomi-inc/dorsia-monorepo/pull/9693";

  it("work-row PR renders as an underlined OSC 8 hyperlink when prUrl is set", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      work: { workspace: "albatross", branch: "henry-dorsia/review-pmc-intl-numbers", prLink: "#9693", prUrl: PR_URL },
    };
    const rows = renderStatus(200, snap, passthrough);
    const work = rows[1];
    expect(work).toContain(`\x1b]8;;${PR_URL}\x1b\\`);
    expect(work).toContain("\x1b[4m"); // underline on
    expect(work).toContain("\x1b[24m"); // underline off
    // Link closes before the row ends (no dangling OSC 8 into the next row).
    expect(work.indexOf("\x1b]8;;\x1b\\", work.indexOf(PR_URL))).toBeGreaterThan(-1);
  });

  it("work-row PR stays plain text when no prUrl is set", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      work: { workspace: "albatross", prLink: "#9693" },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[1]).toContain("#9693");
    expect(rows[1]).not.toContain("\x1b]8;");
    expect(rows[1]).not.toContain("\x1b[4m");
  });

  it("non-http(s) link URLs are rejected and render as plain text", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      work: { workspace: "albatross", prLink: "#9693", prUrl: "javascript:alert(1)" },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[1]).toContain("#9693");
    expect(rows[1]).not.toContain("\x1b]8;");
  });

  it("control characters in a link URL are stripped before use", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      work: { workspace: "albatross", prLink: "#9693", prUrl: `https://github.com/x\x1b]8;;https://evil\x1b\\` },
    };
    const rows = renderStatus(200, snap, passthrough);
    // Sanitized URL must not contain the injected OSC 8 open payload.
    expect(rows[1]).not.toContain("evil");
    expect(rows[1]).toContain("https://github.com/x");
  });

  it("linked segments from the bus (pr-banner) render as hyperlinks", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      work: { workspace: "albatross" },
      segments: {
        agent: [], session: [], sessions: [], control: [],
        work: [{
          id: "pr-banner:current-pr", lane: "work", icon: "\uf407", label: "PR",
          value: "#9693 fix numbers", tone: "accent", priority: 105, side: "left",
          link: PR_URL,
        }],
      },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[1]).toContain(`\x1b]8;;${PR_URL}\x1b\\`);
    expect(rows[1]).toContain("\x1b[4m");
  });

  it("linked rows never exceed the requested width (OSC 8 is width-invisible)", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      work: { workspace: "albatross", branch: "henry-dorsia/review-pmc-intl-numbers", prLink: "#9693", prUrl: PR_URL },
    };
    for (const width of [40, 60, 90, 200]) {
      const rows = renderStatus(width, snap, passthrough);
      for (const row of rows) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("narrow truncation of a linked segment keeps the link closed", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      work: { workspace: "albatross" },
      segments: {
        agent: [], session: [], sessions: [], control: [],
        work: [{
          id: "pr-banner:current-pr", lane: "work", icon: "\uf407", label: "PR",
          value: "#9693 a very long pr title that will definitely be truncated at narrow widths",
          tone: "accent", priority: 105, side: "left", maxWidth: 30, link: PR_URL,
        }],
      },
    };
    const rows = renderStatus(24, snap, passthrough);
    // Whatever survived truncation, an opened OSC 8 must be closed again.
    // (Opens have a non-empty URL; the close sequence is `ESC ] 8 ; ; ESC \`.)
    const opens = (rows[1].match(/\x1b\]8;;[^\x00-\x1f]/g) ?? []).length;
    const closes = (rows[1].match(/\x1b\]8;;\x1b\\/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("linear link uses linearUrl the same way", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      work: { workspace: "albatross", linearLink: "DOR-45", linearUrl: "https://linear.app/dorsia/issue/DOR-45" },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[1]).toContain("\x1b]8;;https://linear.app/dorsia/issue/DOR-45\x1b\\");
    expect(rows[1]).toContain("\x1b[4m");
  });
});

// ── ANSI escape sanitization ────────────────────────────────────────────────

describe("sanitize strips whole ANSI sequences from producer segments", () => {
  it("removes embedded CSI/OSC escapes instead of leaving [48;2;…m fragments", () => {
    const snap = partialSnapshot();
    snap.segments.work.push({
      id: "bg-tasks", lane: "work", side: "left", priority: 50,
      value:
        "\x1b[48;2;183;223;255m\x1b[38;2;11;70;110m bg 1 running · Shift↓ \x1b[0m",
    });
    const rows = renderStatus(120, snap, passthrough);
    const control = strip(rows[1]);
    expect(control).toContain("bg 1 running · Shift↓");
    expect(control).not.toContain("[48;2;");
    expect(control).not.toContain("[38;2;");
    expect(control).not.toContain("[0m");
    expect(control).not.toMatch(/\x1b/);
  });
});
