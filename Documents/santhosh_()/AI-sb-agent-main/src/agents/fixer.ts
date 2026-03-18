/**
 * agents/fixer.ts — Phase 3b: Fix reviewer issues and re-run nx checks.
 *
 * Write-scoped agent. Takes the last review's raw markdown content,
 * invokes Claude to fix issues based on the comments, then re-runs
 * nx lint + test to verify the fixes.
 *
 * If Claude disagrees with any review comment, it writes reasoning to
 * a `review-disagreements-{taskId}.md` file in the worktree.
 *
 * Uses: claudeAgent.fixReviewIssues, nxService.runNxChecks
 * Writes: state.currentPhase
 * Slack: none (Coordinator handles all messaging)
 */

import { fixReviewIssues } from "../services/claudeAgent.js";
import { runNxChecks } from "../services/nxService.js";
import { getTask, updateTask } from "../state/store.js";
import { createLogger } from "../utils/logger.js";
import type { AgentInterface, FixerInput, FixerOutput } from "./types.js";

const log = createLogger("Fixer");

// ─── Fixer Agent ─────────────────────────────────────────────────────────────

export const fixerAgent: AgentInterface<FixerInput, FixerOutput> = {
  name: "Fixer",
  activePhase: "fixing",

  async run(input: FixerInput): Promise<FixerOutput> {
    const state = getTask(input.taskId);
    if (!state) {
      return {
        success: false,
        message: `Task ${input.taskId} not found.`,
        error: "TASK_NOT_FOUND",
        nxPassed: false,
      };
    }

    if (!state.worktreePath || !state.analysis) {
      return {
        success: false,
        message: "Cannot fix without a worktree and analysis.",
        error: "MISSING_PREREQUISITES",
        nxPassed: false,
      };
    }

    const lastReview = state.reviewIterations[state.reviewIterations.length - 1];
    if (!lastReview || !lastReview.hasIssues) {
      return {
        success: false,
        message: "No review issues to fix.",
        error: "NO_ISSUES",
        nxPassed: false,
      };
    }

    state.currentPhase = "fixing";
    updateTask(state);

    log.info("Starting fix from review markdown", {
      taskId: input.taskId,
      reviewMdPath: lastReview.mdPath,
      contentLength: lastReview.content.length,
    });

    try {
      // Step 1: Fix the issues (Claude reads the review markdown)
      log.info("Invoking Claude to fix review issues from markdown", { taskId: input.taskId });
      await fixReviewIssues(
        state.request,
        state.analysis,
        lastReview.content,
        state.worktreePath,
        input.taskId,
      );

      // Step 2: Re-run nx checks
      log.info("Re-running nx checks after fix", { taskId: input.taskId });
      const nxResult = await runNxChecks(state.worktreePath);

      if (!nxResult.passed) {
        log.warn("Nx checks still failing after fix", { taskId: input.taskId, lintPassed: nxResult.lintPassed, testPassed: nxResult.testPassed });
        // Don't fail the pipeline — the next review iteration will catch remaining issues
        return {
          success: true,
          message:
            `Applied fixes from review feedback. ` +
            `Nx checks failing after fix:\n` +
            `\`\`\`${nxResult.output.slice(0, 1500)}\`\`\``,
          nxPassed: false,
        };
      }

      log.info("Fix complete, nx checks passed", { taskId: input.taskId });
      return {
        success: true,
        message: `Applied fixes from review feedback. Lint and tests passed.`,
        nxPassed: true,
      };
    } catch (err: unknown) {
      const error = err as Error;
      log.error("Fixer threw an exception", { taskId: input.taskId, error: error.message });
      state.currentPhase = "failed";
      updateTask(state);

      return {
        success: false,
        message: `Fix failed: ${error.message}`,
        error: error.message,
        nxPassed: false,
      };
    }
  },
};
