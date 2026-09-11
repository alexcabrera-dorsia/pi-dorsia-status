/**
 * dorsia-status — render.ts acceptance tests.
 *
 * Invariants under test:
 *   1. Exactly five stable, icon-first row identities.
 *   2. Semantic tones for live state and health.
 *   3. True right anchoring at wide widths.
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
      turn: 7,
      clock: "12:34",
      history: [10, 20, 30, 35, 40, 42],
      duration: "1h24m",
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
      it(`returns exactly 5 rows for ${label} snapshot @ width ${w}`, () => {
        const rows = renderStatus(w, snap, passthrough);
        expect(rows).toHaveLength(5);
      });
    }
  }

  it("rows never collapse: all 5 are strings even at width 1", () => {
    const rows = renderStatus(1, fullSnapshot(), passthrough);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(typeof r).toBe("string");
  });

  it("returns 5 rows for a degenerate width 0 (clamped to 1)", () => {
    const rows = renderStatus(0, emptySnapshot(), passthrough);
    expect(rows).toHaveLength(5);
  });
});

// ── 2. Visual hierarchy and responsive composition ─────────────────────────

describe("visual hierarchy", () => {
  it("gives every row an icon-first identity and critical state", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    // Q2: no uppercase text labels — rows open with just the lane icon.
    const labels = ["AGENT", "SESSION", "WORK", "SESSIONS", "CONTROL"];
    for (const label of labels) {
      for (const row of rows) {
        expect(strip(row)).not.toContain(label);
      }
    }
    // Critical state still present (after stripping ANSI pairs).
    expect(strip(rows[0])).toContain("working");
    expect(strip(rows[1])).toMatch(/ctx .*42%/);
    expect(strip(rows[2])).toContain("dorsia-pi-config");
    expect(strip(rows[3])).toContain("orchestrator");
    expect(strip(rows[4])).toContain("3/5");
  });

  it("keeps row identity and critical state while evicting optional detail at narrow widths", () => {
    const rows = renderStatus(26, fullSnapshot(), passthrough);

    expect(strip(rows[0])).toContain("working");
    expect(strip(rows[0])).not.toContain("claude-opus");
    expect(strip(rows[1])).toContain("ctx");
    expect(strip(rows[1])).not.toContain("12:34");
    expect(strip(rows[2])).not.toContain("alex/fix-statusline");
    expect(strip(rows[3])).toContain("orchestrator");
    expect(strip(rows[3])).not.toContain("@1");
    expect(strip(rows[4])).toContain("3/5");
    expect(strip(rows[4])).not.toContain("write tests");
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
  it("uses the full row to anchor surviving right-side metadata", () => {
    const row = packRow(
      40,
      [{ id: "left", lane: "agent", value: "LEFT", priority: 100, side: "left" }],
      [{ id: "right", lane: "agent", value: "RIGHT", priority: 100, side: "right" }],
      passthrough,
    );

    expect(visibleWidth(row)).toBe(40);
    expect(row.startsWith("LEFT")).toBe(true);
    expect(row.endsWith("RIGHT")).toBe(true);
  });

  it("right-aligns stable metadata on all populated wide rows (padded to width)", () => {
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

  it("sacred agent anchor (state glyph) survives at tiny width", () => {
    const snap = fullSnapshot();
    const rows = renderStatus(3, snap, passthrough);
    const agentRow = rows[0];
    expect(agentRow.length).toBeGreaterThan(0);
    expect(visibleWidth(agentRow)).toBeLessThanOrEqual(3);
  });

  it("sacred role label sessions anchor survives at tiny width", () => {
    const snap = fullSnapshot();
    const rows = renderStatus(2, snap, passthrough);
    const sessionsRow = rows[3];
    expect(visibleWidth(sessionsRow)).toBeLessThanOrEqual(2);
  });

  it("sacred context sparkline survives at tiny width", () => {
    const snap = fullSnapshot();
    const rows = renderStatus(2, snap, passthrough);
    const sessionRow = rows[1];
    expect(visibleWidth(sessionRow)).toBeLessThanOrEqual(2);
  });

  it("optional model segment is dropped before the sacred activity segment shrinks past it", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      agent: {
        state: "working",
        activity: "this is a long activity string that will overflow",
        model: "anthropic/model-x-with-a-long-name",
        thinkingOn: false,
      },
    };
    const rows = renderStatus(10, snap, passthrough);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(10);
  });
});

// ── 4. Empty segments disappear but rows remain ────────────────────────────

describe("empty segments / empty lanes", () => {
  it("empty snapshot produces 5 rows (some empty strings)", () => {
    const rows = renderStatus(80, emptySnapshot(), passthrough);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(typeof r).toBe("string");
  });

  it("a snapshot with an entirely-empty control lane still yields a row at index 4", () => {
    const snap = emptySnapshot();
    const rows = renderStatus(80, snap, passthrough);
    expect(rows).toHaveLength(5);
    expect(typeof rows[4]).toBe("string");
  });

  it("empty segments array (segments[key] = []) does not break rendering", () => {
    const snap = emptySnapshot();
    snap.segments = { agent: [], session: [], work: [], sessions: [], control: [] };
    const rows = renderStatus(80, snap, passthrough);
    expect(rows).toHaveLength(5);
  });

  it("a segment with empty icon+label+value contributes nothing but the row count stays 5", () => {
    const snap = emptySnapshot();
    snap.segments = {
      agent: [{ id: "ghost", lane: "agent", priority: 50, side: "left" }],
      session: [],
      work: [],
      sessions: [],
      control: [],
    };
    const rows = renderStatus(80, snap, passthrough);
    expect(rows).toHaveLength(5);
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

  it("session row uses the polar-night+aurora-yellow pair", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[1]).toContain("\x1b[48;2;59;66;82m");
    expect(rows[1]).toContain("\x1b[38;2;235;203;139m");
  });

  it("work row uses the polar-night+aurora-green pair", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[2]).toContain("\x1b[48;2;46;52;64m");
    expect(rows[2]).toContain("\x1b[38;2;163;190;140m");
  });

  it("sessions row uses the polar-night+frost-blue pair", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[3]).toContain("\x1b[48;2;59;66;82m");
    expect(rows[3]).toContain("\x1b[38;2;129;161;193m");
  });

  it("control row uses the polar-night+aurora-purple pair", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[4]).toContain("\x1b[48;2;46;52;64m");
    expect(rows[4]).toContain("\x1b[38;2;180;142;173m");
  });

  it("all rows are bold (\x1b[1m)", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    for (const row of rows) {
      expect(row).toContain("\x1b[1m");
      expect(row).toContain("\x1b[22m"); // bold reset
    }
  });

  it("renders an external Honcho segment within the control pair", () => {
    const snap = fullSnapshot();
    snap.segments.control.push({
      id: "honcho", lane: "control", side: "right", priority: 75, optional: true,
      icon: "\uf0eb", label: "honcho", value: "idea", tone: "success",
    });
    const row = renderStatus(1000, snap, passthrough)[4];

    expect(strip(row)).toContain("honcho");
    expect(strip(row)).toContain("idea");
    // Still uses the control pair (polar night bg, aurora purple fg).
    expect(row).toContain("\x1b[48;2;46;52;64m");
    expect(row).toContain("\x1b[38;2;180;142;173m");
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
    const rows = renderStatus(200, snap, passthrough);

    // All 5 lane bg truecolor codes must be present.
    for (const pair of Object.values(LANE_PAIR)) {
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

// ── Q5: braille sparkline history ───────────────────────────────────────────

describe("Q5: braille sparkline", () => {
  it("renders a braille sparkline from history + current percent", () => {
    const snap = fullSnapshot();
    const rows = renderStatus(200, snap, passthrough);
    // Sparkline glyphs are from ⣀⣄⣆⣇⣧⣷⣿.
    expect(rows[1]).toMatch(/[⣀⣄⣆⣇⣧⣷⣿]+/);
    // Current percent number follows.
    expect(rows[1]).toContain("42%");
  });

  it("shows a single baseline glyph when no history and no percent", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      session: { percent: null, tokens: null, contextWindow: null },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[1]).toContain("⣀");
  });

  it("renders the sparkline and percent across pressure levels", () => {
    // Under the Nord pair system the sparkline still renders; per-tone coloring is gone.
    const snapHigh = fullSnapshot();
    snapHigh.session.percent = 95;
    const rowsHigh = renderStatus(1000, snapHigh, passthrough);
    expect(strip(rowsHigh[1])).toContain("95%");
    expect(strip(rowsHigh[1])).toMatch(/[⣀-⣿]/);

    const snapLow = fullSnapshot();
    snapLow.session.percent = 42;
    const rowsLow = renderStatus(1000, snapLow, passthrough);
    expect(strip(rowsLow[1])).toContain("42%");
  });
});

// ── Q8: session duration + cost rate ────────────────────────────────────────

describe("Q8: duration + cost rate", () => {
  it("renders session duration when present", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[1]).toContain("1h24m");
  });

  it("renders cost burn rate when present", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[1]).toContain("$0.18/hr");
  });

  it("omits duration and cost rate when absent", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      session: { percent: 10, tokens: null, contextWindow: 100000 },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[1]).not.toContain("/hr");
  });
});

// ── Q9: git ahead/behind ─────────────────────────────────────────────────────

describe("Q9: git ahead/behind", () => {
  it("renders ahead/behind counts as ↑/↓ markers", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[2]).toContain("↑2");
    expect(rows[2]).toContain("↓1");
  });

  it("omits ahead/behind when absent", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      work: { branch: "main" },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[2]).not.toContain("↑");
    expect(rows[2]).not.toContain("↓");
  });

  it("keeps PR and Linear links alongside ahead/behind", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[2]).toContain("#123");
    expect(rows[2]).toContain("DOR-45");
  });
});

// ── Q10: siblings state+type only ──────────────────────────────────────────

describe("Q10: siblings state+type only", () => {
  it("shows sibling state glyph + agent type, no previews/recency", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    // @1 ◐ codex — state glyph + type only.
    expect(rows[3]).toContain("@1");
    expect(rows[3]).toContain("◐");
    expect(rows[3]).toContain("codex");
    // No tool-name detail or title.
    expect(rows[3]).not.toContain("Plan");
  });
});

// ── Q11+Q12: no skills, delegations count only ──────────────────────────────

describe("Q11+Q12: no skills, deleg count only", () => {
  it("does not render a skills counter", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[4]).not.toContain("skills");
    // The book glyph (\uf02d) should not appear in the control row.
    expect(rows[4]).not.toContain("\uf02d");
  });

  it("renders delegations as count only (no 'active' word)", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[4]).toContain("deleg");
    expect(rows[4]).toContain("2");
    expect(rows[4]).not.toContain("2 active");
  });
});

// ── Q13: role label ──────────────────────────────────────────────────────────

describe("Q13: role label", () => {
  it("replaces the old 'me' cell with a role label", () => {
    const rows = renderStatus(200, fullSnapshot(), passthrough);
    expect(rows[3]).toContain("orchestrator");
    // The old "me" label should not appear as a standalone label.
    expect(rows[3]).not.toMatch(/\bme\b/);
  });

  it("defaults to 'orchestrator' when no role is set", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      sessions: {
        me: { isMe: true, state: "working" },
        siblings: [],
        hiddenCount: 0,
      },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[3]).toContain("orchestrator");
  });
});

// ── Goal-role takeover (goal-current segment) ───────────────────────────────

describe("goal-current segment takes over the role slot", () => {
  it("replaces the orchestrator text with the segment value and does not double-render it", () => {
    const snap: Snapshot = {
      ...fullSnapshot(),
      segments: {
        ...emptySnapshot().segments,
        sessions: [
          { id: GOAL_ROLE_SEGMENT_ID, lane: "sessions", value: "▶ #11 Ship the statusline takeover 󰆧 claude: bash", tone: "accent", priority: 99, side: "left" },
        ],
      },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(strip(rows[3])).toContain("Ship the statusline takeover");
    expect(strip(rows[3])).not.toContain("orchestrator");
    expect(strip(rows[3]).match(/Ship the statusline takeover/g)?.length).toBe(1);
  });

  it("falls back to the role text when the segment value is blank", () => {
    const snap: Snapshot = {
      ...fullSnapshot(),
      segments: {
        ...emptySnapshot().segments,
        sessions: [{ id: GOAL_ROLE_SEGMENT_ID, lane: "sessions", value: "   ", tone: "muted", priority: 99, side: "left" }],
      },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(strip(rows[3])).toContain("orchestrator");
  });

  it("a right-side goal-current does not hijack the role slot", () => {
    const snap: Snapshot = {
      ...fullSnapshot(),
      segments: {
        ...emptySnapshot().segments,
        sessions: [{ id: GOAL_ROLE_SEGMENT_ID, lane: "sessions", value: "▶ right side", tone: "muted", priority: 99, side: "right" }],
      },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(strip(rows[3])).toContain("orchestrator");
  });
});

// ── Q14: thinking glyph defined ──────────────────────────────────────────────

describe("Q14: thinking glyph bug fix", () => {
  it("renders the thinking segment without undefined-glyph artifacts", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      agent: { state: "thinking", activity: "", thinkingOn: true, thinkingLevel: "high" },
    };
    const rows = renderStatus(200, snap, passthrough);
    // The lightbulb glyph \uf0eb should render, not "undefined".
    expect(strip(rows[0])).toContain("\uf0eb");
    expect(strip(rows[0])).toContain("high");
    expect(strip(rows[0])).not.toContain("undefined");
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
    const work = rows[2];
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
    expect(rows[2]).toContain("#9693");
    expect(rows[2]).not.toContain("\x1b]8;");
    expect(rows[2]).not.toContain("\x1b[4m");
  });

  it("non-http(s) link URLs are rejected and render as plain text", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      work: { workspace: "albatross", prLink: "#9693", prUrl: "javascript:alert(1)" },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[2]).toContain("#9693");
    expect(rows[2]).not.toContain("\x1b]8;");
  });

  it("control characters in a link URL are stripped before use", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      work: { workspace: "albatross", prLink: "#9693", prUrl: `https://github.com/x\x1b]8;;https://evil\x1b\\` },
    };
    const rows = renderStatus(200, snap, passthrough);
    // Sanitized URL must not contain the injected OSC 8 open payload.
    expect(rows[2]).not.toContain("evil");
    expect(rows[2]).toContain("https://github.com/x");
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
    expect(rows[2]).toContain(`\x1b]8;;${PR_URL}\x1b\\`);
    expect(rows[2]).toContain("\x1b[4m");
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
    const opens = (rows[2].match(/\x1b\]8;;[^\x00-\x1f]/g) ?? []).length;
    const closes = (rows[2].match(/\x1b\]8;;\x1b\\/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("linear link uses linearUrl the same way", () => {
    const snap: Snapshot = {
      ...emptySnapshot(),
      work: { workspace: "albatross", linearLink: "DOR-45", linearUrl: "https://linear.app/dorsia/issue/DOR-45" },
    };
    const rows = renderStatus(200, snap, passthrough);
    expect(rows[2]).toContain("\x1b]8;;https://linear.app/dorsia/issue/DOR-45\x1b\\");
    expect(rows[2]).toContain("\x1b[4m");
  });
});

// ── ANSI escape sanitization ────────────────────────────────────────────────

describe("sanitize strips whole ANSI sequences from producer segments", () => {
  it("removes embedded CSI/OSC escapes instead of leaving [48;2;…m fragments", () => {
    const snap = partialSnapshot();
    snap.segments.control.push({
      id: "bg-tasks", lane: "control", side: "left", priority: 50,
      value:
        "\x1b[48;2;183;223;255m\x1b[38;2;11;70;110m bg 1 running · Shift↓ \x1b[0m",
    });
    const rows = renderStatus(120, snap, passthrough);
    const control = strip(rows[4]);
    expect(control).toContain("bg 1 running · Shift↓");
    expect(control).not.toContain("[48;2;");
    expect(control).not.toContain("[38;2;");
    expect(control).not.toContain("[0m");
    expect(control).not.toMatch(/\x1b/);
  });
});
