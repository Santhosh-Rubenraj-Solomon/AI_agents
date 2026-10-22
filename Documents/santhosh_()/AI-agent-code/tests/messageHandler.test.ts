import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/handlers/commands.js", () => ({ runAnalysis: vi.fn(async () => {}) }));
vi.mock("../src/agents/advisor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agents/advisor.js")>()),
  generateAdvisorResponse: vi.fn(),
}));

import { runAnalysis } from "../src/handlers/commands.js";
import { generateAdvisorResponse } from "../src/agents/advisor.js";
import { registerMessageHandler } from "../src/handlers/messageHandler.js";
import { createSession, getDb, getSessionById } from "../src/state/store.js";
import { createFakeBot, makeCtx, makeProfile, makeSessionRow, replies } from "./helpers.js";

beforeEach(() => {
  getDb().exec("DELETE FROM sessions");
  vi.clearAllMocks();
});

function handler() {
  const fb = createFakeBot();
  registerMessageHandler(fb.bot);
  return fb.on("text");
}

const history = (n: number) =>
  JSON.stringify(Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })));

describe("text message routing", () => {
  it("ignores slash commands", async () => {
    const ctx = makeCtx("/whatever");
    await handler()(ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it.each([
    ["https://github.com/acme/api", "https://github.com/acme/api"],
    ["please analyze https://github.com/acme/api.", "https://github.com/acme/api"],
    ["look: https://github.com/acme/api/tree/main!?", "https://github.com/acme/api/tree/main"],
  ])("auto-analyses GitHub URLs in %j", async (text, url) => {
    const ctx = makeCtx(text);
    await handler()(ctx);
    expect(runAnalysis).toHaveBeenCalledWith(ctx, url);
  });

  it("greets when there is no session", async () => {
    const ctx = makeCtx("hello", { chatId: 100 });
    await handler()(ctx);
    expect(replies(ctx)[0]).toMatch(/Send me a GitHub repository URL/);
    expect(runAnalysis).not.toHaveBeenCalled();
  });

  it("asks for a repo when the session has none", async () => {
    createSession(makeSessionRow({ chat_id: 101, repo_local_path: null }));
    const ctx = makeCtx("hello", { chatId: 101 });
    await handler()(ctx);
    expect(replies(ctx)[0]).toMatch(/No repo analyzed yet/);
  });

  it("reports corrupted session data", async () => {
    createSession(makeSessionRow({ chat_id: 102, analysis_json: "{bad" }));
    const ctx = makeCtx("hello", { chatId: 102 });
    await handler()(ctx);
    expect(replies(ctx)[0]).toMatch(/corrupted/);
    expect(generateAdvisorResponse).not.toHaveBeenCalled();
  });
});

describe("advisor conversation", () => {
  it("general questions: passes context, persists history, replies plainly", async () => {
    const row = makeSessionRow({ chat_id: 110 });
    createSession(row);
    let questionsAtCall: unknown;
    vi.mocked(generateAdvisorResponse).mockImplementation(async (c) => {
      questionsAtCall = structuredClone(c.questions); // handler mutates the array afterwards
      return "It is an API.";
    });
    const ctx = makeCtx("what is this?", { chatId: 110 });
    await handler()(ctx);

    expect(ctx.sendChatAction).toHaveBeenCalledWith("typing");
    const [context, msg, profile, analysis, repoPath] = vi.mocked(generateAdvisorResponse).mock.calls[0];
    expect(context).toMatchObject({ sessionId: row.session_id, taskType: "general", currentStep: 0, totalSteps: 1 });
    expect(questionsAtCall).toEqual([{ role: "user", content: "what is this?" }]);
    expect([msg, repoPath]).toEqual(["what is this?", row.repo_local_path]);
    expect(profile).toEqual(makeProfile());
    expect(analysis?.summary).toBe("An HTTP API");
    expect(ctx.reply).toHaveBeenCalledWith("It is an API.");

    const saved = getSessionById(row.session_id)!;
    expect(saved.current_phase).toBe("awaiting_input");
    expect(JSON.parse(saved.conversation_history)).toEqual([
      { role: "user", content: "what is this?" },
      { role: "assistant", content: "It is an API." },
    ]);
  });

  it("treats corrupt history as empty and passes null analysis when absent", async () => {
    createSession(makeSessionRow({ chat_id: 111, conversation_history: "garbage", analysis_json: null }));
    let n = -1;
    vi.mocked(generateAdvisorResponse).mockImplementation(async (c) => {
      n = c.questions.length;
      return "ok";
    });
    await handler()(makeCtx("q", { chatId: 111 }));
    const [, , , analysis] = vi.mocked(generateAdvisorResponse).mock.calls[0];
    expect(n).toBe(1);
    expect(analysis).toBeNull();
  });

  it("structured flows append the next question", async () => {
    createSession(makeSessionRow({ chat_id: 112, task_type: "bugfix", conversation_history: "[]" }));
    vi.mocked(generateAdvisorResponse).mockResolvedValue("Thanks.");
    const ctx = makeCtx("Login fails", { chatId: 112 });
    await handler()(ctx);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [text, extra] = ctx.reply.mock.calls[0];
    expect(text).toMatch(/^Thanks\.\n\n---\n\n\*Question 2\/5:\*\nCan you share the error message/);
    expect(extra).toEqual({ parse_mode: "Markdown" });
  });

  it("derives the step from history length (2 messages per step)", async () => {
    createSession(makeSessionRow({ chat_id: 113, task_type: "feature", conversation_history: history(4) }));
    vi.mocked(generateAdvisorResponse).mockResolvedValue("ok");
    const ctx = makeCtx("answer", { chatId: 113 });
    await handler()(ctx);
    expect(vi.mocked(generateAdvisorResponse).mock.calls[0][0].currentStep).toBe(2);
    expect(replies(ctx)[0]).toContain("*Question 4/5:*");
  });

  it("stops appending questions after the last one", async () => {
    createSession(makeSessionRow({ chat_id: 114, task_type: "architecture", conversation_history: history(4) }));
    vi.mocked(generateAdvisorResponse).mockResolvedValue("final answer");
    const ctx = makeCtx("answer", { chatId: 114 });
    await handler()(ctx);
    expect(ctx.reply).toHaveBeenCalledWith("final answer");
  });

  it("splits a long structured reply into answer + question messages", async () => {
    createSession(makeSessionRow({ chat_id: 115, task_type: "bugfix" }));
    vi.mocked(generateAdvisorResponse).mockResolvedValue("a".repeat(3990));
    const ctx = makeCtx("x", { chatId: 115 });
    await handler()(ctx);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(replies(ctx)[0]).toBe("a".repeat(3990));
    expect(replies(ctx)[1]).toMatch(/^\*Question 2\/5:\*/);
  });

  it("chunks long free-form replies at <=4000 chars, preferring newline/space boundaries", async () => {
    createSession(makeSessionRow({ chat_id: 116 }));
    const para = "word ".repeat(700); // 3500 chars
    const long = `${para}\n${para}\n${"x".repeat(9000)}`;
    vi.mocked(generateAdvisorResponse).mockResolvedValue(long);
    const ctx = makeCtx("x", { chatId: 116 });
    await handler()(ctx);
    const chunks = replies(ctx);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
    expect(chunks.join("")).toBe(long);
    expect(chunks[0]).toBe(para); // split at the newline
  });

  it("does not split a free-form reply of exactly 4000 chars", async () => {
    createSession(makeSessionRow({ chat_id: 117 }));
    vi.mocked(generateAdvisorResponse).mockResolvedValue("b".repeat(4000));
    const ctx = makeCtx("x", { chatId: 117 });
    await handler()(ctx);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });

  it("reports errors from the advisor", async () => {
    createSession(makeSessionRow({ chat_id: 118 }));
    vi.mocked(generateAdvisorResponse).mockRejectedValue(new Error("engine down"));
    const ctx = makeCtx("x", { chatId: 118 });
    await handler()(ctx);
    expect(replies(ctx)[0]).toMatch(/^❌ Error generating response: engine down/);
  });
});

describe("access control", () => {
  afterEach(() => {
    delete process.env.ALLOWED_USER_IDS;
    vi.resetModules();
  });

  it("silently ignores users not in ALLOWED_USER_IDS", async () => {
    process.env.ALLOWED_USER_IDS = "42";
    vi.resetModules();
    const mod = await import("../src/handlers/messageHandler.js");
    const fb = createFakeBot();
    mod.registerMessageHandler(fb.bot);
    const denied = makeCtx("https://github.com/a/b", { userId: 7 });
    await fb.on("text")(denied);
    expect(denied.reply).not.toHaveBeenCalled();
    const allowed = makeCtx("hello", { userId: 42, chatId: 999 });
    await fb.on("text")(allowed);
    expect(replies(allowed)[0]).toMatch(/Send me a GitHub repository URL/);
  });
});
