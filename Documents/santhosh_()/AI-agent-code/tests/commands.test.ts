import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/github.js", () => ({ cloneOrPullRepo: vi.fn() }));
vi.mock("../src/services/techDetector.js", () => ({
  detectTechProfile: vi.fn(),
  getFileTree: vi.fn(() => ""),
  readRepoFile: vi.fn(() => null),
}));
vi.mock("../src/agents/analyzer.js", () => ({ analyzeCodebase: vi.fn() }));
vi.mock("../src/agents/breakingChange.js", () => ({ detectBreakingChanges: vi.fn() }));
vi.mock("../src/services/aiEngine.js", () => ({ askAI: vi.fn(), chatAI: vi.fn() }));

import { cloneOrPullRepo } from "../src/services/github.js";
import { detectTechProfile } from "../src/services/techDetector.js";
import { analyzeCodebase } from "../src/agents/analyzer.js";
import { detectBreakingChanges } from "../src/agents/breakingChange.js";
import { chatAI } from "../src/services/aiEngine.js";
import { registerCommands, runAnalysis } from "../src/handlers/commands.js";
import { createSession, getDb, getSession, getSessionById } from "../src/state/store.js";
import { createFakeBot, makeAnalysis, makeCtx, makeProfile, makeSessionRow, replies } from "./helpers.js";

const repoInfo = { owner: "acme", name: "api", url: "https://github.com/acme/api", localPath: "/tmp/repos/acme/api", defaultBranch: "main" };

beforeEach(() => {
  getDb().exec("DELETE FROM sessions");
  vi.clearAllMocks();
  vi.mocked(cloneOrPullRepo).mockResolvedValue(repoInfo);
  vi.mocked(detectTechProfile).mockReturnValue(makeProfile());
  vi.mocked(analyzeCodebase).mockResolvedValue({ success: true, message: "ok", data: makeAnalysis() });
});

function setup() {
  const fb = createFakeBot();
  registerCommands(fb.bot);
  return fb;
}

describe("registration", () => {
  it("registers all documented commands", () => {
    const fb = setup();
    expect(fb.commandNames().sort()).toEqual(
      ["analyze", "architecture", "breaking", "bugfix", "feature", "profile", "reset", "summary"].sort(),
    );
    expect(fb.start()).toBeTypeOf("function");
    expect(fb.help()).toBeTypeOf("function");
  });

  it("/start and /help reply with Markdown text", async () => {
    const fb = setup();
    const c1 = makeCtx("/start");
    await fb.start()(c1);
    expect(replies(c1)[0]).toContain("AI Code Analyzer");
    expect(c1.reply.mock.calls[0][1]).toEqual({ parse_mode: "Markdown" });
    const c2 = makeCtx("/help");
    await fb.help()(c2);
    expect(replies(c2)[0]).toContain("/breaking [commits]");
  });
});

describe("/analyze and runAnalysis", () => {
  it.each(["/analyze", "/analyze https://gitlab.com/a/b"])("shows usage for %j", async (text) => {
    const fb = setup();
    const ctx = makeCtx(text);
    await fb.command("analyze")(ctx);
    expect(replies(ctx)[0]).toMatch(/^Usage: \/analyze <github-url>/);
    expect(cloneOrPullRepo).not.toHaveBeenCalled();
  });

  it("clones, profiles, analyses and persists a new session", async () => {
    const fb = setup();
    const ctx = makeCtx("/analyze https://github.com/acme/api", { chatId: 77, userId: 5 });
    await fb.command("analyze")(ctx);

    expect(cloneOrPullRepo).toHaveBeenCalledWith("https://github.com/acme/api");
    expect(detectTechProfile).toHaveBeenCalledWith("/tmp/repos/acme/api");
    expect(analyzeCodebase).toHaveBeenCalledWith("/tmp/repos/acme/api", makeProfile());
    const s = getSession(77)!;
    expect(s).toMatchObject({
      chat_id: 77,
      user_id: 5,
      repo_url: "https://github.com/acme/api",
      repo_local_path: "/tmp/repos/acme/api",
      current_phase: "idle",
      task_type: null,
      conversation_history: "[]",
    });
    expect(s.session_id).toHaveLength(12);
    expect(JSON.parse(s.profile_json!)).toEqual(makeProfile());
    expect(JSON.parse(s.analysis_json!)).toEqual(makeAnalysis());

    const r = replies(ctx);
    expect(r[0]).toContain("Cloning repository");
    expect(r[1]).toContain("Repository cloned: `acme/api` (branch: main)");
    expect(r.some((t) => t.includes("*Tech Profile*") && t.includes("Express"))).toBe(true);
    expect(r.some((t) => t.includes("*Deep Analysis*") && t.includes("`src/user.ts` — UserService (service): users"))).toBe(true);
    expect(r.at(-1)).toContain("Analysis Complete!");
  });

  it("re-uses and resets an existing chat session", async () => {
    const existing = makeSessionRow({ chat_id: 9, task_type: "bugfix", conversation_history: '[{"role":"user","content":"x"}]' });
    createSession(existing);
    await runAnalysis(makeCtx("", { chatId: 9 }) as any, "https://github.com/acme/api");
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM sessions WHERE chat_id = 9").get() as { n: number };
    expect(rows.n).toBe(1);
    expect(getSessionById(existing.session_id)).toMatchObject({ task_type: null, conversation_history: "[]", current_phase: "idle" });
  });

  it("keeps the profile when AI analysis fails", async () => {
    vi.mocked(analyzeCodebase).mockResolvedValue({ success: false, message: "Analysis failed: timeout", error: "timeout" });
    const ctx = makeCtx("", { chatId: 3 });
    await runAnalysis(ctx as any, "https://github.com/acme/api");
    expect(replies(ctx).at(-1)).toMatch(/AI analysis partially failed: Analysis failed: timeout/);
    expect(getSession(3)).toMatchObject({ current_phase: "idle", analysis_json: null });
    expect(getSession(3)?.profile_json).toBeTruthy();
  });

  it("reports clone failures without creating a session", async () => {
    vi.mocked(cloneOrPullRepo).mockRejectedValue(new Error("Invalid GitHub URL: x"));
    const ctx = makeCtx("", { chatId: 4 });
    await runAnalysis(ctx as any, "x");
    expect(replies(ctx).at(-1)).toBe("❌ Failed: Invalid GitHub URL: x");
    expect(getSession(4)).toBeFalsy();
  });

  it("does nothing without chat/from context", async () => {
    const ctx = makeCtx("", { noChat: true });
    await runAnalysis(ctx as any, "https://github.com/a/b");
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe("/profile", () => {
  it("requires an analysed repo, renders the profile, and handles corrupt data", async () => {
    const fb = setup();
    const c1 = makeCtx("/profile", { chatId: 20 });
    await fb.command("profile")(c1);
    expect(replies(c1)[0]).toMatch(/No repo analyzed yet/);

    createSession(makeSessionRow({ chat_id: 21 }));
    const c2 = makeCtx("/profile", { chatId: 21 });
    await fb.command("profile")(c2);
    expect(replies(c2)[0]).toContain("🏗 *Architecture:* Layered (Routes + Middleware)");
    expect(replies(c2)[0]).toContain("TypeScript: 100% (3 files)");

    createSession(makeSessionRow({ chat_id: 22, profile_json: "{oops" }));
    const c3 = makeCtx("/profile", { chatId: 22 });
    await fb.command("profile")(c3);
    expect(replies(c3)[0]).toMatch(/corrupted/);
  });
});

describe("/breaking", () => {
  const result = {
    riskLevel: "BREAKING" as const,
    changeType: ["API" as const, "Database" as const],
    affectedConsumers: ["web", "mobile"],
    findings: [
      { file: "a.ts", change: "removed field", breaking: true, impact: "clients" },
      { file: "b.ts", change: "added optional", breaking: false, impact: "none" },
    ],
    recommendations: ["deprecate first"],
    checklist: {
      dtosChecked: true, enumsChecked: false, typesChecked: true, defaultsChecked: true,
      databaseChecked: true, messagesChecked: true, consumersChecked: true, rollbackChecked: false,
    },
  };

  it("requires an analysed repo", async () => {
    const fb = setup();
    const ctx = makeCtx("/breaking", { chatId: 30 });
    await fb.command("breaking")(ctx);
    expect(replies(ctx)[0]).toMatch(/No repo analyzed yet/);
    expect(detectBreakingChanges).not.toHaveBeenCalled();
  });

  it.each([
    ["/breaking", 5],
    ["/breaking 3", 3],
    ["/breaking abc", 5],
    ["/breaking 0", 5],
  ])("%s analyses %i commits", async (text, n) => {
    const fb = setup();
    createSession(makeSessionRow({ chat_id: 31 }));
    vi.mocked(detectBreakingChanges).mockResolvedValue({ success: true, message: "", data: result });
    const ctx = makeCtx(text, { chatId: 31 });
    await fb.command("breaking")(ctx);
    expect(vi.mocked(detectBreakingChanges).mock.calls[0][2]).toBe(n);
    expect(replies(ctx)[0]).toBe(`🔍 Analyzing last ${n} commits for breaking changes...`);
  });

  it("formats risk, findings, recommendations and the checklist", async () => {
    const fb = setup();
    createSession(makeSessionRow({ chat_id: 32 }));
    vi.mocked(detectBreakingChanges).mockResolvedValue({ success: true, message: "", data: result });
    const ctx = makeCtx("/breaking", { chatId: 32 });
    await fb.command("breaking")(ctx);
    const msg = replies(ctx)[1];
    expect(msg.startsWith("🔴 *Breaking Change Analysis*")).toBe(true);
    expect(msg).toContain("*Change Types:* API, Database");
    expect(msg).toContain("*Affected Consumers:* web, mobile");
    expect(msg).toContain("🔴 `a.ts`: removed field\n   Impact: clients");
    expect(msg).toContain("🟢 `b.ts`: added optional");
    expect(msg).toContain("• deprecate first");
    expect(msg).toContain("✅ DTOs checked\n❌ Enums checked");
    expect(msg.endsWith("❌ Rollback checked")).toBe(true);
  });

  it.each([
    ["HIGH", "🟠"],
    ["MEDIUM", "🟡"],
    ["LOW", "🟢"],
  ] as const)("uses the %s emoji", async (riskLevel, emoji) => {
    const fb = setup();
    createSession(makeSessionRow({ chat_id: 33 }));
    vi.mocked(detectBreakingChanges).mockResolvedValue({
      success: true,
      message: "",
      data: { ...result, riskLevel, affectedConsumers: [], findings: [], recommendations: [] },
    });
    const ctx = makeCtx("/breaking", { chatId: 33 });
    await fb.command("breaking")(ctx);
    const msg = replies(ctx)[1];
    expect(msg.startsWith(emoji)).toBe(true);
    expect(msg).not.toContain("*Findings:*");
    expect(msg).not.toContain("*Affected Consumers:*");
  });

  it("reports agent failures and exceptions", async () => {
    const fb = setup();
    createSession(makeSessionRow({ chat_id: 34 }));
    vi.mocked(detectBreakingChanges).mockResolvedValueOnce({ success: false, message: "Breaking change detection failed: x" });
    const c1 = makeCtx("/breaking", { chatId: 34 });
    await fb.command("breaking")(c1);
    expect(replies(c1)[1]).toBe("❌ Breaking change detection failed: x");

    vi.mocked(detectBreakingChanges).mockRejectedValueOnce(new Error("boom"));
    const c2 = makeCtx("/breaking", { chatId: 34 });
    await fb.command("breaking")(c2);
    expect(replies(c2)[1]).toBe("❌ Error: boom");
  });
});

describe("Q&A flow commands", () => {
  it.each([
    ["bugfix", "🐛 Bug Fix", 5],
    ["feature", "✨ Feature Implementation", 5],
    ["architecture", "🏗 Architecture Review", 3],
  ])("/%s starts the flow", async (cmd, label, total) => {
    const fb = setup();
    const row = makeSessionRow({ chat_id: 40, conversation_history: '[{"role":"user","content":"old"}]' });
    createSession(row);
    const ctx = makeCtx(`/${cmd}`, { chatId: 40 });
    await fb.command(cmd)(ctx);
    expect(replies(ctx)[0]).toContain(`${label} *Mode Activated*`);
    expect(replies(ctx)[0]).toContain(`*Question 1/${total}:*`);
    expect(getSessionById(row.session_id)).toMatchObject({ task_type: cmd, current_phase: "awaiting_input", conversation_history: "[]" });
  });

  it("requires a repo", async () => {
    const fb = setup();
    const ctx = makeCtx("/bugfix", { chatId: 41 });
    await fb.command("bugfix")(ctx);
    expect(replies(ctx)[0]).toMatch(/No repo analyzed yet/);
  });
});

describe("/summary", () => {
  it("handles missing session, empty history and missing profile", async () => {
    const fb = setup();
    const c1 = makeCtx("/summary", { chatId: 50 });
    await fb.command("summary")(c1);
    expect(replies(c1)[0]).toMatch(/No active session/);

    createSession(makeSessionRow({ chat_id: 51, conversation_history: "not json" }));
    const c2 = makeCtx("/summary", { chatId: 51 });
    await fb.command("summary")(c2);
    expect(replies(c2)[0]).toBe("No conversation history to summarize.");

    createSession(makeSessionRow({ chat_id: 52, profile_json: null, conversation_history: '[{"role":"user","content":"q"}]' }));
    const c3 = makeCtx("/summary", { chatId: 52 });
    await fb.command("summary")(c3);
    expect(replies(c3).at(-1)).toBe("Missing profile or repo data.");
  });

  it("generates a summary through the AI", async () => {
    const fb = setup();
    createSession(makeSessionRow({ chat_id: 53, task_type: "feature", conversation_history: '[{"role":"user","content":"add login"}]' }));
    vi.mocked(chatAI).mockResolvedValue("## Summary");
    const ctx = makeCtx("/summary", { chatId: 53 });
    await fb.command("summary")(ctx);
    expect(replies(ctx)).toEqual(["📝 Generating summary...", "## Summary"]);
    expect(vi.mocked(chatAI).mock.calls[0][0]).toContain("feature task for the project");
  });
});

describe("/reset", () => {
  it("deletes the chat session", async () => {
    const fb = setup();
    const row = makeSessionRow({ chat_id: 60 });
    createSession(row);
    const ctx = makeCtx("/reset", { chatId: 60 });
    await fb.command("reset")(ctx);
    expect(getSessionById(row.session_id)).toBeFalsy();
    expect(replies(ctx)[0]).toMatch(/Session cleared/);
    await fb.command("reset")(makeCtx("/reset", { chatId: 60 })); // no session: still fine
  });
});

describe("access control (ALLOWED_USER_IDS=42)", () => {
  afterEach(() => {
    delete process.env.ALLOWED_USER_IDS;
    vi.resetModules();
  });

  async function freshBot() {
    process.env.ALLOWED_USER_IDS = "42";
    vi.resetModules();
    const cmds = await import("../src/handlers/commands.js");
    const store = await import("../src/state/store.js");
    const fb = createFakeBot();
    cmds.registerCommands(fb.bot);
    return { fb, store };
  }

  it("blocks unlisted users and allows listed ones", async () => {
    const { fb } = await freshBot();
    const denied = makeCtx("/start", { userId: 7 });
    await fb.start()(denied);
    expect(replies(denied)[0]).toBe("⛔ You are not authorized to use this bot.");
    for (const cmd of ["analyze", "profile", "breaking", "bugfix", "summary"]) {
      const c = makeCtx(`/${cmd} https://github.com/a/b`, { userId: 7 });
      await fb.command(cmd)(c);
      expect(replies(c)[0]).toBe("⛔ Not authorized.");
    }
    const ok = makeCtx("/start", { userId: 42 });
    await fb.start()(ok);
    expect(replies(ok)[0]).toContain("AI Code Analyzer");
  });

  // BUG (src/handlers/commands.ts:373): /reset skips the isAllowed() check, so a
  // non-allow-listed user in a group chat can wipe the chat's session.
  it.skip("BUG: /reset is also restricted to allowed users", async () => {
    const { fb, store } = await freshBot();
    const row = makeSessionRow({ chat_id: 70 });
    store.createSession(row);
    const c = makeCtx("/reset", { userId: 7, chatId: 70 });
    await fb.command("reset")(c);
    expect(store.getSessionById(row.session_id)).toBeTruthy();
  });
});
