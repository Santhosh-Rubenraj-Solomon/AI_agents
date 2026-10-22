import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/pipeline/coordinator.js", () => ({
  executePlan: vi.fn(async () => {}),
  cancelPipeline: vi.fn(async () => {}),
  resumePipeline: vi.fn(async () => {}),
  startPipeline: vi.fn(async () => {}),
  isTaskRunning: vi.fn(() => false),
}));
vi.mock("../src/services/claudeAgent.js", () => ({ chat: vi.fn() }));

import { cancelPipeline, executePlan, isTaskRunning, resumePipeline } from "../src/pipeline/coordinator.js";
import { chat } from "../src/services/claudeAgent.js";
import { registerPlanApproval } from "../src/handlers/planApprovalHandler.js";
import { registerResumeCommand } from "../src/handlers/resumeHandler.js";
import { registerMessageHandler } from "../src/handlers/messageHandler.js";
import { registerAppHome } from "../src/handlers/appHomeHandler.js";
import { closeDb, createTask, getDb, getTask } from "../src/state/store.js";
import { createFakeApp, makeState } from "./helpers.js";

beforeEach(() => {
  closeDb();
  vi.clearAllMocks();
});

describe("plan approval buttons", () => {
  const click = (taskId: string | undefined, user = "UADMIN") => ({ ack: vi.fn(), body: { actions: [{ value: taskId }], user: { id: user } } });

  it("approve_plan posts an ack and starts execution for awaiting tasks", async () => {
    const { app, client, getAction } = createFakeApp();
    registerPlanApproval(app);
    const s = makeState({ currentPhase: "awaiting_plan_approval" });
    createTask(s);
    const args = click(s.taskId);
    await getAction("approve_plan")(args);
    expect(args.ack).toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: s.request.channelId,
      thread_ts: s.request.threadTs,
      text: ":thumbsup: Plan approved by <@UADMIN>. Starting execution...",
    });
    expect(executePlan).toHaveBeenCalledWith(s.taskId, app);
  });

  it("approve_plan still executes if the ack message fails", async () => {
    const { app, client, getAction } = createFakeApp();
    registerPlanApproval(app);
    client.chat.postMessage.mockRejectedValueOnce(new Error("x"));
    const s = makeState({ currentPhase: "awaiting_plan_approval" });
    createTask(s);
    await getAction("approve_plan")(click(s.taskId));
    expect(executePlan).toHaveBeenCalled();
  });

  it("ignores clicks for missing tasks, wrong phases or empty values", async () => {
    const { app, getAction } = createFakeApp();
    registerPlanApproval(app);
    const s = makeState({ currentPhase: "executing" });
    createTask(s);
    await getAction("approve_plan")(click(s.taskId));
    await getAction("approve_plan")(click("missing"));
    await getAction("approve_plan")(click(undefined));
    await getAction("reject_plan")(click(s.taskId));
    expect(executePlan).not.toHaveBeenCalled();
    expect(cancelPipeline).not.toHaveBeenCalled();
  });

  it("reject_plan cancels with the rejecting admin in the reason", async () => {
    const { app, getAction } = createFakeApp();
    registerPlanApproval(app);
    const s = makeState({ currentPhase: "awaiting_plan_approval" });
    createTask(s);
    await getAction("reject_plan")(click(s.taskId, "UADMIN"));
    expect(cancelPipeline).toHaveBeenCalledWith(s.taskId, app, "Plan rejected by <@UADMIN>. Pipeline cancelled.");
  });

  // Previously a BUG (planApprovalHandler had no clicker check, and the coordinator
  // mirrored the buttons into the requester's DM): a requester could approve their own plan.
  it("ignores approve_plan clicks from non-admin users and tells them why", async () => {
    const { app, client, getAction } = createFakeApp();
    registerPlanApproval(app);
    const s = makeState({ currentPhase: "awaiting_plan_approval" });
    createTask(s);
    const args = click(s.taskId, "UREQ") as any;
    args.body.channel = { id: "D_UREQ" };
    await getAction("approve_plan")(args);
    expect(args.ack).toHaveBeenCalled();
    expect(executePlan).not.toHaveBeenCalled();
    expect(getTask(s.taskId)?.currentPhase).toBe("awaiting_plan_approval");
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "D_UREQ",
      user: "UREQ",
      text: expect.stringContaining("Only the admin can approve"),
    });
  });

  it("ignores reject_plan clicks from non-admin users", async () => {
    const { app, getAction } = createFakeApp();
    registerPlanApproval(app);
    const s = makeState({ currentPhase: "awaiting_plan_approval" });
    createTask(s);
    await getAction("reject_plan")(click(s.taskId, "UREQ"));
    expect(cancelPipeline).not.toHaveBeenCalled();
    expect(getTask(s.taskId)?.currentPhase).toBe("awaiting_plan_approval");
  });

  it("a double-clicked approve_plan starts execution only once", async () => {
    const { app, getAction } = createFakeApp();
    registerPlanApproval(app);
    const s = makeState({ currentPhase: "awaiting_plan_approval" });
    createTask(s);
    await Promise.all([getAction("approve_plan")(click(s.taskId)), getAction("approve_plan")(click(s.taskId))]);
    expect(executePlan).toHaveBeenCalledTimes(1);
    expect(getTask(s.taskId)?.currentPhase).toBe("executing");
  });
});

describe("/ecr-resume", () => {
  const cmd = (text: string, user = "UADMIN") => ({ command: { user_id: user, text }, ack: vi.fn(), respond: vi.fn() });

  function insertRaw(id: string, phase: string, extra: Record<string, unknown> = {}) {
    const state = { ...makeState({ taskId: id }), currentPhase: phase, ...extra };
    getDb()
      .prepare("INSERT INTO tasks VALUES (?, ?, ?, 'U', 'C', '1', ?, 1, ?)")
      .run(id, JSON.stringify(state), phase, (extra.worktreePath as string) ?? null, (extra.updatedAt as number) ?? Date.now());
  }

  it("is admin-only", async () => {
    const { app, getCommand } = createFakeApp();
    registerResumeCommand(app);
    const c = cmd("abc", "UNOPE");
    await getCommand("/ecr-resume")(c);
    expect(c.respond).toHaveBeenCalledWith({ response_type: "ephemeral", text: "Only the admin can resume pipelines." });
    expect(resumePipeline).not.toHaveBeenCalled();
  });

  it("reports unknown and terminal tasks", async () => {
    const { app, getCommand } = createFakeApp();
    registerResumeCommand(app);
    insertRaw("done1", "complete");
    insertRaw("canc1", "cancelled");
    for (const [id, re] of [["nope", /not found/], ["done1", /cannot be resumed/], ["canc1", /cannot be resumed/]] as const) {
      const c = cmd(` ${id} `);
      await getCommand("/ecr-resume")(c);
      expect(c.respond.mock.calls[0][0].text).toMatch(re);
    }
    expect(resumePipeline).not.toHaveBeenCalled();
  });

  it("refuses to resume a task that is still running in this process", async () => {
    const { app, getCommand } = createFakeApp();
    registerResumeCommand(app);
    insertRaw("run1", "reviewing");
    vi.mocked(isTaskRunning).mockReturnValueOnce(true);
    const c = cmd("run1");
    await getCommand("/ecr-resume")(c);
    expect(c.respond.mock.calls[0][0].text).toMatch(/still running/);
    expect(resumePipeline).not.toHaveBeenCalled();
  });

  it("refuses when a required worktree is missing on disk", async () => {
    const { app, getCommand } = createFakeApp();
    registerResumeCommand(app);
    insertRaw("rev1", "reviewing", { worktreePath: "/definitely/missing/wt" });
    const c = cmd("rev1");
    await getCommand("/ecr-resume")(c);
    expect(c.respond.mock.calls[0][0].text).toMatch(/no longer exists/);
    expect(resumePipeline).not.toHaveBeenCalled();
  });

  it("resumes directly with a description of the target (legacy + failed inference)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ecr-res-"));
    try {
      const { app, getCommand } = createFakeApp();
      registerResumeCommand(app);
      insertRaw("leg1", "awaiting_review_approval", { worktreePath: dir });
      insertRaw("fail1", "failed", { worktreePath: dir, reviewIterations: [{}] });
      insertRaw("fail2", "failed");

      const expectations: Array<[string, RegExp]> = [
        ["leg1", /Awaiting Review Approval \(legacy\)[\s\S]*Will resume review loop \(Phase 3\)/],
        ["fail1", /Will resume finalize \(Phase 4 — review was already done before failure\)/],
        ["fail2", /Will restart from analysis \(Phase 1, from failed\)/],
      ];
      for (const [id, re] of expectations) {
        const c = cmd(id);
        await getCommand("/ecr-resume")(c);
        expect(c.respond.mock.calls[0][0].text).toMatch(re);
        expect(resumePipeline).toHaveBeenLastCalledWith(app, id);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists resumable tasks with resume buttons, warning about missing worktrees", async () => {
    const { app, getCommand } = createFakeApp();
    registerResumeCommand(app);
    insertRaw("ok1", "executing", { updatedAt: Date.now() - 5 * 60_000 });
    insertRaw("gone1", "reviewing", { worktreePath: "/missing/wt" });
    const c = cmd("");
    await getCommand("/ecr-resume")(c);
    const { text, blocks } = c.respond.mock.calls[0][0];
    expect(text).toBe("Found 2 resumable task(s).");
    const sections = blocks.filter((b: any) => b.type === "section");
    const byId = (id: string) => sections.find((s: any) => s.text.text.includes(id));
    expect(byId("ok1").accessory).toMatchObject({ action_id: "resume_task_ok1", value: "ok1" });
    expect(byId("ok1").text.text).toContain("5 minutes ago");
    expect(byId("gone1").accessory).toBeUndefined();
    expect(byId("gone1").text.text).toContain("*Worktree:* MISSING");
    expect(JSON.stringify(blocks)).toContain("Worktree missing at `/missing/wt`");
  });

  it("says so when nothing is resumable", async () => {
    const { app, getCommand } = createFakeApp();
    registerResumeCommand(app);
    const c = cmd("   ");
    await getCommand("/ecr-resume")(c);
    expect(c.respond.mock.calls[0][0].text).toMatch(/No resumable tasks found/);
  });

  it("resume_task_* buttons are admin-only and kick off resume", async () => {
    const { app, client, getAction } = createFakeApp();
    registerResumeCommand(app);
    const handler = getAction("resume_task_abc123");
    await handler({ ack: vi.fn(), body: { user: { id: "UOTHER" } }, action: { action_id: "resume_task_abc123" } });
    expect(resumePipeline).not.toHaveBeenCalled();

    await handler({ ack: vi.fn(), body: { user: { id: "UADMIN" }, channel: { id: "C1" } }, action: { action_id: "resume_task_abc123" } });
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1", user: "UADMIN" }));
    expect(resumePipeline).toHaveBeenCalledWith(app, "abc123");
  });
});

describe("message handler", () => {
  const dm = (event: Record<string, unknown>) => ({ event: { channel_type: "im", user: "U1", text: "hi", ...event }, say: vi.fn() });

  it("answers DMs via chat()", async () => {
    const { app, getEvent } = createFakeApp();
    registerMessageHandler(app);
    vi.mocked(chat).mockResolvedValue("hello back");
    const a = dm({ text: "what is ECR?" });
    await getEvent("message")(a);
    expect(chat).toHaveBeenCalledWith("what is ECR?");
    expect(a.say).toHaveBeenCalledWith("hello back");
  });

  it.each([
    ["non-IM channel", { channel_type: "channel" }],
    ["subtype message", { subtype: "message_changed" }],
    ["no text", { text: undefined }],
    ["slash text", { text: "/ecr" }],
    ["no user", { user: undefined }],
  ])("ignores %s", async (_l, ev) => {
    const { app, getEvent } = createFakeApp();
    registerMessageHandler(app);
    const a = dm(ev);
    await getEvent("message")(a);
    expect(chat).not.toHaveBeenCalled();
    expect(a.say).not.toHaveBeenCalled();
  });

  it("truncates long responses at 3900 chars and apologises on errors", async () => {
    const { app, getEvent } = createFakeApp();
    registerMessageHandler(app);
    vi.mocked(chat).mockResolvedValueOnce("z".repeat(5000)).mockRejectedValueOnce(new Error("timeout"));
    const a = dm({});
    await getEvent("message")(a);
    expect(a.say.mock.calls[0][0]).toBe("z".repeat(3900) + "\n\n_...response truncated_");
    const b = dm({});
    await getEvent("message")(b);
    expect(b.say.mock.calls[0][0]).toMatch(/^Sorry, I ran into an error/);
  });

  it("does not truncate a response of exactly 3900 chars", async () => {
    const { app, getEvent } = createFakeApp();
    registerMessageHandler(app);
    vi.mocked(chat).mockResolvedValueOnce("q".repeat(3900));
    const a = dm({});
    await getEvent("message")(a);
    expect(a.say.mock.calls[0][0]).toHaveLength(3900);
  });

  it("allows only one in-flight question per user", async () => {
    const { app, getEvent } = createFakeApp();
    registerMessageHandler(app);
    let release!: (v: string) => void;
    vi.mocked(chat).mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const first = dm({ text: "q1" });
    const p1 = getEvent("message")(first);
    const second = dm({ text: "q2" });
    await getEvent("message")(second);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(second.say.mock.calls[0][0]).toMatch(/still working on your previous question/);

    release("a1");
    await p1;
    expect(first.say).toHaveBeenCalledWith("a1");

    // the user is free again afterwards (also after errors)
    vi.mocked(chat).mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce("a3");
    await getEvent("message")(dm({ text: "q3" }));
    const fourth = dm({ text: "q4" });
    await getEvent("message")(fourth);
    expect(fourth.say).toHaveBeenCalledWith("a3");
  });

  it("app_mention strips mentions and replies in thread", async () => {
    const { app, getEvent } = createFakeApp();
    registerMessageHandler(app);
    vi.mocked(chat).mockResolvedValue("answer");
    const say = vi.fn();
    await getEvent("app_mention")({ event: { text: "<@UBOT123> explain <@U999> flow", ts: "1.0", thread_ts: "0.5" }, say });
    expect(chat).toHaveBeenCalledWith("explain flow");
    expect(say).toHaveBeenCalledWith({ text: "answer", thread_ts: "0.5" });
  });

  it("app_mention greets on empty text and apologises in thread on error", async () => {
    const { app, getEvent } = createFakeApp();
    registerMessageHandler(app);
    const say = vi.fn();
    await getEvent("app_mention")({ event: { text: "<@UBOT>  ", ts: "1.0" }, say });
    expect(say).toHaveBeenCalledWith("Hey! Ask me anything about the ECR service.");

    vi.mocked(chat).mockRejectedValueOnce(new Error("x"));
    const say2 = vi.fn();
    await getEvent("app_mention")({ event: { text: "<@UBOT> q", ts: "2.0" }, say: say2 });
    expect(say2).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: "2.0", text: expect.stringMatching(/^Sorry/) }));
  });
});

describe("app home", () => {
  it("ignores non-home tabs", async () => {
    const { app, client, getEvent } = createFakeApp();
    registerAppHome(app);
    await getEvent("app_home_opened")({ event: { tab: "messages", user: "U1" }, client });
    expect(client.views.publish).not.toHaveBeenCalled();
  });

  it("publishes a home view listing active pipelines", async () => {
    const { app, client, getEvent } = createFakeApp();
    registerAppHome(app);
    await getEvent("app_home_opened")({ event: { tab: "home", user: "U1" }, client });
    expect(JSON.stringify(client.views.publish.mock.calls[0][0])).toContain("_No active pipelines._");

    createTask(makeState({ taskId: "act1", currentPhase: "executing", requesterId: "UREQ" }));
    createTask(makeState({ taskId: "act2", currentPhase: "reviewing" }));
    createTask(makeState({ taskId: "done1", currentPhase: "complete" }));
    await getEvent("app_home_opened")({ event: { tab: "home", user: "U1" }, client });
    const view = client.views.publish.mock.calls[1][0] as any;
    expect(view.user_id).toBe("U1");
    const status = view.view.blocks.at(-1).text.text;
    expect(status).toContain("*act1*");
    expect(status).toContain("Requested by: <@UREQ>");
    expect(status).toContain("Requested by: <@UADMIN>");
    expect(status).not.toContain("done1");
  });

  it("swallows publish errors", async () => {
    const { app, client, getEvent } = createFakeApp();
    registerAppHome(app);
    client.views.publish.mockRejectedValueOnce(new Error("invalid_blocks"));
    await expect(getEvent("app_home_opened")({ event: { tab: "home", user: "U1" }, client })).resolves.toBeUndefined();
  });
});
