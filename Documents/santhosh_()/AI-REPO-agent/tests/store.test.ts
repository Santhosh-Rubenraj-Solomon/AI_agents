import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  createTask,
  deleteTask,
  forceUpdatePhase,
  getActiveTasks,
  getDb,
  getOldTerminalTaskIds,
  getResumableTasks,
  getStaleTasks,
  getTask,
  getTaskRaw,
  getTasksByPhase,
  markInFlightTasksFailed,
  updateTask,
} from "../src/state/store.js";
import { makeAnalysis, makeState } from "./helpers.js";

const MIN = 60_000;

beforeEach(() => closeDb());
afterEach(() => {
  closeDb();
  vi.useRealTimers();
});

function insertRaw(taskId: string, state: Record<string, unknown>, phase: string, updatedAt = Date.now()) {
  getDb()
    .prepare(
      "INSERT INTO tasks (task_id, state_json, phase, user_id, channel_id, thread_ts, worktree_path, created_at, updated_at) VALUES (?, ?, ?, 'U', 'C', '1.1', NULL, ?, ?)",
    )
    .run(taskId, JSON.stringify(state), phase, updatedAt, updatedAt);
}

describe("getDb / closeDb", () => {
  it("returns a singleton and runs migrations", () => {
    const db = getDb();
    expect(getDb()).toBe(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()).toBeTruthy();
  });

  it("closeDb drops the connection so the next getDb is fresh", () => {
    createTask(makeState());
    const first = getDb();
    closeDb();
    expect(getDb()).not.toBe(first);
    expect(getActiveTasks()).toEqual([]); // in-memory DB was discarded
  });

  it("creates the parent directory for a file-backed DB", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ecr-store-"));
    const dbPath = path.join(dir, "nested", "deeper", "test.db");
    const prev = process.env.DB_PATH;
    process.env.DB_PATH = dbPath;
    vi.resetModules();
    try {
      const fresh = await import("../src/state/store.js");
      fresh.getDb();
      expect(fs.existsSync(dbPath)).toBe(true);
      fresh.closeDb();
    } finally {
      process.env.DB_PATH = prev;
      vi.resetModules();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("task CRUD", () => {
  it("round-trips a task through create/get", () => {
    const s = makeState({ analysis: makeAnalysis(), branchName: "fix/x" });
    createTask(s);
    expect(getTask(s.taskId)).toEqual(s);
  });

  it("returns null for unknown ids", () => {
    expect(getTask("nope")).toBeNull();
    expect(getTaskRaw("nope")).toBeNull();
  });

  it("rejects duplicate task ids", () => {
    const s = makeState();
    createTask(s);
    expect(() => createTask(s)).toThrow();
  });

  it("updateTask persists changes and stamps updatedAt (mutating the input)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const s = makeState({ createdAt: 1, updatedAt: 1 });
    createTask(s);
    vi.setSystemTime(2_000_000);
    s.currentPhase = "executing";
    s.worktreePath = "/tmp/wt";
    updateTask(s);
    expect(s.updatedAt).toBe(2_000_000);
    const loaded = getTask(s.taskId)!;
    expect(loaded.currentPhase).toBe("executing");
    expect(loaded.worktreePath).toBe("/tmp/wt");
    expect(loaded.updatedAt).toBe(2_000_000);
    const row = getDb().prepare("SELECT phase, worktree_path, updated_at FROM tasks WHERE task_id = ?").get(s.taskId);
    expect(row).toEqual({ phase: "executing", worktree_path: "/tmp/wt", updated_at: 2_000_000 });
  });

  it("updateTask on a missing id is a silent no-op", () => {
    expect(() => updateTask(makeState())).not.toThrow();
  });

  it("deleteTask removes the row", () => {
    const s = makeState();
    createTask(s);
    deleteTask(s.taskId);
    expect(getTask(s.taskId)).toBeNull();
  });

  it("getTask throws on rows with legacy phases, getTaskRaw does not", () => {
    insertRaw("legacy", { ...makeState({ taskId: "legacy" }), currentPhase: "awaiting_review_approval" }, "awaiting_review_approval");
    expect(() => getTask("legacy")).toThrow();
    expect(getTaskRaw("legacy")?.currentPhase).toBe("awaiting_review_approval");
  });
});

describe("queries", () => {
  it("getTasksByPhase filters by phase", () => {
    const a = makeState({ currentPhase: "executing" });
    const b = makeState({ currentPhase: "reviewing" });
    createTask(a);
    createTask(b);
    expect(getTasksByPhase("executing").map((t) => t.taskId)).toEqual([a.taskId]);
    expect(getTasksByPhase("complete")).toEqual([]);
  });

  it("getActiveTasks excludes complete/failed/cancelled", () => {
    const phases = ["analyzing", "awaiting_plan_approval", "executing", "complete", "failed", "cancelled"] as const;
    const states = phases.map((p) => makeState({ currentPhase: p }));
    states.forEach(createTask);
    expect(getActiveTasks().map((t) => t.currentPhase).sort()).toEqual(
      ["analyzing", "awaiting_plan_approval", "executing"].sort(),
    );
  });

  it("getStaleTasks returns only awaiting_plan_approval tasks older than the cutoff", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100 * MIN);
    const stale = makeState({ currentPhase: "awaiting_plan_approval", updatedAt: 30 * MIN });
    const fresh = makeState({ currentPhase: "awaiting_plan_approval", updatedAt: 50 * MIN });
    const staleButExecuting = makeState({ currentPhase: "executing", updatedAt: 1 * MIN });
    [stale, fresh, staleButExecuting].forEach(createTask);
    // cutoff = 100 - 60 = 40min; updated_at < cutoff is stale
    expect(getStaleTasks(60 * MIN).map((t) => t.taskId)).toEqual([stale.taskId]);
  });

  it("getStaleTasks uses a strict < comparison at the boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100 * MIN);
    createTask(makeState({ currentPhase: "awaiting_plan_approval", updatedAt: 40 * MIN }));
    expect(getStaleTasks(60 * MIN)).toEqual([]);
  });

  it("getOldTerminalTaskIds returns old terminal task ids only", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000 * MIN);
    const oldDone = makeState({ currentPhase: "complete", updatedAt: 1 });
    const oldFailed = makeState({ currentPhase: "failed", updatedAt: 1 });
    const oldCancelled = makeState({ currentPhase: "cancelled", updatedAt: 1 });
    const newDone = makeState({ currentPhase: "complete", updatedAt: 10_000 * MIN });
    const oldActive = makeState({ currentPhase: "executing", updatedAt: 1 });
    [oldDone, oldFailed, oldCancelled, newDone, oldActive].forEach(createTask);
    expect(getOldTerminalTaskIds(24 * 60 * MIN).sort()).toEqual(
      [oldDone.taskId, oldFailed.taskId, oldCancelled.taskId].sort(),
    );
  });
});

describe("markInFlightTasksFailed", () => {
  it("marks analyzing/executing/reviewing/fixing/creating_mr as failed and reports them", () => {
    const inflight = (["analyzing", "executing", "reviewing", "fixing", "creating_mr"] as const).map((p, i) =>
      makeState({ currentPhase: p, worktreePath: i % 2 ? `/wt/${i}` : null }),
    );
    const untouched = (["awaiting_plan_approval", "complete", "cancelled"] as const).map((p) =>
      makeState({ currentPhase: p }),
    );
    [...inflight, ...untouched].forEach(createTask);

    const marked = markInFlightTasksFailed();
    expect(marked).toHaveLength(5);
    expect(marked).toEqual(
      expect.arrayContaining(
        inflight.map((s) => ({ taskId: s.taskId, phase: s.currentPhase, worktreePath: s.worktreePath })),
      ),
    );
    for (const s of inflight) expect(getTask(s.taskId)?.currentPhase).toBe("failed");
    for (const s of untouched) expect(getTask(s.taskId)?.currentPhase).toBe(s.currentPhase);
    expect(markInFlightTasksFailed()).toEqual([]);
  });
});

describe("getResumableTasks", () => {
  it("lists non-complete/non-cancelled tasks (including failed and legacy) newest first", () => {
    const failed = makeState({ currentPhase: "failed", updatedAt: 300, worktreePath: "/wt/f" });
    const reviewing = makeState({ currentPhase: "reviewing", updatedAt: 100 });
    const done = makeState({ currentPhase: "complete", updatedAt: 500 });
    const cancelled = makeState({ currentPhase: "cancelled", updatedAt: 600 });
    [failed, reviewing, done, cancelled].forEach(createTask);
    insertRaw("legacy1", { ...makeState({ taskId: "legacy1" }), currentPhase: "awaiting_review_approval", updatedAt: 200 }, "awaiting_review_approval", 200);

    const list = getResumableTasks();
    expect(list.map((t) => t.taskId)).toEqual([failed.taskId, "legacy1", reviewing.taskId]);
    expect(list[0]).toMatchObject({ phase: "failed", title: "Fix receipt reprint", worktreePath: "/wt/f", updatedAt: 300 });
    expect(list[1].phase).toBe("awaiting_review_approval");
  });

  it("falls back to defaults for sparse legacy JSON", () => {
    insertRaw("sparse", { taskId: "sparse" }, "executing", 5);
    expect(getResumableTasks()).toEqual([
      { taskId: "sparse", phase: "executing", title: "Unknown", worktreePath: null, updatedAt: 0, reviewIterations: [] },
    ]);
  });
});

describe("forceUpdatePhase", () => {
  it("repairs a legacy phase so getTask works again", () => {
    insertRaw("leg", { ...makeState({ taskId: "leg" }), currentPhase: "awaiting_review_approval" }, "awaiting_review_approval");
    forceUpdatePhase("leg", "reviewing");
    const t = getTask("leg")!;
    expect(t.currentPhase).toBe("reviewing");
    expect(getTasksByPhase("reviewing").map((x) => x.taskId)).toEqual(["leg"]);
  });

  it("is a no-op for unknown ids", () => {
    expect(() => forceUpdatePhase("missing", "failed")).not.toThrow();
  });
});
