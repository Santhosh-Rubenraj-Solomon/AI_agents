import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ClaudeParseError,
  PipelineStateSchema,
  TaskAnalysisSchema,
  TaskRequestSchema,
  TASK_TYPES,
  buildConventionalCommitMessage,
  generateBranchName,
  getTypeLabel,
  parseClaudeJson,
  validateBranchName,
} from "../src/schemas.js";
import { makeAnalysis, makeState } from "./helpers.js";

describe("generateBranchName", () => {
  it("prefixes by task type", () => {
    expect(generateBranchName("bugfix", "Thing")).toBe("fix/thing");
    expect(generateBranchName("feature", "Thing")).toBe("feat/thing");
    expect(generateBranchName("refactor", "Thing")).toBe("refactor/thing");
    expect(generateBranchName("documentation", "Thing")).toBe("docs/thing");
  });

  it("slugifies and strips leading/trailing separators", () => {
    expect(generateBranchName("feature", "  Hello, World!! ")).toBe("feat/hello-world");
  });

  it("keeps generated names at most 25 chars and valid", () => {
    for (const type of TASK_TYPES) {
      const name = generateBranchName(type, "Fix receipt reprint on voided transactions please");
      expect(name.length).toBeLessThanOrEqual(25);
      expect(validateBranchName(name)).toBeNull();
    }
  });

  // Previously a BUG: the trailing-hyphen strip ran BEFORE truncation, so truncation
  // could leave a dangling "-" (e.g. "feat/add-tips-summary-to-").
  it("never ends with a hyphen after truncation", () => {
    expect(generateBranchName("feature", "Add tips summary to Z report")).not.toMatch(/-$/);
    for (let n = 1; n < 40; n++) {
      const name = generateBranchName("refactor", "ab ".repeat(n));
      expect(name).not.toMatch(/-$/);
      expect(validateBranchName(name)).toBeNull();
    }
  });

  // Previously a BUG: a title with no alphanumerics (valid per TaskRequestSchema,
  // min length 3) yielded "fix/", which is not a valid git ref.
  it("produces a non-empty, valid slug for symbol-only titles", () => {
    for (const title of ["!!!", "???", "   ", "日本語のタイトル"]) {
      const name = generateBranchName("bugfix", title);
      expect(name).not.toBe("fix/");
      expect(name).toMatch(/^fix\/task-[a-z0-9]+$/);
      expect(name.length).toBeLessThanOrEqual(25);
      expect(validateBranchName(name)).toBeNull();
    }
  });
});

describe("validateBranchName", () => {
  it("returns null for valid names", () => {
    expect(validateBranchName("fix/receipt-reprint")).toBeNull();
  });

  it("rejects names git would misparse", () => {
    expect(validateBranchName("--mirror")).toMatch(/hyphen/);
    expect(validateBranchName("fix//x")).toMatch(/empty path segments/);
    expect(validateBranchName("fix/")).toMatch(/slash/);
    expect(validateBranchName("HEAD")).toMatch(/HEAD/);
  });

  it("rejects invalid characters", () => {
    expect(validateBranchName("fix receipt")).toMatch(/may only contain/);
    expect(validateBranchName("fix.receipt")).toMatch(/may only contain/);
  });

  it("enforces the 30 char max (boundary)", () => {
    expect(validateBranchName("a".repeat(30))).toBeNull();
    expect(validateBranchName("a".repeat(31))).toMatch(/at most 30 characters \(got 31\)/);
  });
});

describe("parseClaudeJson", () => {
  const Schema = z.object({ a: z.number(), b: z.string().optional() });

  it("parses plain JSON", () => {
    expect(parseClaudeJson('{"a":1}', Schema)).toEqual({ a: 1 });
  });

  it("strips ```json fences", () => {
    expect(parseClaudeJson('```json\n{"a":2,"b":"x"}\n```', Schema)).toEqual({ a: 2, b: "x" });
  });

  it("extracts the outermost object from surrounding prose", () => {
    expect(parseClaudeJson('Sure! Here it is: {"a":3} hope that helps', Schema)).toEqual({ a: 3 });
  });

  it("throws ClaudeParseError carrying the raw output when no object exists", () => {
    try {
      parseClaudeJson("no json here", Schema);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ClaudeParseError);
      expect((e as ClaudeParseError).rawOutput).toBe("no json here");
      expect((e as Error).message).toMatch(/Could not extract/);
    }
  });

  it("throws when the extracted block is not valid JSON", () => {
    expect(() => parseClaudeJson("prefix {a: 1} suffix", Schema)).toThrow(/not valid JSON/);
  });

  it("reports schema validation issues with paths", () => {
    expect(() => parseClaudeJson('{"a":"nope"}', Schema)).toThrow(/failed schema validation:\n\s+a:/);
  });

  it("validates a full TaskAnalysis payload", () => {
    const raw = "```json\n" + JSON.stringify(makeAnalysis()) + "\n```";
    expect(parseClaudeJson(raw, TaskAnalysisSchema).branchName).toBe("fix/receipt-reprint");
  });
});

describe("buildConventionalCommitMessage", () => {
  it("formats type(scope): description with lowercased first char", () => {
    expect(buildConventionalCommitMessage("bugfix", "ecr", "Fix the bug")).toBe("fix(ecr): fix the bug");
    expect(buildConventionalCommitMessage("documentation", "ecr", "X")).toBe("docs(ecr): x");
  });

  it("truncates to exactly 100 chars with an ellipsis", () => {
    const msg = buildConventionalCommitMessage("feature", "ecr", "A".repeat(200));
    expect(msg).toHaveLength(100);
    expect(msg.endsWith("...")).toBe(true);
    expect(msg.startsWith("feat(ecr): a")).toBe(true);
  });

  it("does not truncate a message that exactly fits", () => {
    const prefix = "feat(ecr): ";
    const title = "b".repeat(100 - prefix.length);
    expect(buildConventionalCommitMessage("feature", "ecr", title)).toBe(prefix + title);
  });

  it("handles an empty title", () => {
    expect(buildConventionalCommitMessage("refactor", "svc", "")).toBe("refactor(svc): ");
  });
});

describe("getTypeLabel", () => {
  it("maps known types and falls back to the raw value", () => {
    expect(getTypeLabel("bugfix")).toBe("Bug Fix");
    expect(getTypeLabel("documentation")).toBe("Documentation");
    expect(getTypeLabel("weird" as never)).toBe("weird");
  });
});

describe("TaskRequestSchema", () => {
  const base = { type: "bugfix", title: "Fix it", priority: "high" };

  it("accepts a minimal request", () => {
    expect(TaskRequestSchema.parse(base)).toMatchObject(base);
  });

  it("rejects short titles, bad priority/type and bad branch names", () => {
    expect(TaskRequestSchema.safeParse({ ...base, title: "ab" }).success).toBe(false);
    expect(TaskRequestSchema.safeParse({ ...base, priority: "urgent" }).success).toBe(false);
    expect(TaskRequestSchema.safeParse({ ...base, type: "chore" }).success).toBe(false);
    expect(TaskRequestSchema.safeParse({ ...base, branchName: "bad name" }).success).toBe(false);
    expect(TaskRequestSchema.safeParse({ ...base, branchName: "a".repeat(31) }).success).toBe(false);
  });

  it("defaults endpointDetails.exposeOnForeshore to false and bounds numberOfEndpoints", () => {
    const parsed = TaskRequestSchema.parse({ ...base, endpointDetails: {} });
    expect(parsed.endpointDetails?.exposeOnForeshore).toBe(false);
    expect(
      TaskRequestSchema.safeParse({ ...base, endpointDetails: { numberOfEndpoints: 21 } }).success,
    ).toBe(false);
  });
});

describe("PipelineStateSchema", () => {
  it("fills null defaults for optional requester/reviewer fields", () => {
    const { requesterId, requesterChannelId, requesterThreadTs, reviewerGitLabIds, ...rest } = makeState();
    const parsed = PipelineStateSchema.parse(rest);
    expect(parsed.requesterId).toBeNull();
    expect(parsed.requesterChannelId).toBeNull();
    expect(parsed.requesterThreadTs).toBeNull();
    expect(parsed.reviewerGitLabIds).toBeNull();
  });

  it("rejects unknown phases (e.g. legacy awaiting_review_approval)", () => {
    const state = { ...makeState(), currentPhase: "awaiting_review_approval" };
    expect(PipelineStateSchema.safeParse(state).success).toBe(false);
  });

  it("requires TaskAnalysis.approach to be non-empty", () => {
    expect(TaskAnalysisSchema.safeParse(makeAnalysis({ approach: [] })).success).toBe(false);
  });
});
