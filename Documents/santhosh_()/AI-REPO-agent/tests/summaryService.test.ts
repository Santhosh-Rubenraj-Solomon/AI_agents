import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/gitService.js", () => ({ getScopedDiffStat: vi.fn(async () => " 2 files changed") }));
vi.mock("../src/utils/slackFileUpload.js", () => ({ uploadMdToSlack: vi.fn(async () => {}) }));

import { getScopedDiffStat } from "../src/services/gitService.js";
import { uploadMdToSlack } from "../src/utils/slackFileUpload.js";
import {
  buildMrDescription,
  generateFinalSummaryMd,
  generatePlanMd,
  postMdToThread,
} from "../src/services/summaryService.js";
import { makeAnalysis, makeState } from "./helpers.js";

beforeEach(() => {
  vi.mocked(getScopedDiffStat).mockReset().mockResolvedValue(" 2 files changed");
  vi.mocked(uploadMdToSlack).mockReset().mockResolvedValue(undefined);
});

describe("generatePlanMd", () => {
  it("renders all sections from the analysis", () => {
    const s = makeState();
    const md = generatePlanMd("abc", s.request, makeAnalysis({ risks: ["r1"], filesToCreate: ["apps/ecr/new.ts"] }));
    expect(md).toContain("# Execution Plan -- abc");
    expect(md).toContain("| **Service** | ecr-service |");
    expect(md).toContain("1. Find the bug\n2. Fix the bug");
    expect(md).toContain("- `apps/ecr/src/receipt.service.ts`");
    expect(md).toContain("- `apps/ecr/new.ts`");
    expect(md).toContain("- r1");
    expect(md).toContain("`fix/receipt-reprint`");
    expect(md).not.toContain("Shared library changes");
  });

  it("uses fallbacks for empty lists and flags lib changes", () => {
    const s = makeState({ request: { description: undefined } as any });
    const md = generatePlanMd(
      "abc",
      s.request,
      makeAnalysis({ filesToChange: [], affectedServices: [], risks: [], needsLibChanges: true }),
    );
    expect(md).toContain("## Description\n\nFix receipt reprint");
    expect(md).toContain("## Files to Modify\n\nNone");
    expect(md).toContain("## Files to Create\n\nNone");
    expect(md).toContain("None -- change is isolated");
    expect(md).toContain("None identified");
    expect(md).toContain("Shared library changes may be needed");
  });
});

describe("buildMrDescription", () => {
  it("falls back to the description (or title) without an analysis", () => {
    expect(buildMrDescription(makeState())).toBe("Problem: double print\n\nProposed Solution: guard");
    expect(buildMrDescription(makeState({ request: { description: "" } as any }))).toBe("Fix receipt reprint");
  });

  it("builds a markdown body with review status", () => {
    const s = makeState({
      analysis: makeAnalysis({ filesToCreate: ["apps/ecr/n.ts"] }),
      reviewIterations: [{ content: "x", mdPath: "/r.md", hasIssues: false, iteration: 1 }],
    });
    const body = buildMrDescription(s);
    expect(body).toContain("## Bug Fix: Fix receipt reprint");
    expect(body).toContain("### Files Created\n- `apps/ecr/n.ts`");
    expect(body).toContain("- Clean: Yes\n- Iterations: 1");
  });
});

describe("generateFinalSummaryMd", () => {
  it("includes diff stats and truncates review previews to 500 chars", async () => {
    const s = makeState({
      worktreePath: "/wt",
      analysis: makeAnalysis(),
      mrUrl: "https://gitlab/mr/1",
      reviewIterations: [{ content: "y".repeat(600), mdPath: "/r.md", hasIssues: true, iteration: 1 }],
    });
    const md = await generateFinalSummaryMd(s);
    expect(getScopedDiffStat).toHaveBeenCalledWith("/wt");
    expect(md).toContain(" 2 files changed");
    expect(md).toContain("y".repeat(500) + "...");
    expect(md).not.toContain("y".repeat(501));
    expect(md).toContain("| **Last Review Clean** | No |");
  });

  it("degrades gracefully when the diff stat fails or there is no worktree", async () => {
    vi.mocked(getScopedDiffStat).mockRejectedValueOnce(new Error("gone"));
    expect(await generateFinalSummaryMd(makeState({ worktreePath: "/wt" }))).toContain("(not available)");
    const md = await generateFinalSummaryMd(makeState());
    expect(md).toContain("| **Last Review Clean** | N/A |");
    expect(md).toContain("## What Was Done\n\nN/A");
  });
});

describe("postMdToThread", () => {
  it("builds a slugged filename and uploads", async () => {
    await postMdToThread({} as any, "C", "1.1", "Execution Plan", "# md", "t1");
    expect(uploadMdToSlack).toHaveBeenCalledWith({}, "C", "1.1", "execution-plan-t1.md", "# md", "*Execution Plan* -- Task `t1`");
  });

  it("also saves a copy into <savePath>/.ecr-factory when given", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ecr-sum-"));
    try {
      await postMdToThread({} as any, "C", "1.1", "Execution Summary", "body", "t2", dir);
      expect(fs.readFileSync(path.join(dir, ".ecr-factory", "execution-summary-t2.md"), "utf-8")).toBe("body");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
