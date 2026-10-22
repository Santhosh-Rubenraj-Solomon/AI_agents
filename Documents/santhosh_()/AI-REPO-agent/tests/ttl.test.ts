import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/gitService.js", () => ({
  removeWorktree: vi.fn(async () => {}),
}));
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) =>
    cb(null, { stdout: "", stderr: "" }),
  ),
}));

import { execFile } from "node:child_process";
import { removeWorktree } from "../src/services/gitService.js";
import { pruneOrphanedWorktrees, startTtlTimer, stopTtlTimer } from "../src/state/ttl.js";
import { closeDb, createPendingRequest, createTask, getPendingRequest, getTask, resolvePendingRequest } from "../src/state/store.js";
import { createFakeApp, makeState } from "./helpers.js";

const MIN = 60_000;
const T0 = new Date("2026-03-01T12:00:00Z").getTime();

describe("TTL timer", () => {
  beforeEach(() => {
    closeDb();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.mocked(removeWorktree).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    stopTtlTimer();
    vi.useRealTimers();
    closeDb();
  });

  it("does nothing before the first one-minute tick", async () => {
    const { app, client } = createFakeApp();
    const stale = makeState({ currentPhase: "awaiting_plan_approval", updatedAt: T0 - 120 * MIN });
    createTask(stale);
    startTtlTimer(app);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(getTask(stale.taskId)?.currentPhase).toBe("awaiting_plan_approval");
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("cancels stale awaiting tasks, removes worktrees and notifies the thread", async () => {
    const { app, client } = createFakeApp();
    const stale = makeState({
      currentPhase: "awaiting_plan_approval",
      updatedAt: T0 - 61 * MIN,
      worktreePath: "/wt/stale",
    });
    const fresh = makeState({ currentPhase: "awaiting_plan_approval", updatedAt: T0 - 10 * MIN });
    createTask(stale);
    createTask(fresh);

    startTtlTimer(app);
    await vi.advanceTimersByTimeAsync(MIN);

    expect(removeWorktree).toHaveBeenCalledWith("/wt/stale");
    expect(getTask(stale.taskId)?.currentPhase).toBe("cancelled");
    expect(getTask(fresh.taskId)?.currentPhase).toBe("awaiting_plan_approval");
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: stale.request.channelId,
      thread_ts: stale.request.threadTs,
      text: expect.stringContaining("has expired after 60 minutes"),
    });
  });

  it("a fresh task becomes stale on a later tick", async () => {
    const { app } = createFakeApp();
    const t = makeState({ currentPhase: "awaiting_plan_approval", updatedAt: T0 - 58 * MIN });
    createTask(t);
    startTtlTimer(app);
    await vi.advanceTimersByTimeAsync(MIN); // now T0+1 => 59 min old
    expect(getTask(t.taskId)?.currentPhase).toBe("awaiting_plan_approval");
    await vi.advanceTimersByTimeAsync(2 * MIN); // 61 min old
    expect(getTask(t.taskId)?.currentPhase).toBe("cancelled");
  });

  it("still cancels when worktree removal or Slack notification fails", async () => {
    const { app, client } = createFakeApp();
    vi.mocked(removeWorktree).mockRejectedValueOnce(new Error("git broke"));
    client.chat.postMessage.mockRejectedValueOnce(new Error("slack down"));
    const t = makeState({ currentPhase: "awaiting_plan_approval", updatedAt: T0 - 90 * MIN, worktreePath: "/wt/x" });
    createTask(t);
    startTtlTimer(app);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(getTask(t.taskId)?.currentPhase).toBe("cancelled");
  });

  it("deletes terminal tasks older than 24h and keeps recent ones", async () => {
    const { app } = createFakeApp();
    const old = makeState({ currentPhase: "complete", updatedAt: T0 - 25 * 60 * MIN });
    const recent = makeState({ currentPhase: "failed", updatedAt: T0 - 23 * 60 * MIN });
    createTask(old);
    createTask(recent);
    startTtlTimer(app);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(getTask(old.taskId)).toBeNull();
    expect(getTask(recent.taskId)).not.toBeNull();
  });

  it("prunes old resolved approval requests", async () => {
    const { app } = createFakeApp();
    vi.setSystemTime(T0 - 25 * 60 * MIN);
    createPendingRequest("done", "U", {});
    resolvePendingRequest("done", "approved");
    vi.setSystemTime(T0);
    createPendingRequest("waiting", "U", {});
    startTtlTimer(app);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(getPendingRequest("done")).toBeNull();
    expect(getPendingRequest("waiting")).not.toBeNull();
  });

  it("also notifies the requester's DM thread when a plan expires", async () => {
    const { app, client } = createFakeApp();
    const t = makeState({
      currentPhase: "awaiting_plan_approval",
      updatedAt: T0 - 90 * MIN,
      requesterChannelId: "D_UREQ",
      requesterThreadTs: "7.7",
    });
    createTask(t);
    startTtlTimer(app);
    await vi.advanceTimersByTimeAsync(MIN);
    const channels = client.chat.postMessage.mock.calls.map((c: any) => c[0].channel);
    expect(channels).toEqual([t.request.channelId, "D_UREQ"]);
  });

  it("startTtlTimer is idempotent (only one interval runs)", async () => {
    const { app, client } = createFakeApp();
    startTtlTimer(app);
    startTtlTimer(app);
    const t = makeState({ currentPhase: "awaiting_plan_approval", updatedAt: T0 - 90 * MIN });
    createTask(t);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stopTtlTimer stops further cleanup", async () => {
    const { app } = createFakeApp();
    startTtlTimer(app);
    stopTtlTimer();
    const t = makeState({ currentPhase: "awaiting_plan_approval", updatedAt: T0 - 90 * MIN });
    createTask(t);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(getTask(t.taskId)?.currentPhase).toBe("awaiting_plan_approval");
    expect(() => stopTtlTimer()).not.toThrow();
  });
});

describe("pruneOrphanedWorktrees", () => {
  it("runs `git worktree prune` in the monorepo root", async () => {
    await pruneOrphanedWorktrees();
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["worktree", "prune"],
      expect.objectContaining({ cwd: "/tmp/fake-monorepo", timeout: 10_000 }),
      expect.any(Function),
    );
  });

  it("swallows git failures", async () => {
    vi.mocked(execFile).mockImplementationOnce(((_c: any, _a: any, _o: any, cb: any) => cb(new Error("not a repo"))) as any);
    await expect(pruneOrphanedWorktrees()).resolves.toBeUndefined();
  });
});
