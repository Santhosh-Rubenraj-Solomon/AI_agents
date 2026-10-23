import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/claudeAgent.js", () => ({
  analyzeTask: vi.fn(),
  executeTask: vi.fn(),
  fixReviewIssues: vi.fn(),
  generateSummary: vi.fn(),
  chat: vi.fn(),
}));
vi.mock("../src/services/gitService.js", () => ({
  createWorktree: vi.fn(),
  cleanupOnFailure: vi.fn(),
  commitAndPush: vi.fn(),
  removeWorktree: vi.fn(),
  getScopedDiffStat: vi.fn(),
}));
vi.mock("../src/services/nxService.js", () => ({ runNxChecks: vi.fn() }));
vi.mock("../src/services/reviewerService.js", () => ({ runReview: vi.fn() }));
vi.mock("../src/services/gitlabService.js", () => ({ createMergeRequest: vi.fn() }));

import * as claude from "../src/services/claudeAgent.js";
import * as git from "../src/services/gitService.js";
import { runNxChecks } from "../src/services/nxService.js";
import { runReview } from "../src/services/reviewerService.js";
import { createMergeRequest } from "../src/services/gitlabService.js";
import * as agents from "../src/agents/index.js";
import {
  analyzerAgent,
  coderAgent,
  finalizerAgent,
  fixerAgent,
  reviewerAgent,
  summaryWriterAgent,
} from "../src/agents/index.js";
import { closeDb, createTask, getTask } from "../src/state/store.js";
import { makeAnalysis, makeState } from "./helpers.js";
import type { PipelineState } from "../src/types.js";

const nxPass = { passed: true, output: "", lintPassed: true, testPassed: true };
const nxFail = { passed: false, output: "lint error at foo.ts:1", lintPassed: false, testPassed: true };

function seed(overrides: Partial<PipelineState> = {}): PipelineState {
  const s = makeState(overrides);
  createTask(s);
  return s;
}

beforeEach(() => {
  closeDb();
  vi.clearAllMocks();
});

describe("agent barrel", () => {
  it("exports every agent with a name and active phase", () => {
    expect(
      [agents.analyzerAgent, agents.coderAgent, agents.reviewerAgent, agents.fixerAgent, agents.finalizerAgent, agents.summaryWriterAgent].map(
        (a) => [a.name, a.activePhase],
      ),
    ).toEqual([
      ["Analyzer", "analyzing"],
      ["Coder", "executing"],
      ["Reviewer", "reviewing"],
      ["Fixer", "fixing"],
      ["Finalizer", "creating_mr"],
      ["SummaryWriter", "complete"],
    ]);
  });

  it.each([analyzerAgent, coderAgent, reviewerAgent, fixerAgent, finalizerAgent, summaryWriterAgent])(
    "$name returns TASK_NOT_FOUND for unknown tasks",
    async (agent) => {
      const res = await agent.run({ taskId: "missing" });
      expect(res).toMatchObject({ success: false, error: "TASK_NOT_FOUND" });
    },
  );
});

describe("analyzerAgent", () => {
  it("persists the analysis and moves to awaiting_plan_approval", async () => {
    const s = seed();
    const analysis = makeAnalysis({ filesToCreate: ["libs/shared/new.ts"] });
    vi.mocked(claude.analyzeTask).mockResolvedValue(analysis);

    const res = await analyzerAgent.run({ taskId: s.taskId });

    expect(claude.analyzeTask).toHaveBeenCalledWith(s.request);
    expect(res.success).toBe(true);
    expect(res.analysis).toEqual(analysis);
    expect(res.message).toContain("1 file(s) to modify, 1 to create");
    const after = getTask(s.taskId)!;
    expect(after.currentPhase).toBe("awaiting_plan_approval");
    expect(after.analysis).toEqual(analysis);
    expect(after.branchName).toBe("fix/receipt-reprint");
  });

  it("fails the task when Claude proposes out-of-scope files", async () => {
    const s = seed();
    vi.mocked(claude.analyzeTask).mockResolvedValue(makeAnalysis({ filesToChange: ["apps/payments/x.ts"] }));
    const res = await analyzerAgent.run({ taskId: s.taskId });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/SCOPE VIOLATION/);
    expect(getTask(s.taskId)?.currentPhase).toBe("failed");
    expect(getTask(s.taskId)?.analysis).toBeNull();
  });

  it("fails the task when Claude proposes a branch name git would misparse", async () => {
    const s = seed();
    vi.mocked(claude.analyzeTask).mockResolvedValue(makeAnalysis({ branchName: "--mirror" }));
    const res = await analyzerAgent.run({ taskId: s.taskId });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Invalid branch name/);
    expect(getTask(s.taskId)?.currentPhase).toBe("failed");
  });

  it("fails the task when analysis throws", async () => {
    const s = seed();
    vi.mocked(claude.analyzeTask).mockRejectedValue(new Error("claude timeout"));
    const res = await analyzerAgent.run({ taskId: s.taskId });
    expect(res).toMatchObject({ success: false, error: "claude timeout", analysis: null });
    expect(getTask(s.taskId)?.currentPhase).toBe("failed");
  });
});

describe("coderAgent", () => {
  const ready = () => seed({ analysis: makeAnalysis(), branchName: "fix/x", currentPhase: "awaiting_plan_approval" });

  it("refuses to run without an approved analysis", async () => {
    const s = seed();
    expect(await coderAgent.run({ taskId: s.taskId })).toMatchObject({ success: false, error: "NO_ANALYSIS" });
    expect(git.createWorktree).not.toHaveBeenCalled();
  });

  it("creates a worktree, executes and passes nx on first try", async () => {
    const s = ready();
    vi.mocked(git.createWorktree).mockResolvedValue("/wt/1");
    vi.mocked(runNxChecks).mockResolvedValue(nxPass);

    const res = await coderAgent.run({ taskId: s.taskId });

    expect(git.createWorktree).toHaveBeenCalledWith(s.taskId, "fix/x");
    expect(claude.executeTask).toHaveBeenCalledWith(s.request, s.analysis, "/wt/1");
    expect(claude.fixReviewIssues).not.toHaveBeenCalled();
    expect(res).toMatchObject({ success: true, nxPassed: true });
    expect(getTask(s.taskId)).toMatchObject({ currentPhase: "executing", worktreePath: "/wt/1" });
  });

  it("auto-fixes once when nx fails, feeding nx output to Claude", async () => {
    const s = ready();
    vi.mocked(git.createWorktree).mockResolvedValue("/wt/2");
    vi.mocked(runNxChecks).mockResolvedValueOnce(nxFail).mockResolvedValueOnce(nxPass);

    const res = await coderAgent.run({ taskId: s.taskId });

    expect(claude.fixReviewIssues).toHaveBeenCalledTimes(1);
    const [, , feedback, wt, id] = vi.mocked(claude.fixReviewIssues).mock.calls[0];
    expect(feedback).toContain("## Nx Check Failures");
    expect(feedback).toContain("lint error at foo.ts:1");
    expect([wt, id]).toEqual(["/wt/2", s.taskId]);
    expect(res).toMatchObject({ success: true, nxPassed: true, message: expect.stringContaining("after auto-fix") });
  });

  it("cleans up and fails when nx still fails after auto-fix", async () => {
    const s = ready();
    vi.mocked(git.createWorktree).mockResolvedValue("/wt/3");
    vi.mocked(runNxChecks).mockResolvedValue(nxFail);

    const res = await coderAgent.run({ taskId: s.taskId });

    expect(res).toMatchObject({ success: false, error: "NX_CHECKS_FAILED", nxPassed: false });
    expect(git.cleanupOnFailure).toHaveBeenCalledWith("/wt/3", "fix/x");
    expect(getTask(s.taskId)).toMatchObject({ currentPhase: "failed", worktreePath: null });
  });

  it("cleans up the worktree when Claude execution throws", async () => {
    const s = ready();
    vi.mocked(git.createWorktree).mockResolvedValue("/wt/4");
    vi.mocked(claude.executeTask).mockRejectedValue(new Error("boom"));
    const res = await coderAgent.run({ taskId: s.taskId });
    expect(res).toMatchObject({ success: false, error: "boom" });
    expect(git.cleanupOnFailure).toHaveBeenCalledWith("/wt/4", "fix/x");
    expect(getTask(s.taskId)).toMatchObject({ currentPhase: "failed", worktreePath: null });
  });

  it("does not attempt cleanup when worktree creation itself fails", async () => {
    const s = ready();
    vi.mocked(git.createWorktree).mockRejectedValue(new Error("branch exists"));
    const res = await coderAgent.run({ taskId: s.taskId });
    expect(res.success).toBe(false);
    expect(git.cleanupOnFailure).not.toHaveBeenCalled();
  });
});

describe("reviewerAgent", () => {
  const cli = (hasIssues: boolean) => ({ content: hasIssues ? "## Issues" : "LGTM", mdPath: "/wt/review.md", hasIssues, rawOutput: "out" });

  it("requires a worktree", async () => {
    const s = seed();
    expect(await reviewerAgent.run({ taskId: s.taskId })).toMatchObject({ success: false, error: "NO_WORKTREE" });
  });

  it("records a clean review iteration", async () => {
    const s = seed({ worktreePath: "/wt" });
    vi.mocked(runReview).mockResolvedValue(cli(false));
    const res = await reviewerAgent.run({ taskId: s.taskId });
    expect(res.success).toBe(true);
    expect(res.message).toContain("Review passed");
    expect(res.review).toMatchObject({ iteration: 1, hasIssues: false });
    expect(getTask(s.taskId)?.reviewIterations).toHaveLength(1);
    expect(getTask(s.taskId)?.currentPhase).toBe("reviewing");
  });

  it("numbers iterations after existing ones and reports issues", async () => {
    const s = seed({
      worktreePath: "/wt",
      reviewIterations: [{ content: "old", mdPath: "/a.md", hasIssues: true, iteration: 1 }],
    });
    vi.mocked(runReview).mockResolvedValue(cli(true));
    const res = await reviewerAgent.run({ taskId: s.taskId });
    expect(res.review?.iteration).toBe(2);
    expect(res.message).toContain("Iteration 2/3");
    expect(getTask(s.taskId)?.reviewIterations.map((r) => r.iteration)).toEqual([1, 2]);
  });

  it.each([
    [{ type: "bugfix", problemDescription: "P", proposedSolution: "S" }, { problem: "P", solution: "S" }],
    [{ type: "bugfix", problemDescription: undefined, proposedSolution: undefined, description: "D" }, { problem: "D", solution: "D" }],
    [{ type: "feature", featureDescription: "F" }, { problem: "F", solution: "F" }],
    [{ type: "refactor", refactorDescription: "R" }, { problem: "R", solution: "R" }],
    [{ type: "documentation", documentationDescription: undefined, description: undefined }, { problem: "Documentation update", solution: "See code changes" }],
  ])("maps request %j into review context", async (req, expected) => {
    const s = seed({ worktreePath: "/wt", request: req as any });
    vi.mocked(runReview).mockResolvedValue(cli(false));
    await reviewerAgent.run({ taskId: s.taskId });
    expect(runReview).toHaveBeenCalledWith("/wt", { title: "Fix receipt reprint", ...expected });
  });

  it("fails the task when the review CLI throws", async () => {
    const s = seed({ worktreePath: "/wt" });
    vi.mocked(runReview).mockRejectedValue(new Error("review not installed"));
    const res = await reviewerAgent.run({ taskId: s.taskId });
    expect(res).toMatchObject({ success: false, review: null, error: "review not installed" });
    expect(getTask(s.taskId)?.currentPhase).toBe("failed");
  });
});

describe("fixerAgent", () => {
  const withIssues = (hasIssues = true) =>
    seed({
      worktreePath: "/wt",
      analysis: makeAnalysis(),
      reviewIterations: [{ content: "## Fix X", mdPath: "/r.md", hasIssues, iteration: 1 }],
    });

  it("requires a worktree and analysis", async () => {
    const s = seed({ worktreePath: "/wt" });
    expect(await fixerAgent.run({ taskId: s.taskId })).toMatchObject({ error: "MISSING_PREREQUISITES" });
  });

  it("returns NO_ISSUES when there is no review or the last one is clean", async () => {
    const none = seed({ worktreePath: "/wt", analysis: makeAnalysis() });
    expect(await fixerAgent.run({ taskId: none.taskId })).toMatchObject({ success: false, error: "NO_ISSUES" });
    const clean = withIssues(false);
    expect(await fixerAgent.run({ taskId: clean.taskId })).toMatchObject({ success: false, error: "NO_ISSUES" });
    expect(claude.fixReviewIssues).not.toHaveBeenCalled();
  });

  it("passes the last review markdown to Claude and re-runs nx", async () => {
    const s = withIssues();
    vi.mocked(runNxChecks).mockResolvedValue(nxPass);
    const res = await fixerAgent.run({ taskId: s.taskId });
    expect(claude.fixReviewIssues).toHaveBeenCalledWith(s.request, s.analysis, "## Fix X", "/wt", s.taskId);
    expect(res).toMatchObject({ success: true, nxPassed: true });
    expect(getTask(s.taskId)?.currentPhase).toBe("fixing");
  });

  it("still succeeds (nxPassed=false) when nx fails after fixing", async () => {
    const s = withIssues();
    vi.mocked(runNxChecks).mockResolvedValue(nxFail);
    const res = await fixerAgent.run({ taskId: s.taskId });
    expect(res).toMatchObject({ success: true, nxPassed: false });
    expect(res.message).toContain("lint error at foo.ts:1");
  });

  it("fails the task when Claude throws", async () => {
    const s = withIssues();
    vi.mocked(claude.fixReviewIssues).mockRejectedValue(new Error("x"));
    expect(await fixerAgent.run({ taskId: s.taskId })).toMatchObject({ success: false, error: "x" });
    expect(getTask(s.taskId)?.currentPhase).toBe("failed");
  });
});

describe("finalizerAgent", () => {
  const ready = (o: Partial<PipelineState> = {}) =>
    seed({
      worktreePath: "/wt",
      branchName: "fix/x",
      analysis: makeAnalysis(),
      reviewIterations: [{ content: "LGTM", mdPath: "/r.md", hasIssues: false, iteration: 1 }],
      ...o,
    });

  beforeEach(() => {
    vi.mocked(git.commitAndPush).mockResolvedValue("abc1234");
    vi.mocked(createMergeRequest).mockResolvedValue({ url: "https://gitlab/mr/9", iid: 9 });
    vi.mocked(git.getScopedDiffStat).mockResolvedValue("stat");
  });

  it("requires a worktree and branch", async () => {
    const s = seed({ worktreePath: "/wt" });
    expect(await finalizerAgent.run({ taskId: s.taskId })).toMatchObject({ error: "MISSING_PREREQUISITES" });
  });

  it("commits, opens an MR with a conventional title and completes", async () => {
    const s = ready({ reviewerGitLabIds: [3, 4] });
    const res = await finalizerAgent.run({ taskId: s.taskId });

    expect(git.commitAndPush).toHaveBeenCalledWith("/wt", "fix/x", "Fix receipt reprint", "bugfix");
    expect(createMergeRequest).toHaveBeenCalledWith({
      branchName: "fix/x",
      title: "fix(ecr-service): fix receipt reprint",
      description: expect.stringContaining("## Bug Fix: Fix receipt reprint"),
      reviewerIds: [3, 4],
    });
    expect(git.removeWorktree).toHaveBeenCalledWith("/wt");
    expect(res).toMatchObject({ success: true, commitHash: "abc1234", mrUrl: "https://gitlab/mr/9" });
    expect(res.message).toContain("Review Clean: Yes");
    expect(getTask(s.taskId)).toMatchObject({ currentPhase: "complete", commitHash: "abc1234", mrUrl: "https://gitlab/mr/9" });
  });

  it("omits reviewerIds when none were resolved", async () => {
    const s = ready();
    await finalizerAgent.run({ taskId: s.taskId });
    expect(vi.mocked(createMergeRequest).mock.calls[0][0].reviewerIds).toBeUndefined();
  });

  it("treats worktree cleanup failure as non-fatal", async () => {
    const s = ready();
    vi.mocked(git.removeWorktree).mockRejectedValue(new Error("busy"));
    expect((await finalizerAgent.run({ taskId: s.taskId })).success).toBe(true);
  });

  it("fails but keeps the commit hash when MR creation fails", async () => {
    const s = ready();
    vi.mocked(createMergeRequest).mockRejectedValue(new Error("403"));
    const res = await finalizerAgent.run({ taskId: s.taskId });
    expect(res).toMatchObject({ success: false, commitHash: "abc1234", mrUrl: null, error: "403" });
    expect(getTask(s.taskId)?.currentPhase).toBe("failed");
  });
});

describe("summaryWriterAgent", () => {
  it("generates a summary and saves it inside the worktree", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ecr-sw-"));
    try {
      const s = seed({
        worktreePath: dir,
        analysis: makeAnalysis(),
        branchName: "fix/x",
        mrUrl: "https://gitlab/mr/1",
        reviewIterations: [{ content: "issue A", mdPath: "/r.md", hasIssues: true, iteration: 1 }],
      });
      vi.mocked(git.getScopedDiffStat).mockResolvedValue("3 files changed");
      vi.mocked(claude.generateSummary).mockResolvedValue("# Summary");

      const res = await summaryWriterAgent.run({ taskId: s.taskId });

      const [prompt, cwd] = vi.mocked(claude.generateSummary).mock.calls[0];
      expect(cwd).toBe("/tmp/fake-monorepo");
      expect(prompt).toContain("Title: Fix receipt reprint");
      expect(prompt).toContain("(+ libs/shared)");
      expect(prompt).toContain("3 files changed");
      expect(prompt).toContain("### Iteration 1\n- Has Issues: Yes");
      const expectedPath = path.join(dir, ".ecr-factory", `merge-request-summary-${s.taskId}.md`);
      expect(res).toEqual({ success: true, message: "MR summary generated successfully.", mdPath: expectedPath, content: "# Summary" });
      expect(fs.readFileSync(expectedPath, "utf-8")).toBe("# Summary");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("works without a worktree (mdPath null, diff unavailable)", async () => {
    const s = seed();
    vi.mocked(claude.generateSummary).mockResolvedValue("md");
    const res = await summaryWriterAgent.run({ taskId: s.taskId });
    expect(res).toMatchObject({ success: true, mdPath: null, content: "md" });
    const prompt = vi.mocked(claude.generateSummary).mock.calls[0][0];
    expect(prompt).toContain("not available — worktree cleaned up");
    expect(prompt).toContain("No review iterations recorded.");
    expect(git.getScopedDiffStat).not.toHaveBeenCalled();
  });

  it("tolerates diff-stat failures and unwritable worktrees", async () => {
    const s = seed({ worktreePath: "/definitely/not/writable/path" });
    vi.mocked(git.getScopedDiffStat).mockRejectedValue(new Error("gone"));
    vi.mocked(claude.generateSummary).mockResolvedValue("md");
    expect(await summaryWriterAgent.run({ taskId: s.taskId })).toMatchObject({ success: true, mdPath: null });
  });

  it("reports failure when Claude fails", async () => {
    const s = seed();
    vi.mocked(claude.generateSummary).mockRejectedValue(new Error("timeout"));
    expect(await summaryWriterAgent.run({ taskId: s.taskId })).toMatchObject({ success: false, content: null, error: "timeout" });
  });
});
