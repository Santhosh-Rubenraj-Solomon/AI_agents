import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agents/index.js", () => {
  const mk = (name: string) => ({ name, activePhase: name, run: vi.fn() });
  return {
    analyzerAgent: mk("Analyzer"),
    coderAgent: mk("Coder"),
    reviewerAgent: mk("Reviewer"),
    fixerAgent: mk("Fixer"),
    finalizerAgent: mk("Finalizer"),
    summaryWriterAgent: mk("SummaryWriter"),
  };
});
vi.mock("../src/services/gitService.js", () => ({ cleanupOnFailure: vi.fn(async () => {}) }));
vi.mock("../src/services/summaryService.js", () => ({
  generatePlanMd: vi.fn(() => "PLAN-MD"),
  generateFinalSummaryMd: vi.fn(async () => "SUMMARY-MD"),
  postMdToThread: vi.fn(async () => {}),
}));
vi.mock("../src/utils/slackFileUpload.js", () => ({ uploadMdToSlack: vi.fn(async () => {}) }));
vi.mock("../src/utils/userMapping.js", () => ({ resolveGitLabReviewers: vi.fn(async () => []) }));

import * as agents from "../src/agents/index.js";
import { cleanupOnFailure } from "../src/services/gitService.js";
import { generateFinalSummaryMd, postMdToThread } from "../src/services/summaryService.js";
import { uploadMdToSlack } from "../src/utils/slackFileUpload.js";
import { resolveGitLabReviewers } from "../src/utils/userMapping.js";
import { cancelPipeline, executePlan, resumePipeline, startPipeline } from "../src/pipeline/coordinator.js";
import { closeDb, createTask, getDb, getTask, updateTask } from "../src/state/store.js";
import { createFakeApp, makeAnalysis, makeState, postedTexts } from "./helpers.js";
import type { PipelineState } from "../src/types.js";

const run = (a: keyof typeof agents) => vi.mocked((agents[a] as any).run as (...args: any[]) => Promise<any>);

/** Agent fakes that mutate the store like the real agents do. */
function analyzerSucceeds() {
  run("analyzerAgent").mockImplementation(async ({ taskId }) => {
    const s = getTask(taskId)!;
    s.analysis = makeAnalysis();
    s.branchName = s.analysis.branchName;
    s.currentPhase = "awaiting_plan_approval";
    updateTask(s);
    return { success: true, message: "ok", analysis: s.analysis };
  });
}
function coderSucceeds(nxPassed = true) {
  run("coderAgent").mockImplementation(async ({ taskId }) => {
    const s = getTask(taskId)!;
    s.worktreePath ??= "/wt/" + taskId;
    s.currentPhase = "executing";
    updateTask(s);
    return { success: true, message: "Code written.", nxPassed };
  });
}
function reviewerSequence(...hasIssues: boolean[]) {
  let i = 0;
  run("reviewerAgent").mockImplementation(async ({ taskId }) => {
    const s = getTask(taskId)!;
    const review = { content: `review ${i}`, mdPath: "/r.md", hasIssues: hasIssues[i++] ?? false, iteration: s.reviewIterations.length + 1 };
    s.reviewIterations.push(review);
    s.currentPhase = "reviewing";
    updateTask(s);
    return { success: true, message: "reviewed", review };
  });
}
function fixerSucceeds(nxPassed = true) {
  run("fixerAgent").mockResolvedValue({ success: true, message: "fixed", nxPassed });
}
function finalizerSucceeds() {
  run("finalizerAgent").mockImplementation(async ({ taskId }) => {
    const s = getTask(taskId)!;
    s.commitHash = "abc123";
    s.mrUrl = "https://gitlab/mr/1";
    s.currentPhase = "complete";
    updateTask(s);
    return { success: true, message: "done", commitHash: "abc123", mrUrl: "https://gitlab/mr/1" };
  });
}
function summaryWriterSucceeds() {
  run("summaryWriterAgent").mockResolvedValue({ success: true, message: "ok", mdPath: null, content: "MR-SUMMARY" });
}

function seed(o: Partial<PipelineState> = {}) {
  const s = makeState(o);
  createTask(s);
  return s;
}

const baseInput = {
  type: "bugfix",
  title: "Fix receipt reprint",
  description: "desc",
  priority: "high",
  userId: "UADMIN",
  channelId: "DADMIN",
  threadTs: "100.1",
};

function onlyTask(): PipelineState {
  const rows = getDb().prepare("SELECT task_id FROM tasks").all() as { task_id: string }[];
  expect(rows).toHaveLength(1);
  return getTask(rows[0].task_id)!;
}

beforeEach(() => {
  closeDb();
  vi.clearAllMocks();
  vi.mocked(resolveGitLabReviewers).mockResolvedValue([]);
  vi.mocked(generateFinalSummaryMd).mockResolvedValue("SUMMARY-MD");
});

describe("startPipeline", () => {
  it("persists the task, announces Phase 1 and posts plan + approval buttons", async () => {
    const { app, client } = createFakeApp();
    analyzerSucceeds();

    await startPipeline(app, { ...baseInput, branchName: "fix/custom", reviewerSlackIds: ["U9"] });

    const task = onlyTask();
    expect(task.taskId).toMatch(/^[0-9a-f]{8}$/);
    expect(task.request).toMatchObject({ type: "bugfix", priority: "high", branchName: "fix/custom", reviewerSlackIds: ["U9"] });
    expect(run("analyzerAgent")).toHaveBeenCalledWith({ taskId: task.taskId });

    const calls = client.chat.postMessage.mock.calls.map((c) => c[0]);
    expect(calls[0]).toMatchObject({ channel: "DADMIN", thread_ts: "100.1", text: expect.stringContaining("Phase 1 -- Analysis") });
    expect(postMdToThread).toHaveBeenCalledWith(client, "DADMIN", "100.1", "Execution Plan", "PLAN-MD", task.taskId);

    const approval = calls.find((c: any) => c.text === "Plan ready for approval") as any;
    const buttons = approval.blocks.find((b: any) => b.type === "actions").elements;
    expect(buttons.map((b: any) => [b.action_id, b.value])).toEqual([
      ["approve_plan", task.taskId],
      ["reject_plan", task.taskId],
    ]);
    expect(approval.blocks[1].text.text).toContain("`fix/receipt-reprint`");
  });

  it("reports analysis failure and does not post approval buttons", async () => {
    const { app, client } = createFakeApp();
    run("analyzerAgent").mockResolvedValue({ success: false, message: "Claude said no", analysis: null });
    await startPipeline(app, baseInput);
    const texts = postedTexts(client);
    expect(texts.some((t) => t.includes("Analysis Failed:* Claude said no"))).toBe(true);
    expect(texts.some((t) => t.includes("approve_plan"))).toBe(false);
    expect(postMdToThread).not.toHaveBeenCalled();
  });

  it("opens a requester DM thread when requester differs from the admin and mirrors updates", async () => {
    const { app, client } = createFakeApp();
    run("analyzerAgent").mockResolvedValue({ success: false, message: "x", analysis: null });

    await startPipeline(app, { ...baseInput, requesterId: "UREQ" });

    expect(client.conversations.open).toHaveBeenCalledWith({ users: "UREQ" });
    const task = onlyTask();
    expect(task.requesterId).toBe("UREQ");
    expect(task.requesterChannelId).toBe("D_UREQ");
    expect(task.requesterThreadTs).toMatch(/^9000\./);
    const channels = client.chat.postMessage.mock.calls.map((c: any) => c[0].channel);
    // intro DM, then Phase 1 to admin + requester, then failure to admin + requester
    expect(channels).toEqual(["D_UREQ", "DADMIN", "D_UREQ", "DADMIN", "D_UREQ"]);
  });

  it("does not open a requester DM when the admin is the requester", async () => {
    const { app, client } = createFakeApp();
    run("analyzerAgent").mockResolvedValue({ success: false, message: "x", analysis: null });
    await startPipeline(app, { ...baseInput, requesterId: "UADMIN" });
    expect(client.conversations.open).not.toHaveBeenCalled();
  });

  it("continues when the requester DM cannot be opened", async () => {
    const { app, client } = createFakeApp();
    client.conversations.open.mockRejectedValueOnce(new Error("cannot_dm_bot"));
    analyzerSucceeds();
    await startPipeline(app, { ...baseInput, requesterId: "UREQ" });
    expect(onlyTask().requesterChannelId).toBeNull();
    expect(postedTexts(client).some((t) => t.includes("approve_plan"))).toBe(true);
  });

  // BUG (src/pipeline/coordinator.ts:320 + src/handlers/planApprovalHandler.ts:22):
  // the approval buttons are posted with the broadcast say(), so they are mirrored into
  // the *requester's* DM, and approve_plan does not check who clicked. A non-admin
  // requester can therefore approve their own plan, bypassing the admin gate.
  it.skip("BUG: does not send Approve/Reject plan buttons to the requester DM", async () => {
    const { app, client } = createFakeApp();
    analyzerSucceeds();
    await startPipeline(app, { ...baseInput, requesterId: "UREQ" });
    const toRequester = client.chat.postMessage.mock.calls.map((c: any) => c[0]).filter((m: any) => m.channel === "D_UREQ");
    expect(JSON.stringify(toRequester)).not.toContain("approve_plan");
  });
});

describe("executePlan + review loop + finalize", () => {
  const ready = (o: Partial<PipelineState> = {}) =>
    seed({ analysis: makeAnalysis(), branchName: "fix/x", currentPhase: "awaiting_plan_approval", ...o });

  beforeEach(() => {
    summaryWriterSucceeds();
  });

  it("is a no-op for unknown tasks", async () => {
    const { app, client } = createFakeApp();
    await executePlan("nope", app);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(run("coderAgent")).not.toHaveBeenCalled();
  });

  it("stops after a coder failure", async () => {
    const { app, client } = createFakeApp();
    const s = ready();
    run("coderAgent").mockResolvedValue({ success: false, message: "nx broke", nxPassed: false });
    await executePlan(s.taskId, app);
    expect(postedTexts(client).some((t) => t.includes("Execution Failed:* nx broke"))).toBe(true);
    expect(run("reviewerAgent")).not.toHaveBeenCalled();
  });

  it("runs the happy path: code -> clean review -> finalize -> MR summary", async () => {
    const { app, client } = createFakeApp();
    const s = ready();
    coderSucceeds();
    reviewerSequence(false);
    finalizerSucceeds();

    await executePlan(s.taskId, app);

    expect(run("reviewerAgent")).toHaveBeenCalledTimes(1);
    expect(run("fixerAgent")).not.toHaveBeenCalled();
    expect(run("finalizerAgent")).toHaveBeenCalledWith({ taskId: s.taskId });
    expect(uploadMdToSlack).toHaveBeenCalledWith(client, "DADMIN", "111.222", "review-feedback-iteration-1.md", "review 0", expect.any(String));
    expect(postMdToThread).toHaveBeenCalledWith(client, "DADMIN", "111.222", "Execution Summary", "SUMMARY-MD", s.taskId);
    expect(uploadMdToSlack).toHaveBeenCalledWith(client, "DADMIN", "111.222", `merge-request-summary-${s.taskId}.md`, "MR-SUMMARY", expect.any(String));
    const texts = postedTexts(client).join("\n");
    expect(texts).toContain("Review Passed");
    expect(texts).toContain("Merge Request:* https://gitlab/mr/1");
    expect(texts).toContain(`Pipeline Complete -- ${s.taskId}`);
  });

  it("posts a warning (not success) when nx did not pass", async () => {
    const { app, client } = createFakeApp();
    const s = ready();
    coderSucceeds(false);
    reviewerSequence(false);
    finalizerSucceeds();
    await executePlan(s.taskId, app);
    expect(postedTexts(client).some((t) => t.includes(":warning: Code written."))).toBe(true);
  });

  it("fixes issues and re-reviews until clean", async () => {
    const { app } = createFakeApp();
    const s = ready();
    coderSucceeds();
    reviewerSequence(true, true, false);
    fixerSucceeds();
    finalizerSucceeds();
    await executePlan(s.taskId, app);
    expect(run("reviewerAgent")).toHaveBeenCalledTimes(3);
    expect(run("fixerAgent")).toHaveBeenCalledTimes(2);
    expect(run("finalizerAgent")).toHaveBeenCalledTimes(1);
  });

  it("finalizes with remaining issues after MAX_REVIEW_ITERATIONS (3)", async () => {
    const { app, client } = createFakeApp();
    const s = ready();
    coderSucceeds();
    reviewerSequence(true, true, true, true);
    fixerSucceeds(false);
    finalizerSucceeds();
    await executePlan(s.taskId, app);
    expect(run("reviewerAgent")).toHaveBeenCalledTimes(3);
    expect(run("fixerAgent")).toHaveBeenCalledTimes(2);
    expect(run("finalizerAgent")).toHaveBeenCalledTimes(1);
    expect(postedTexts(client).some((t) => t.includes("Max review iterations reached (3)"))).toBe(true);
  });

  it("stops the loop when the reviewer or fixer fails", async () => {
    const { app } = createFakeApp();
    const s1 = ready();
    coderSucceeds();
    run("reviewerAgent").mockResolvedValue({ success: false, message: "cli missing", review: null });
    await executePlan(s1.taskId, app);
    expect(run("finalizerAgent")).not.toHaveBeenCalled();

    const s2 = ready();
    reviewerSequence(true);
    run("fixerAgent").mockResolvedValue({ success: false, message: "fix failed" });
    await executePlan(s2.taskId, app);
    expect(run("reviewerAgent")).toHaveBeenCalledTimes(2);
    expect(run("finalizerAgent")).not.toHaveBeenCalled();
  });

  it("uploads the review-disagreements file if Claude wrote one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ecr-coord-"));
    try {
      const { app, client } = createFakeApp();
      const s = ready({ worktreePath: dir });
      fs.writeFileSync(path.join(dir, `review-disagreements-${s.taskId}.md`), "  I disagree  \n");
      coderSucceeds();
      reviewerSequence(false);
      finalizerSucceeds();
      await executePlan(s.taskId, app);
      expect(uploadMdToSlack).toHaveBeenCalledWith(client, "DADMIN", "111.222", `review-disagreements-${s.taskId}.md`, "I disagree", expect.any(String));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves MR reviewers before the finalizer runs", async () => {
    const { app, client } = createFakeApp();
    const s = ready({ request: { reviewerSlackIds: ["U1", "U2"] } as any });
    coderSucceeds();
    reviewerSequence(false);
    vi.mocked(resolveGitLabReviewers).mockResolvedValue([7, 8]);
    let seenIds: number[] | null = null;
    run("finalizerAgent").mockImplementation(async ({ taskId }) => {
      seenIds = getTask(taskId)!.reviewerGitLabIds;
      return { success: true, message: "ok", commitHash: "c", mrUrl: "u" };
    });
    await executePlan(s.taskId, app);
    expect(resolveGitLabReviewers).toHaveBeenCalledWith(client, ["U1", "U2"]);
    expect(seenIds).toEqual([7, 8]);
  });

  it("continues to finalize when reviewer resolution throws", async () => {
    const { app } = createFakeApp();
    const s = ready({ request: { reviewerSlackIds: ["U1"] } as any });
    coderSucceeds();
    reviewerSequence(false);
    finalizerSucceeds();
    vi.mocked(resolveGitLabReviewers).mockRejectedValue(new Error("gitlab down"));
    await executePlan(s.taskId, app);
    expect(run("finalizerAgent")).toHaveBeenCalled();
    expect(getTask(s.taskId)?.reviewerGitLabIds).toBeNull();
  });

  it("does not run the summary writer when finalize fails, and tolerates summary writer errors", async () => {
    const { app, client } = createFakeApp();
    const s = ready();
    coderSucceeds();
    reviewerSequence(false);
    run("finalizerAgent").mockResolvedValue({ success: false, message: "push rejected" });
    await executePlan(s.taskId, app);
    expect(postedTexts(client).some((t) => t.includes("Finalize Failed:* push rejected"))).toBe(true);
    expect(run("summaryWriterAgent")).not.toHaveBeenCalled();

    const s2 = ready();
    reviewerSequence(false);
    finalizerSucceeds();
    run("summaryWriterAgent").mockRejectedValue(new Error("boom"));
    await expect(executePlan(s2.taskId, app)).resolves.toBeUndefined();
  });
});

describe("cancelPipeline", () => {
  it("cleans up the worktree, marks cancelled and posts the reason", async () => {
    const { app, client } = createFakeApp();
    const s = seed({ worktreePath: "/wt/c", branchName: "fix/c", currentPhase: "awaiting_plan_approval" });
    await cancelPipeline(s.taskId, app, "Plan rejected.");
    expect(cleanupOnFailure).toHaveBeenCalledWith("/wt/c", "fix/c");
    expect(getTask(s.taskId)).toMatchObject({ currentPhase: "cancelled", worktreePath: null });
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: ":no_entry_sign: Plan rejected." }));
  });

  it("skips cleanup without a worktree and ignores unknown tasks", async () => {
    const { app, client } = createFakeApp();
    const s = seed();
    await cancelPipeline(s.taskId, app, "bye");
    expect(cleanupOnFailure).not.toHaveBeenCalled();
    await cancelPipeline("missing", app, "bye");
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe("resumePipeline", () => {
  beforeEach(() => {
    summaryWriterSucceeds();
  });

  function insertLegacy(state: Record<string, unknown>, phase: string) {
    getDb()
      .prepare("INSERT INTO tasks VALUES (?, ?, ?, 'U', 'C', '1', ?, 1, 1)")
      .run(state.taskId, JSON.stringify({ ...state, currentPhase: phase }), phase, (state.worktreePath as string) ?? null);
  }

  it("does nothing for unknown tasks", async () => {
    const { app, client } = createFakeApp();
    await resumePipeline(app, "missing");
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("maps the legacy awaiting_review_approval phase to the review loop", async () => {
    const { app, client } = createFakeApp();
    const s = makeState({ worktreePath: "/wt/l", branchName: "fix/l", analysis: makeAnalysis() });
    insertLegacy(s as any, "awaiting_review_approval");
    reviewerSequence(false);
    finalizerSucceeds();
    await resumePipeline(app, s.taskId);
    expect(postedTexts(client)[0]).toContain("`awaiting_review_approval` -> `reviewing`");
    expect(run("reviewerAgent")).toHaveBeenCalled();
    expect(run("finalizerAgent")).toHaveBeenCalled();
  });

  it.each([
    ["failed with reviews + worktree -> finalize", { currentPhase: "failed", worktreePath: "/wt", reviewIterations: [{ content: "", mdPath: "", hasIssues: false, iteration: 1 }] }, "finalizerAgent", "reviewerAgent"],
    ["failed with worktree only -> review loop", { currentPhase: "failed", worktreePath: "/wt" }, "reviewerAgent", "analyzerAgent"],
    ["failed with nothing -> analysis", { currentPhase: "failed" }, "analyzerAgent", "coderAgent"],
    ["executing -> coder", { currentPhase: "executing" }, "coderAgent", "analyzerAgent"],
    ["creating_mr -> finalize", { currentPhase: "creating_mr", worktreePath: "/wt" }, "finalizerAgent", "reviewerAgent"],
    ["fixing -> review loop", { currentPhase: "fixing", worktreePath: "/wt" }, "reviewerAgent", "coderAgent"],
  ] as const)("%s", async (_label, o, expected, notExpected) => {
    const { app } = createFakeApp();
    const s = seed({ analysis: makeAnalysis(), branchName: "fix/x", ...(o as any) });
    run("analyzerAgent").mockResolvedValue({ success: false, message: "x", analysis: null });
    run("coderAgent").mockResolvedValue({ success: false, message: "x" });
    reviewerSequence(false);
    finalizerSucceeds();
    await resumePipeline(app, s.taskId);
    expect(run(expected as any)).toHaveBeenCalled();
    expect(run(notExpected as any)).not.toHaveBeenCalled();
  });

  it("re-posts the plan for approval when resuming from analysis", async () => {
    const { app, client } = createFakeApp();
    const s = seed({ currentPhase: "analyzing" });
    analyzerSucceeds();
    await resumePipeline(app, s.taskId);
    expect(postMdToThread).toHaveBeenCalledWith(client, "DADMIN", "111.222", "Execution Plan", "PLAN-MD", s.taskId);
    expect(postedTexts(client).some((t) => t.includes("approve_plan"))).toBe(true);
  });

  it("only informs for awaiting_plan_approval and complete tasks", async () => {
    const { app, client } = createFakeApp();
    const a = seed({ currentPhase: "awaiting_plan_approval" });
    const c = seed({ currentPhase: "complete" });
    await resumePipeline(app, a.taskId);
    await resumePipeline(app, c.taskId);
    const texts = postedTexts(client).join("\n");
    expect(texts).toContain("is awaiting plan approval");
    expect(texts).toContain("is already complete");
    for (const k of ["analyzerAgent", "coderAgent", "reviewerAgent", "finalizerAgent"] as const) expect(run(k)).not.toHaveBeenCalled();
  });

  it("honours an explicit target phase", async () => {
    const { app } = createFakeApp();
    const s = seed({ currentPhase: "failed", worktreePath: "/wt", analysis: makeAnalysis(), branchName: "b" });
    run("coderAgent").mockResolvedValue({ success: false, message: "x" });
    await resumePipeline(app, s.taskId, "executing");
    expect(run("coderAgent")).toHaveBeenCalled();
  });

  it("returns without action for an unknown legacy phase", async () => {
    const { app, client } = createFakeApp();
    const s = makeState();
    insertLegacy(s as any, "some_future_phase");
    await resumePipeline(app, s.taskId);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("marks the task failed and reports when the resumed phase throws", async () => {
    const { app, client } = createFakeApp();
    const s = seed({ currentPhase: "executing", analysis: makeAnalysis(), branchName: "b" });
    run("coderAgent").mockRejectedValue(new Error("kaboom"));
    await resumePipeline(app, s.taskId);
    expect(getTask(s.taskId)?.currentPhase).toBe("failed");
    expect(postedTexts(client).some((t) => t.includes("Resume failed:* Error: kaboom"))).toBe(true);
  });

  // BUG (src/pipeline/coordinator.ts:427): runReviewLoop always allows maxIterations
  // *more* reviews regardless of reviewIterations already recorded, so a resumed task
  // can exceed MAX_REVIEW_ITERATIONS and posts labels like "Iteration 4/3".
  it.skip("BUG: resumed review loop respects iterations already performed", async () => {
    const { app } = createFakeApp();
    const prior = [1, 2, 3].map((i) => ({ content: "", mdPath: "", hasIssues: true, iteration: i }));
    const s = seed({ currentPhase: "reviewing", worktreePath: "/wt", analysis: makeAnalysis(), branchName: "b", reviewIterations: prior });
    reviewerSequence(true, true, true);
    fixerSucceeds();
    finalizerSucceeds();
    await resumePipeline(app, s.taskId);
    expect(run("reviewerAgent")).not.toHaveBeenCalled();
  });
});
