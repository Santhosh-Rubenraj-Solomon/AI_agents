import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/aiEngine.js", () => ({ askAI: vi.fn(), chatAI: vi.fn() }));
vi.mock("../src/services/github.js", () => ({
  getRecentDiff: vi.fn(),
  getChangedFiles: vi.fn(),
  getRecentCommits: vi.fn(),
}));

import { askAI, chatAI } from "../src/services/aiEngine.js";
import { getChangedFiles, getRecentCommits, getRecentDiff } from "../src/services/github.js";
import { analyzeCodebase } from "../src/agents/analyzer.js";
import { detectBreakingChanges } from "../src/agents/breakingChange.js";
import { generateAdvisorResponse, generateInitialQuestions, generateTaskSummary } from "../src/agents/advisor.js";
import type { ConversationContext } from "../src/schemas.js";
import { makeAnalysis, makeProfile, makeTree, rmTree } from "./helpers.js";

let repo: string;
beforeEach(() => {
  vi.clearAllMocks();
  repo = makeTree({
    "package.json": '{"name":"fixture"}',
    "src/index.ts": "export const main = 1;",
    "src/user.ts": "U".repeat(5000),
    "docker-compose.yml": "services: {}",
  });
});
afterEach(() => rmTree(repo));

describe("analyzeCodebase", () => {
  it("builds a prompt from profile, file tree and key files, and parses the result", async () => {
    vi.mocked(askAI).mockResolvedValue("```json\n" + JSON.stringify(makeAnalysis()) + "\n```");
    const res = await analyzeCodebase(repo, makeProfile({ entryPoints: ["src/index.ts", "missing.ts"] }));

    expect(res).toMatchObject({ success: true, message: "Analysis complete: 1 components, 1 models, 1 endpoints" });
    expect(res.data?.summary).toBe("An HTTP API");
    const [prompt, cwd] = vi.mocked(askAI).mock.calls[0];
    expect(cwd).toBe(repo);
    expect(prompt).toContain("- Languages: TypeScript (100%)");
    expect(prompt).toContain("- Frameworks: Express");
    expect(prompt).toContain("=== src/index.ts ===\nexport const main = 1;");
    expect(prompt).toContain('=== package.json ===\n{"name":"fixture"}');
    expect(prompt).toContain("=== docker-compose.yml ===");
    expect(prompt).not.toContain("=== missing.ts ===");
    expect(prompt).toContain("├── src/");
  });

  it("uses 'none detected' placeholders for empty profile lists", async () => {
    vi.mocked(askAI).mockResolvedValue(JSON.stringify(makeAnalysis()));
    await analyzeCodebase(repo, makeProfile({ frameworks: [], databases: [], buildTools: [], testFrameworks: [] }));
    const prompt = vi.mocked(askAI).mock.calls[0][0];
    expect(prompt).toContain("- Frameworks: none detected");
    expect(prompt).toContain("- Databases: none detected");
    expect(prompt).toContain("- Build Tools: none");
  });

  it("returns a failure result for unparseable or invalid AI output", async () => {
    vi.mocked(askAI).mockResolvedValueOnce("I could not analyze this");
    expect(await analyzeCodebase(repo, makeProfile())).toMatchObject({ success: false, error: expect.stringMatching(/Could not extract JSON/) });
    vi.mocked(askAI).mockResolvedValueOnce('{"summary":"x"}');
    expect((await analyzeCodebase(repo, makeProfile())).message).toMatch(/^Analysis failed: AI output failed schema validation/);
    vi.mocked(askAI).mockRejectedValueOnce(new Error("timeout"));
    expect(await analyzeCodebase(repo, makeProfile())).toMatchObject({ success: false, message: "Analysis failed: timeout" });
  });
});

describe("detectBreakingChanges", () => {
  const bcResult = {
    riskLevel: "HIGH",
    changeType: ["API"],
    affectedConsumers: ["web"],
    findings: [
      { file: "src/user.ts", change: "removed email", breaking: true, impact: "web" },
      { file: "src/index.ts", change: "added log", breaking: false, impact: "none" },
    ],
    recommendations: ["deprecate first"],
    checklist: {
      dtosChecked: true, enumsChecked: true, typesChecked: true, defaultsChecked: true,
      databaseChecked: false, messagesChecked: true, consumersChecked: true, rollbackChecked: true,
    },
  };

  it("short-circuits with LOW risk when nothing changed (no AI call)", async () => {
    vi.mocked(getRecentDiff).mockResolvedValue("");
    vi.mocked(getChangedFiles).mockResolvedValue([]);
    vi.mocked(getRecentCommits).mockResolvedValue("");
    const res = await detectBreakingChanges(repo, makeProfile());
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ riskLevel: "LOW", changeType: ["None"], findings: [] });
    expect(askAI).not.toHaveBeenCalled();
    expect(getRecentDiff).toHaveBeenCalledWith(repo, 5);
  });

  it("sends diff, commits and changed file contents to the AI and summarises findings", async () => {
    vi.mocked(getRecentDiff).mockResolvedValue("D".repeat(20_000));
    vi.mocked(getChangedFiles).mockResolvedValue(["src/user.ts", "deleted.ts"]);
    vi.mocked(getRecentCommits).mockResolvedValue("abc1234 2026 feat: change");
    vi.mocked(askAI).mockResolvedValue(JSON.stringify(bcResult));

    const res = await detectBreakingChanges(repo, makeProfile(), 2);

    expect(getChangedFiles).toHaveBeenCalledWith(repo, 2);
    expect(res).toMatchObject({ success: true, message: "Risk: HIGH — 2 findings (1 breaking)" });
    const prompt = vi.mocked(askAI).mock.calls[0][0];
    expect(prompt).toContain("abc1234 2026 feat: change");
    expect(prompt).toContain("## Changed Files (2 files)");
    expect(prompt).toContain("D".repeat(15_000));
    expect(prompt).not.toContain("D".repeat(15_001));
    expect(prompt).toContain("=== src/user.ts ===\n" + "U".repeat(2000));
    expect(prompt).not.toContain("=== deleted.ts ===");
  });

  it("runs the AI when only the file list is non-empty", async () => {
    vi.mocked(getRecentDiff).mockResolvedValue("");
    vi.mocked(getChangedFiles).mockResolvedValue(["a.ts"]);
    vi.mocked(getRecentCommits).mockResolvedValue("");
    vi.mocked(askAI).mockResolvedValue(JSON.stringify(bcResult));
    expect((await detectBreakingChanges(repo, makeProfile())).success).toBe(true);
    expect(askAI).toHaveBeenCalled();
  });

  it("reports invalid AI output as a failure", async () => {
    vi.mocked(getRecentDiff).mockResolvedValue("diff");
    vi.mocked(getChangedFiles).mockResolvedValue([]);
    vi.mocked(getRecentCommits).mockResolvedValue("");
    vi.mocked(askAI).mockResolvedValue(JSON.stringify({ ...bcResult, riskLevel: "SEVERE" }));
    const res = await detectBreakingChanges(repo, makeProfile());
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/^Breaking change detection failed: AI output failed schema validation/);
  });
});

describe("advisor", () => {
  const ctx = (o: Partial<ConversationContext> = {}): ConversationContext => ({
    sessionId: "s1",
    repoUrl: "https://github.com/acme/api",
    taskType: "bugfix",
    questions: [
      { role: "assistant", content: "What is the bug?" },
      { role: "user", content: "Login fails" },
    ],
    currentStep: 1,
    totalSteps: 5,
    ...o,
  });

  it("has fixed question sets per task type", () => {
    expect(generateInitialQuestions("bugfix")).toHaveLength(5);
    expect(generateInitialQuestions("feature")).toHaveLength(5);
    expect(generateInitialQuestions("breaking_changes")).toHaveLength(5);
    expect(generateInitialQuestions("architecture")).toHaveLength(3);
    expect(generateInitialQuestions("general")).toEqual(["What would you like to know about this codebase?"]);
  });

  it("builds a task-specific prompt with codebase context and history", async () => {
    vi.mocked(chatAI).mockResolvedValue("Look at src/user.ts");
    const out = await generateAdvisorResponse(ctx(), "It throws 500", makeProfile(), makeAnalysis(), repo);
    expect(out).toBe("Look at src/user.ts");
    const [prompt, cwd] = vi.mocked(chatAI).mock.calls[0];
    expect(cwd).toBe(repo);
    expect(prompt).toMatch(/^You are a senior developer helping debug a bug/);
    expect(prompt).toContain("- Languages: TypeScript (100%)");
    expect(prompt).toContain("KEY COMPONENTS:\n- UserService (service): users");
    expect(prompt).toContain("- GET /users: list users");
    expect(prompt).toContain("- User: id: string");
    expect(prompt).toContain("Assistant: What is the bug?\nUser: Login fails");
    expect(prompt).toContain("## User's Latest Message\nIt throws 500");
    expect(prompt).not.toContain("## Referenced File Contents");
  });

  it.each(["feature", "breaking_changes", "architecture", "general"] as const)("uses the %s prompt", async (taskType) => {
    vi.mocked(chatAI).mockResolvedValue("ok");
    await generateAdvisorResponse(ctx({ taskType }), "q", makeProfile({ frameworks: [], databases: [] }), null, repo);
    const prompt = vi.mocked(chatAI).mock.calls[0][0];
    const starts = {
      feature: "You are a senior architect guiding the implementation",
      breaking_changes: "You are a senior architect analyzing breaking changes",
      architecture: "You are a senior architect explaining",
      general: "You are a helpful assistant",
    } as const;
    expect(prompt.startsWith(starts[taskType])).toBe(true);
    expect(prompt).toContain("- Frameworks: none");
    expect(prompt).not.toContain("KEY COMPONENTS");
  });

  it("inlines up to 3 referenced repo files, truncated to 3000 chars", async () => {
    vi.mocked(chatAI).mockResolvedValue("ok");
    await generateAdvisorResponse(
      ctx(),
      "see src/user.ts and nope.ts and docker-compose.yml and src/index.ts",
      makeProfile(),
      null,
      repo,
    );
    const prompt = vi.mocked(chatAI).mock.calls[0][0];
    expect(prompt).toContain("## Referenced File Contents");
    expect(prompt).toContain("=== src/user.ts ===\n" + "U".repeat(3000));
    expect(prompt).not.toContain("U".repeat(3001));
    expect(prompt).toContain("=== docker-compose.yml ===\nservices: {}");
    expect(prompt).not.toContain("=== nope.ts ===");
    // only the first 3 mentions are considered, even if one of them does not exist
    expect(prompt).not.toContain("=== src/index.ts ===");
  });

  // BUG (src/agents/advisor.ts:186): the extension alternation lists "js" before "json"
  // (and .tsx/.jsx are not listed, so "App.tsx" becomes "App.ts"); "package.json" is captured as
  // "package.js" and never found; JSON files mentioned by the user are silently ignored.
  it.skip("BUG: inlines .json files mentioned by the user", async () => {
    vi.mocked(chatAI).mockResolvedValue("ok");
    await generateAdvisorResponse(ctx(), "what is in package.json?", makeProfile(), null, repo);
    expect(vi.mocked(chatAI).mock.calls[0][0]).toContain("=== package.json ===");
  });

  it("returns a friendly message when the AI call fails", async () => {
    vi.mocked(chatAI).mockRejectedValue(new Error("CLI timeout"));
    const out = await generateAdvisorResponse(ctx(), "q", makeProfile(), null, repo);
    expect(out).toMatch(/^I encountered an error generating a response: CLI timeout/);
  });

  // BUG (src/agents/advisor.ts:185-191 + techDetector.readRepoFile): file paths are taken
  // from the user's chat message and read without a containment check, so a message
  // mentioning "../secret.yml" leaks files outside the cloned repo into the LLM prompt
  // (and potentially back to the chat).
  it.skip("BUG: does not inline files outside the repository", async () => {
    const outer = makeTree({ "repo/a.ts": "", "secret.yml": "token: s3cr3t" });
    try {
      vi.mocked(chatAI).mockResolvedValue("ok");
      await generateAdvisorResponse(ctx(), "check ../secret.yml", makeProfile(), null, path.join(outer, "repo"));
      expect(vi.mocked(chatAI).mock.calls[0][0]).not.toContain("s3cr3t");
    } finally {
      rmTree(outer);
    }
  });

  it("generateTaskSummary summarises the conversation or degrades gracefully", async () => {
    vi.mocked(chatAI).mockResolvedValueOnce("# Summary");
    expect(await generateTaskSummary(ctx(), makeProfile(), repo)).toBe("# Summary");
    const prompt = vi.mocked(chatAI).mock.calls[0][0];
    expect(prompt).toContain("bugfix task for the project at https://github.com/acme/api");
    expect(prompt).toContain("Tech Stack: Express / TypeScript");
    vi.mocked(chatAI).mockRejectedValueOnce(new Error("x"));
    expect(await generateTaskSummary(ctx(), makeProfile(), repo)).toBe("Unable to generate summary.");
  });
});
