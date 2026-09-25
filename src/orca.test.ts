/**
 * dorsia-status — orca.ts normalization tests.
 *
 * Invariants under test (from the plan §6 acceptance criteria):
 *   5. normalizeSessions: current-only, siblings-present (alias + ordering),
 *      multi-pane tab (highest-priority pane wins), malformed inputs (no throw),
 *      sibling cap (4 shown, hiddenCount correct).
 *   6. orcaEnv: active when ORCA_PANE_KEY set, inert when absent.
 *
 * These are pure-function tests: normalizeSessions/orcaEnv take plain data and
 * a caller-supplied assignAlias — no pi runtime, no exec.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeSessions,
  orcaEnv,
  prFromRaw,
  linearFromRaw,
  type OrcaEnv,
  type RawTerminal,
  type RawAgent,
} from "./orca.ts";

// Simple stable alias assigner mirroring the real poller's @1/@2/... scheme.
function makeAlias(): (tabId: string) => string {
  const map = new Map<string, string>();
  let n = 0;
  return (tabId: string) => {
    let a = map.get(tabId);
    if (!a) {
      a = `@${++n}`;
      map.set(tabId, a);
    }
    return a;
  };
}

const ME_ENV: OrcaEnv = { paneKey: "p-me", tabId: "t-me", worktreeId: "w-me", active: true };

// ── orcaEnv ─────────────────────────────────────────────────────────────────

describe("orcaEnv", () => {
  it("is active when ORCA_PANE_KEY is a non-empty string", () => {
    const env = orcaEnv({ ORCA_PANE_KEY: "pk-1", ORCA_TAB_ID: "t1", ORCA_WORKTREE_ID: "w1" });
    expect(env.active).toBe(true);
    expect(env.paneKey).toBe("pk-1");
    expect(env.tabId).toBe("t1");
    expect(env.worktreeId).toBe("w1");
  });

  it("is inert when ORCA_PANE_KEY is absent", () => {
    const env = orcaEnv({ ORCA_TAB_ID: "t1" });
    expect(env.active).toBe(false);
    expect(env.paneKey).toBeUndefined();
  });

  it("is inert when ORCA_PANE_KEY is an empty string", () => {
    const env = orcaEnv({ ORCA_PANE_KEY: "" });
    expect(env.active).toBe(false);
  });

  it("defaults to process.env when no argument given", () => {
    const env = orcaEnv();
    expect(typeof env.active).toBe("boolean");
  });
});

// ── normalizeSessions: current-only ─────────────────────────────────────────

describe("normalizeSessions: current-only (just [me])", () => {
  it("returns [me] with no siblings and hiddenCount 0", () => {
    const lane = normalizeSessions([], [], ME_ENV, makeAlias());
    expect(lane.siblings).toEqual([]);
    expect(lane.hiddenCount).toBe(0);
    expect(lane.me).toMatchObject({ isMe: true, paneKey: "p-me", tabId: "t-me" });
  });

  it("does not throw with zero terminals and zero agents", () => {
    expect(() => normalizeSessions([], [], ME_ENV, makeAlias())).not.toThrow();
  });
});

// ── normalizeSessions: siblings present ─────────────────────────────────────

describe("normalizeSessions: siblings present", () => {
  const terminals: RawTerminal[] = [
    { paneKey: "p-me", tabId: "t-me" },
    { paneKey: "p-a", tabId: "t-a", title: "tab A", lastActivityAt: 100 },
    { paneKey: "p-b", tabId: "t-b", title: "tab B", lastActivityAt: 200 },
    { paneKey: "p-c", tabId: "t-c", title: "tab C", lastActivityAt: 50 },
  ];
  const agents: RawAgent[] = [
    { paneKey: "p-a", state: "working", agentType: "codex" },
    { paneKey: "p-b", state: "idle", agentType: "pi" },
    { paneKey: "p-c", state: "done", agentType: "claude" },
  ];

  it("excludes the me-tab from siblings and marks it isMe", () => {
    const lane = normalizeSessions(terminals, agents, ME_ENV, makeAlias());
    expect(lane.siblings).toHaveLength(3);
    expect(lane.siblings.every((s) => s.isMe === false)).toBe(true);
    expect(lane.me!.isMe).toBe(true);
    expect(lane.me!.alias).toBe("me");
  });

  it("assigns stable aliases via assignAlias", () => {
    const alias = makeAlias();
    const lane = normalizeSessions(terminals, agents, ME_ENV, alias);
    // Every sibling has a non-empty alias.
    for (const s of lane.siblings) expect(typeof s.alias).toBe("string"), expect(s.alias!.length).toBeGreaterThan(0);
    // Aliases are unique.
    const aliases = lane.siblings.map((s) => s.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("orders siblings attention → working → idle → done (state priority ascending)", () => {
    const lane = normalizeSessions(terminals, agents, ME_ENV, makeAlias());
    const states = lane.siblings.map((s) => s.state);
    // working(2) before idle(4) before done(5)
    expect(states).toEqual(["working", "idle", "done"]);
  });

  it("breaks ties by recency descending within the same state priority", () => {
    // Two idle siblings with different recency.
    const terms: RawTerminal[] = [
      { paneKey: "p-me", tabId: "t-me" },
      { paneKey: "p-old", tabId: "t-old", lastActivityAt: 10 },
      { paneKey: "p-new", tabId: "t-new", lastActivityAt: 999 },
    ];
    const ags: RawAgent[] = [
      { paneKey: "p-old", state: "idle" },
      { paneKey: "p-new", state: "idle" },
    ];
    const lane = normalizeSessions(terms, ags, ME_ENV, makeAlias());
    expect(lane.siblings).toHaveLength(2);
    expect(lane.siblings[0].state).toBe("idle");
    expect(lane.siblings[1].state).toBe("idle");
    // More recent first.
    expect(lane.siblings[0].recency ?? 0).toBeGreaterThanOrEqual(lane.siblings[1].recency ?? 0);
    expect(lane.siblings[0].paneKey).toBe("p-new");
  });

  it("joins agent fields onto the sibling by paneKey", () => {
    const lane = normalizeSessions(terminals, agents, ME_ENV, makeAlias());
    const working = lane.siblings.find((s) => s.state === "working");
    expect(working?.agentType).toBe("codex");
  });
});

// ── normalizeSessions: multi-pane tab ──────────────────────────────────────

describe("normalizeSessions: multi-pane tab (highest-priority pane wins)", () => {
  it("collapses two panes in one tab to a single sibling using the most-urgent state", () => {
    const terminals: RawTerminal[] = [
      { paneKey: "p-me", tabId: "t-me" },
      { paneKey: "p-1", tabId: "t-sib", lastActivityAt: 10 },
      { paneKey: "p-2", tabId: "t-sib", lastActivityAt: 20 },
    ];
    const agents: RawAgent[] = [
      { paneKey: "p-1", state: "idle", agentType: "pi" },
      { paneKey: "p-2", state: "working", agentType: "codex" },
    ];
    const lane = normalizeSessions(terminals, agents, ME_ENV, makeAlias());
    // One tab → one sibling cell.
    expect(lane.siblings).toHaveLength(1);
    const sib = lane.siblings[0];
    // working (priority 2) beats idle (priority 4): most-urgent pane wins.
    expect(sib.state).toBe("working");
    expect(sib.agentType).toBe("codex");
    expect(sib.tabId).toBe("t-sib");
  });

  it("error state beats working state across panes in the same tab", () => {
    const terminals: RawTerminal[] = [
      { paneKey: "p-me", tabId: "t-me" },
      { paneKey: "p-ok", tabId: "t-sib" },
      { paneKey: "p-err", tabId: "t-sib" },
    ];
    const agents: RawAgent[] = [
      { paneKey: "p-ok", state: "working" },
      { paneKey: "p-err", state: "error" },
    ];
    const lane = normalizeSessions(terminals, agents, ME_ENV, makeAlias());
    expect(lane.siblings).toHaveLength(1);
    expect(lane.siblings[0].state).toBe("error");
  });
});

// ── normalizeSessions: malformed / partial inputs ───────────────────────────

describe("normalizeSessions: malformed / partial inputs (must not throw)", () => {
  it("handles terminals with missing tabId and paneKey", () => {
    const terminals: RawTerminal[] = [
      {} as RawTerminal, // no tabId, no paneKey → skipped
      { paneKey: "p-x" } as RawTerminal, // no tabId → falls back to paneKey
      { tabId: "t-y" } as RawTerminal, // no paneKey → still a tab cell
    ];
    expect(() => normalizeSessions(terminals, [], ME_ENV, makeAlias())).not.toThrow();
    const lane = normalizeSessions(terminals, [], ME_ENV, makeAlias());
    // The {} entry is skipped; the other two become siblings.
    expect(lane.siblings.length).toBe(2);
    for (const s of lane.siblings) expect(s.state).toBe("idle"); // no agent → default idle
  });

  it("handles agents with undefined paneKey (skipped, not thrown)", () => {
    const agents: RawAgent[] = [
      {} as RawAgent, // no paneKey
      { state: "working" } as RawAgent, // no paneKey
      { paneKey: "p-real", state: "working", agentType: "pi" },
    ];
    const terminals: RawTerminal[] = [
      { paneKey: "p-me", tabId: "t-me" },
      { paneKey: "p-real", tabId: "t-real" },
    ];
    expect(() => normalizeSessions(terminals, agents, ME_ENV, makeAlias())).not.toThrow();
    const lane = normalizeSessions(terminals, agents, ME_ENV, makeAlias());
    expect(lane.siblings).toHaveLength(1);
    expect(lane.siblings[0].state).toBe("working");
  });

  it("handles empty arrays without throwing", () => {
    expect(() => normalizeSessions([], [], ME_ENV, makeAlias())).not.toThrow();
  });

  it("handles an inert env (no paneKey/tabId match) by treating all tabs as siblings", () => {
    const env: OrcaEnv = { active: true, paneKey: undefined, tabId: undefined };
    const terminals: RawTerminal[] = [
      { paneKey: "p-a", tabId: "t-a" },
      { paneKey: "p-b", tabId: "t-b" },
    ];
    const lane = normalizeSessions(terminals, [], env, makeAlias());
    expect(lane.siblings).toHaveLength(2);
    expect(lane.me!.isMe).toBe(true);
  });
});

// ── normalizeSessions: sibling cap ──────────────────────────────────────────

describe("normalizeSessions: sibling cap (4 shown, rest hidden)", () => {
  it("caps shown siblings at 4 and sets hiddenCount to the remainder", () => {
    const terminals: RawTerminal[] = [
      { paneKey: "p-me", tabId: "t-me" },
      ...Array.from({ length: 6 }, (_, i) => ({
        paneKey: `p-${i}`,
        tabId: `t-${i}`,
        lastActivityAt: 100 - i,
      })),
    ];
    const agents: RawAgent[] = Array.from({ length: 6 }, (_, i) => ({
      paneKey: `p-${i}`,
      state: "idle",
      agentType: "pi",
    }));
    const lane = normalizeSessions(terminals, agents, ME_ENV, makeAlias());
    expect(lane.siblings).toHaveLength(4);
    expect(lane.hiddenCount).toBe(2);
  });

  it("hiddenCount is 0 when siblings ≤ 4", () => {
    const terminals: RawTerminal[] = [
      { paneKey: "p-me", tabId: "t-me" },
      { paneKey: "p-a", tabId: "t-a" },
      { paneKey: "p-b", tabId: "t-b" },
    ];
    const lane = normalizeSessions(terminals, [], ME_ENV, makeAlias());
    expect(lane.siblings).toHaveLength(2);
    expect(lane.hiddenCount).toBe(0);
  });

  it("caps at exactly 4 with hiddenCount reflecting the overflow when there are 10 siblings", () => {
    const terminals: RawTerminal[] = [
      { paneKey: "p-me", tabId: "t-me" },
      ...Array.from({ length: 10 }, (_, i) => ({
        paneKey: `p-${i}`,
        tabId: `t-${i}`,
        lastActivityAt: 1000 - i,
      })),
    ];
    const lane = normalizeSessions(terminals, [], ME_ENV, makeAlias());
    expect(lane.siblings).toHaveLength(4);
    expect(lane.hiddenCount).toBe(6);
  });
});

// ── PR/Linear link derivation (linkedPR shape + legacy strings) ─────────────

describe("prFromRaw / linearFromRaw", () => {
  it("derives label + URL from linkedPR + projectId (current orca shape)", () => {
    const w = {
      linkedPR: { number: 9693, state: "open" },
      projectId: "github:elomi-inc/dorsia-monorepo",
    };
    expect(prFromRaw(w)).toEqual({
      label: "#9693",
      url: "https://github.com/elomi-inc/dorsia-monorepo/pull/9693",
    });
  });

  it("falls back to a cached projectId when the record lacks one (worktree ps entries)", () => {
    const w = { linkedPR: { number: 9693, state: "open" } };
    expect(prFromRaw(w, "github:Elomi-inc/dorsia-monorepo")).toEqual({
      label: "#9693",
      url: "https://github.com/Elomi-inc/dorsia-monorepo/pull/9693",
    });
    expect(prFromRaw(w).url).toBeUndefined();
    expect(prFromRaw(w).label).toBe("#9693");
  });

  it("null linkedPR yields nothing", () => {
    expect(prFromRaw({ linkedPR: null })).toEqual({});
    expect(prFromRaw({})).toEqual({});
  });

  it("legacy prLink/pr http URLs become label + url", () => {
    const w = { prLink: "https://github.com/Elomi-inc/dorsia-monorepo/pull/1234" };
    expect(prFromRaw(w)).toEqual({
      label: "#1234",
      url: "https://github.com/Elomi-inc/dorsia-monorepo/pull/1234",
    });
    expect(prFromRaw({ pr: "https://github.com/x/y/pull/7" })).toEqual({
      label: "#7",
      url: "https://github.com/x/y/pull/7",
    });
  });

  it("legacy plain-text pr stays a display label with no URL", () => {
    expect(prFromRaw({ prLink: "PR-42" })).toEqual({ label: "PR-42" });
  });

  it("malformed projectId does not produce a bogus URL", () => {
    const w = { linkedPR: { number: 5, state: "open" }, projectId: "not-a-github-id" };
    expect(prFromRaw(w)).toEqual({ label: "#5" });
  });

  it("linearFromRaw: http URL → url only; plain text → label only", () => {
    expect(linearFromRaw({ linearLink: "https://linear.app/dorsia/issue/DOR-45" })).toEqual({
      url: "https://linear.app/dorsia/issue/DOR-45",
    });
    expect(linearFromRaw({ linearIssue: "DOR-45" })).toEqual({ label: "DOR-45" });
    expect(linearFromRaw({})).toEqual({});
  });

  it("prFromRaw: linkedIssue (worktree set --issue) becomes an /issues URL, redirect-safe for PRs", () => {
    const w = { linkedIssue: 1 };
    expect(prFromRaw(w, "github:elomi-inc/pi-dorsia-status")).toEqual({
      label: "#1",
      url: "https://github.com/elomi-inc/pi-dorsia-status/issues/1",
    });
    // linkedPR wins when both are present.
    expect(prFromRaw({ linkedIssue: 1, linkedPR: { number: 2, state: "open" } }, "github:o/r")).toEqual({
      label: "#2",
      url: "https://github.com/o/r/pull/2",
    });
  });

  it("linearFromRaw: linkedLinearIssue becomes label + linear.app URL via the org fallback", () => {
    expect(linearFromRaw({ linkedLinearIssue: "ENG-3250" }, "dorsia")).toEqual({
      label: "ENG-3250",
      url: "https://linear.app/dorsia/issue/ENG-3250",
    });
    // An explicit organizationUrlKey on the record beats the fallback.
    expect(linearFromRaw({ linkedLinearIssue: "ENG-3250", linkedLinearIssueOrganizationUrlKey: "acme" })).toEqual({
      label: "ENG-3250",
      url: "https://linear.app/acme/issue/ENG-3250",
    });
    // No fallback and no record key → label only.
    expect(linearFromRaw({ linkedLinearIssue: "ENG-3250" })).toEqual({ label: "ENG-3250" });
  });
});
