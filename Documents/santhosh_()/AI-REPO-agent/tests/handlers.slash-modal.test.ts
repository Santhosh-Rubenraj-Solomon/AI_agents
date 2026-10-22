import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/pipeline/coordinator.js", () => ({
  startPipeline: vi.fn(async () => {}),
  executePlan: vi.fn(async () => {}),
  cancelPipeline: vi.fn(async () => {}),
  resumePipeline: vi.fn(async () => {}),
  isTaskRunning: vi.fn(() => false),
}));
vi.mock("../src/middleware/rateLimit.js", () => ({ checkRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })) }));
vi.mock("../src/utils/reviewerCache.js", () => ({ getReviewers: vi.fn(async () => null) }));

import { startPipeline } from "../src/pipeline/coordinator.js";
import { checkRateLimit } from "../src/middleware/rateLimit.js";
import { getReviewers } from "../src/utils/reviewerCache.js";
import { buildStep2Modal, registerSlashCommand } from "../src/handlers/slashCommandHandler.js";
import { registerModalSubmit, registerRequestApproval } from "../src/handlers/modalSubmitHandler.js";
import { closeDb, createPendingRequest, getPendingRequest } from "../src/state/store.js";
import { createFakeApp, flush } from "./helpers.js";

beforeEach(() => {
  closeDb();
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  vi.mocked(getReviewers).mockResolvedValue(null);
});

function blockIds(view: any): string[] {
  return view.blocks.map((b: any) => b.block_id).filter(Boolean);
}

describe("/ecr slash command", () => {
  const command = { user_id: "U1", channel_id: "C1", trigger_id: "trig" };

  it("opens the step-1 modal carrying the channel in private_metadata", async () => {
    const { app, client, getCommand } = createFakeApp();
    registerSlashCommand(app);
    const ack = vi.fn();
    const respond = vi.fn();
    await getCommand("/ecr")({ command, ack, respond });
    expect(ack).toHaveBeenCalled();
    const { trigger_id, view } = client.views.open.mock.calls[0][0];
    expect(trigger_id).toBe("trig");
    expect(view.callback_id).toBe("ecr_type_select");
    expect(JSON.parse(view.private_metadata)).toEqual({ channelId: "C1" });
    expect(blockIds(view)).toEqual(["type_block", "priority_block"]);
    expect(respond).not.toHaveBeenCalled();
  });

  it("responds ephemerally when rate limited", async () => {
    const { app, client, getCommand } = createFakeApp();
    registerSlashCommand(app);
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: false, retryAfterSeconds: 12 });
    const respond = vi.fn();
    await getCommand("/ecr")({ command, ack: vi.fn(), respond });
    expect(respond).toHaveBeenCalledWith({ response_type: "ephemeral", text: "Please wait 12s before submitting another task." });
    expect(client.views.open).not.toHaveBeenCalled();
  });

  it("reports modal open failures", async () => {
    const { app, client, getCommand } = createFakeApp();
    registerSlashCommand(app);
    client.views.open.mockRejectedValueOnce(new Error("expired_trigger_id"));
    const respond = vi.fn();
    await getCommand("/ecr")({ command, ack: vi.fn(), respond });
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ text: "Failed to open the task form. Please try again." }));
  });
});

describe("buildStep2Modal", () => {
  const common = ["title_block", "reviewer_block", "branch_block"];
  it.each([
    ["bugfix", ["problem_block", "solution_block"]],
    ["feature", ["feature_desc_block", "needs_endpoints_block", "num_endpoints_block", "gateway_header_block", "controller_header_block", "foreshore_expose_block", "foreshore_url_block", "foreshore_params_block", "foreshore_query_block"]],
    ["refactor", ["refactor_desc_block"]],
    ["documentation", ["docs_desc_block"]],
  ] as const)("renders type-specific fields for %s", (type, specific) => {
    const view = buildStep2Modal({ channelId: "C", type, priority: "low" });
    expect(view.callback_id).toBe("ecr_task_modal");
    expect(JSON.parse(view.private_metadata)).toEqual({ channelId: "C", type, priority: "low" });
    expect(blockIds(view)).toEqual([common[0], ...specific, common[1], common[2]]);
  });

  it("uses a multi_users_select without a reviewer list and a static select with one", () => {
    const fallback = buildStep2Modal({ channelId: "C", type: "bugfix", priority: "low" }, null) as any;
    expect(fallback.blocks.find((b: any) => b.block_id === "reviewer_block").element.type).toBe("multi_users_select");
    const empty = buildStep2Modal({ channelId: "C", type: "bugfix", priority: "low" }, []) as any;
    expect(empty.blocks.find((b: any) => b.block_id === "reviewer_block").element.type).toBe("multi_users_select");

    const view = buildStep2Modal({ channelId: "C", type: "bugfix", priority: "low" }, [
      { slackId: "U1", displayName: "Ann" },
    ]) as any;
    const el = view.blocks.find((b: any) => b.block_id === "reviewer_block").element;
    expect(el.type).toBe("multi_static_select");
    expect(el.options).toEqual([{ text: { type: "plain_text", text: "Ann" }, value: "U1" }]);
  });
});

// ─── Modal submissions ──────────────────────────────────────────────────────

function step2View(type: string, values: Record<string, any>, meta: any = { channelId: "CSRC", type, priority: "high" }) {
  return { private_metadata: JSON.stringify(meta), state: { values } };
}
const txt = (value: string | null) => ({ value });
const sel = (value: string) => ({ selected_option: { value } });

describe("step 1 submission (ecr_type_select)", () => {
  it("updates the modal to step 2 with the chosen type and priority", async () => {
    const { app, getView } = createFakeApp();
    registerModalSubmit(app);
    vi.mocked(getReviewers).mockResolvedValue([{ slackId: "U5", displayName: "Rev" }]);
    const ack = vi.fn();
    await getView("ecr_type_select")({
      ack,
      body: {},
      view: {
        private_metadata: JSON.stringify({ channelId: "C9" }),
        state: { values: { type_block: { task_type: sel("feature") }, priority_block: { task_priority: sel("critical") } } },
      },
    });
    const arg = ack.mock.calls[0][0];
    expect(arg.response_action).toBe("update");
    expect(JSON.parse(arg.view.private_metadata)).toEqual({ channelId: "C9", type: "feature", priority: "critical" });
    expect(JSON.stringify(arg.view)).toContain("multi_static_select");
  });

  it("defaults to bugfix/medium and acks plainly on bad metadata", async () => {
    const { app, getView } = createFakeApp();
    registerModalSubmit(app);
    const ack = vi.fn();
    await getView("ecr_type_select")({ ack, body: {}, view: { private_metadata: "{}", state: { values: {} } } });
    expect(JSON.parse(ack.mock.calls[0][0].view.private_metadata)).toMatchObject({ type: "bugfix", priority: "medium" });

    const ack2 = vi.fn();
    await getView("ecr_type_select")({ ack: ack2, body: {}, view: { private_metadata: "{not json", state: { values: {} } } });
    expect(ack2).toHaveBeenCalledWith();
  });
});

describe("step 2 submission (ecr_task_modal)", () => {
  const bugValues = (o: Record<string, any> = {}) => ({
    title_block: { task_title: txt("Fix the receipt") },
    problem_block: { problem_description: txt("Prints twice") },
    solution_block: { proposed_solution: txt("Add guard") },
    ...o,
  });

  async function submit(view: any, userId = "UADMIN") {
    const fake = createFakeApp();
    registerModalSubmit(fake.app);
    const ack = vi.fn();
    await fake.getView("ecr_task_modal")({ ack, body: { user: { id: userId } }, view });
    return { ...fake, ack };
  }

  it("rejects invalid branch names with an inline error", async () => {
    const { ack } = await submit(step2View("bugfix", bugValues({ branch_block: { branch_name: txt("bad branch!") } })));
    expect(ack).toHaveBeenCalledWith({ response_action: "errors", errors: { branch_block: expect.stringMatching(/may only contain/) } });
    expect(startPipeline).not.toHaveBeenCalled();
  });

  it("maps zod errors (e.g. short title) to block ids", async () => {
    const { ack } = await submit(step2View("bugfix", bugValues({ title_block: { task_title: txt("ab") } })));
    expect(ack).toHaveBeenCalledWith({ response_action: "errors", errors: { title_block: "Title must be at least 3 characters" } });
  });

  it("admin submissions skip approval and start the pipeline in the admin DM", async () => {
    const { ack, client } = await submit(
      step2View("bugfix", bugValues({ reviewer_block: { mr_reviewers: { selected_users: ["UR1", "UR2"] } } })),
      "UADMIN",
    );
    expect(ack).toHaveBeenCalledWith();
    expect(client.conversations.open).toHaveBeenCalledWith({ users: "UADMIN" });
    expect(client.chat.postMessage.mock.calls[0][0].channel).toBe("D_UADMIN");
    expect(startPipeline).toHaveBeenCalledTimes(1);
    const input = vi.mocked(startPipeline).mock.calls[0][1];
    expect(input).toMatchObject({
      type: "bugfix",
      title: "Fix the receipt",
      priority: "high",
      branchName: "fix/fix-the-receipt",
      reviewerSlackIds: ["UR1", "UR2"],
      userId: "UADMIN",
      channelId: "D_UADMIN",
      threadTs: expect.stringMatching(/^9000\./),
      problemDescription: "Prints twice",
      proposedSolution: "Add guard",
      description: "Problem: Prints twice\n\nProposed Solution: Add guard",
    });
  });

  it("does not start the pipeline if the admin DM cannot be opened", async () => {
    const fake = createFakeApp();
    fake.client.conversations.open.mockResolvedValueOnce({ ok: true, channel: undefined } as any);
    registerModalSubmit(fake.app);
    await fake.getView("ecr_task_modal")({ ack: vi.fn(), body: { user: { id: "UADMIN" } }, view: step2View("bugfix", bugValues()) });
    expect(startPipeline).not.toHaveBeenCalled();
  });

  it("non-admin submissions are routed to the admin with approve/reject buttons", async () => {
    const { client } = await submit(
      step2View("refactor", {
        title_block: { task_title: txt("Clean up reports") },
        refactor_desc_block: { refactor_description: txt("Merge methods") },
        reviewer_block: { mr_reviewers: { selected_options: [{ value: "UR9" }] } },
        branch_block: { branch_name: txt("refactor/reports") },
      }),
      "UREQ",
    );
    expect(startPipeline).not.toHaveBeenCalled();
    const msg = client.chat.postMessage.mock.calls[0][0] as any;
    expect(msg.channel).toBe("D_UADMIN");
    const buttons = msg.blocks.find((b: any) => b.type === "actions").elements;
    expect(buttons.map((b: any) => b.action_id)).toEqual(["approve_request", "reject_request"]);
    // The buttons carry only the stored request's ID ...
    const requestId = buttons[0].value;
    expect(buttons[1].value).toBe(requestId);
    // ... and the full validated request lives in SQLite.
    const stored = getPendingRequest(requestId)!;
    expect(stored).toMatchObject({ requesterId: "UREQ", status: "pending" });
    expect(stored.payload).toMatchObject({
      type: "refactor",
      title: "Clean up reports",
      branchName: "refactor/reports",
      reviewerSlackIds: ["UR9"],
      sourceChannelId: "CSRC",
      description: "Refactor: Merge methods",
    });
    // The requester is only told "submitted" after the admin has the request.
    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "CSRC", user: "UREQ", text: expect.stringContaining("has been submitted") }),
    );
  });

  it("tells the requester when routing to the admin fails", async () => {
    const fake = createFakeApp();
    fake.client.conversations.open.mockRejectedValueOnce(new Error("nope"));
    registerModalSubmit(fake.app);
    await fake.getView("ecr_task_modal")({ ack: vi.fn(), body: { user: { id: "UREQ" } }, view: step2View("bugfix", bugValues()) });
    const texts = fake.client.chat.postEphemeral.mock.calls.map((c: any) => c[0].text);
    expect(texts.at(-1)).toMatch(/Failed to route your request/);
  });

  it("parses feature endpoint details", async () => {
    await submit(
      step2View("feature", {
        title_block: { task_title: txt("Add tips") },
        feature_desc_block: { feature_description: txt("Tips summary") },
        needs_endpoints_block: { needs_endpoints: sel("yes") },
        num_endpoints_block: { num_endpoints: txt("2") },
        gateway_header_block: { gateway_header: txt("ecr-tips") },
        controller_header_block: { controller_header: txt(null) },
        foreshore_expose_block: { foreshore_expose: sel("yes") },
        foreshore_url_block: { foreshore_url: txt("/ecr/tips/:id") },
        foreshore_params_block: { foreshore_params: txt(" id , storeId,, ") },
        foreshore_query_block: { foreshore_query_params: txt("") },
      }),
    );
    const input = vi.mocked(startPipeline).mock.calls[0][1];
    expect(input.needsNewEndpoints).toBe(true);
    expect(input.endpointDetails).toEqual({
      numberOfEndpoints: 2,
      gatewayHeaderName: "ecr-tips",
      exposeOnForeshore: true,
      foreshoreUrl: "/ecr/tips/:id",
      foreshoreParams: ["id", "storeId"],
    });
    expect(input.description).toContain("- Number of endpoints: 2");
    expect(input.description).toContain("- Foreshore params: id, storeId");
    expect(input.branchName).toBe("feat/add-tips");
  });

  it("omits endpoint details when no new endpoints are needed", async () => {
    await submit(
      step2View("feature", {
        title_block: { task_title: txt("Add tips") },
        feature_desc_block: { feature_description: txt("Tips") },
        needs_endpoints_block: { needs_endpoints: sel("no") },
        num_endpoints_block: { num_endpoints: txt("3") },
      }),
    );
    const input = vi.mocked(startPipeline).mock.calls[0][1];
    expect(input.endpointDetails).toBeUndefined();
    expect(input.description).toBe("Feature: Tips");
  });

  // Previously a BUG: zod issues on fields that are not in blockMap (e.g.
  // endpointDetails.numberOfEndpoints > 20) produced no Slack errors, so the handler
  // fell through and started the pipeline with the *unvalidated* input.
  it("rejects numberOfEndpoints above the schema max instead of proceeding", async () => {
    const { ack } = await submit(
      step2View("feature", {
        title_block: { task_title: txt("Add tips") },
        feature_desc_block: { feature_description: txt("Tips") },
        needs_endpoints_block: { needs_endpoints: sel("yes") },
        num_endpoints_block: { num_endpoints: txt("25") },
      }),
    );
    expect(ack).toHaveBeenCalledWith({ response_action: "errors", errors: { num_endpoints_block: expect.any(String) } });
    expect(startPipeline).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric number of endpoints", async () => {
    const { ack } = await submit(
      step2View("feature", {
        title_block: { task_title: txt("Add tips") },
        feature_desc_block: { feature_description: txt("Tips") },
        needs_endpoints_block: { needs_endpoints: sel("yes") },
        num_endpoints_block: { num_endpoints: txt("two") },
      }),
    );
    expect(ack).toHaveBeenCalledWith({
      response_action: "errors",
      errors: { num_endpoints_block: expect.stringMatching(/whole number/) },
    });
    expect(startPipeline).not.toHaveBeenCalled();
  });

  it("surfaces errors for fields without a block (e.g. bad metadata type) on the title block", async () => {
    const { ack, client } = await submit(
      step2View("bugfix", bugValues(), { channelId: "CSRC", type: "bugfix", priority: "urgent!!" }),
    );
    expect(ack).toHaveBeenCalledWith({
      response_action: "errors",
      errors: { title_block: expect.stringMatching(/^Invalid priority:/) },
    });
    expect(startPipeline).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("rejects branch names git would misparse (leading hyphen)", async () => {
    const { ack } = await submit(step2View("bugfix", bugValues({ branch_block: { branch_name: txt("--mirror") } })));
    expect(ack).toHaveBeenCalledWith({ response_action: "errors", errors: { branch_block: expect.stringMatching(/hyphen/) } });
    expect(startPipeline).not.toHaveBeenCalled();
  });

  // Previously a BUG: the whole request was serialised into the approve_request button
  // value. Slack caps button values at 2000 chars, so long requests made
  // chat.postMessage fail and the requester (already told "submitted") never heard back.
  it("keeps the approve_request button value within Slack's 2000-char limit", async () => {
    const long = "x".repeat(5000);
    const { client } = await submit(
      step2View("bugfix", bugValues({ problem_block: { problem_description: txt(long) } })),
      "UREQ",
    );
    const msg = client.chat.postMessage.mock.calls[0][0] as any;
    const value = msg.blocks.find((b: any) => b.type === "actions").elements[0].value;
    expect(value.length).toBeLessThanOrEqual(2000);
    // Section text is capped below Slack's 3000-char limit, but nothing is lost.
    const section = msg.blocks.find((b: any) => b.type === "section");
    expect(section.text.text.length).toBeLessThanOrEqual(3000);
    expect(getPendingRequest(value)!.payload.problemDescription).toBe(long);
  });

  it("tells the requester (and does not claim success) when posting to the admin fails", async () => {
    const fake = createFakeApp();
    fake.client.chat.postMessage.mockRejectedValueOnce(new Error("invalid_blocks"));
    registerModalSubmit(fake.app);
    await fake.getView("ecr_task_modal")({ ack: vi.fn(), body: { user: { id: "UREQ" } }, view: step2View("bugfix", bugValues()) });
    const texts = fake.client.chat.postEphemeral.mock.calls.map((c: any) => c[0].text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/Failed to route your request.*invalid_blocks/);
  });

  it("falls back to a DM when the ephemeral notice cannot be posted", async () => {
    const fake = createFakeApp();
    fake.client.chat.postEphemeral.mockRejectedValue(new Error("not_in_channel"));
    registerModalSubmit(fake.app);
    await fake.getView("ecr_task_modal")({ ack: vi.fn(), body: { user: { id: "UREQ" } }, view: step2View("bugfix", bugValues()) });
    const dm = fake.client.chat.postMessage.mock.calls.map((c: any) => c[0]).find((m: any) => m.channel === "D_UREQ");
    expect(dm?.text).toMatch(/has been submitted/);
  });

  it("tells the admin when their own request cannot be started", async () => {
    const fake = createFakeApp();
    fake.client.chat.postMessage.mockRejectedValueOnce(new Error("channel_not_found"));
    registerModalSubmit(fake.app);
    await fake.getView("ecr_task_modal")({ ack: vi.fn(), body: { user: { id: "UADMIN" } }, view: step2View("bugfix", bugValues()) });
    expect(startPipeline).not.toHaveBeenCalled();
    const texts = fake.client.chat.postEphemeral.mock.calls.map((c: any) => c[0].text);
    expect(texts.at(-1)).toMatch(/Could not start the pipeline.*channel_not_found/);
  });
});

describe("admin approve/reject request buttons", () => {
  const validPayload = {
    type: "bugfix",
    title: "T title",
    description: "d",
    priority: "low",
    branchName: "fix/t",
    reviewerSlackIds: ["UR"],
    problemDescription: "p",
    sourceChannelId: "CSRC",
  };
  const click = (value: unknown, user = "UADMIN", extra: Record<string, unknown> = { channel: { id: "DADM" }, message: { ts: "5.5" } }) => ({
    ack: vi.fn(),
    body: { actions: [{ value }], user: { id: user }, ...extra },
  });

  it("approve_request starts the pipeline in the admin DM thread with all fields", async () => {
    const { app, client, getAction } = createFakeApp();
    registerRequestApproval(app);
    createPendingRequest("req-1", "UREQ", validPayload);
    await getAction("approve_request")(click("req-1"));
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "DADM", thread_ts: "5.5" }));
    expect(vi.mocked(startPipeline).mock.calls[0][1]).toMatchObject({
      type: "bugfix",
      title: "T title",
      userId: "UADMIN",
      channelId: "DADM",
      threadTs: "5.5",
      requesterId: "UREQ",
      problemDescription: "p",
      reviewerSlackIds: ["UR"],
    });
    expect(getPendingRequest("req-1")?.status).toBe("approved");
  });

  it("approve_request only starts one pipeline on a double click", async () => {
    const { app, client, getAction } = createFakeApp();
    registerRequestApproval(app);
    createPendingRequest("req-2", "UREQ", validPayload);
    await getAction("approve_request")(click("req-2"));
    await getAction("approve_request")(click("req-2"));
    expect(startPipeline).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(client.chat.postMessage.mock.calls)).toContain("already approved");
  });

  it("approve_request refuses non-admin clickers", async () => {
    const { app, client, getAction } = createFakeApp();
    registerRequestApproval(app);
    createPendingRequest("req-3", "UREQ", validPayload);
    await getAction("approve_request")(click("req-3", "UREQ"));
    expect(startPipeline).not.toHaveBeenCalled();
    expect(getPendingRequest("req-3")?.status).toBe("pending");
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ user: "UREQ", text: expect.stringContaining("Only the admin") }),
    );
  });

  it("approve_request ignores unknown ids, missing values and missing thread coordinates", async () => {
    const { app, client, getAction } = createFakeApp();
    registerRequestApproval(app);
    const approve = getAction("approve_request");
    await approve(click("does-not-exist"));
    expect(JSON.stringify(client.chat.postMessage.mock.calls)).toContain("no longer available");
    await approve(click(undefined));
    createPendingRequest("req-4", "UREQ", validPayload);
    await approve(click("req-4", "UADMIN", {})); // no channel/ts
    expect(startPipeline).not.toHaveBeenCalled();
    expect(getPendingRequest("req-4")?.status).toBe("pending");
  });

  it("approve_request re-validates the stored request and refuses invalid ones", async () => {
    const { app, getAction } = createFakeApp();
    registerRequestApproval(app);
    createPendingRequest("req-5", "UREQ", { ...validPayload, title: "x" });
    await getAction("approve_request")(click("req-5"));
    expect(startPipeline).not.toHaveBeenCalled();
    expect(getPendingRequest("req-5")?.status).toBe("failed");
  });

  it("reject_request posts in the admin thread and DMs the requester", async () => {
    const { app, client, getAction } = createFakeApp();
    registerRequestApproval(app);
    createPendingRequest("req-6", "UREQ", { ...validPayload, title: "T" });
    await getAction("reject_request")(click("req-6"));
    await flush();
    const calls = client.chat.postMessage.mock.calls.map((c: any) => c[0]);
    expect(calls[0]).toMatchObject({ channel: "DADM", thread_ts: "5.5", text: expect.stringContaining("rejected") });
    expect(client.conversations.open).toHaveBeenCalledWith({ users: "UREQ" });
    expect(calls[1]).toMatchObject({ channel: "D_UREQ", text: expect.stringContaining("was not approved") });
    expect(startPipeline).not.toHaveBeenCalled();
    expect(getPendingRequest("req-6")?.status).toBe("rejected");
  });

  it("reject_request refuses non-admin clickers", async () => {
    const { app, getAction } = createFakeApp();
    registerRequestApproval(app);
    createPendingRequest("req-7", "UREQ", validPayload);
    await getAction("reject_request")(click("req-7", "UREQ"));
    expect(getPendingRequest("req-7")?.status).toBe("pending");
  });
});
