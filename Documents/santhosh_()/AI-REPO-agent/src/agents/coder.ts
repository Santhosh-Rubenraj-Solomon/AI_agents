/**
 * agents/coder.ts — Phase 2: Create worktree, write code, run nx checks.
 *
 * Write-scoped agent. Creates a git worktree, invokes Claude in write
 * mode to implement the approved plan, then runs nx lint + test.
 * If nx checks fail, attempts one auto-fix cycle.
 *
 * Uses: gitService.createWorktree, claudeAgent.executeTask,
 *       claudeAgent.fixReviewIssues, nxService.runNxChecks
 * Writes: state.worktreePath, state.currentPhase
 * Slack: none (Coordinator handles all messaging)
 */

import { executeTask, fixReviewIssues } from "../services/claudeAgent.js";
import { createWorktree, cleanupOnFailure } from "../services/gitService.js";
import { runNxChecks } from "../services/nxService.js";
import { getTask, updateTask } from "../state/store.js";
import { createLogger } from "../utils/logger.js";
import type { AgentInterface, CoderInput, CoderOutput } from "./types.js";

const log = createLogger("Coder");

// ─── Coder Agent ─────────────────────────────────────────────────────────────

export const coderAgent: AgentInterface<CoderInput, CoderOutput> = {
  name: "Coder",
  activePhase: "executing",

  async run(input: CoderInput): Promise<CoderOutput> {
    const state = getTask(input.taskId);
    if (!state) {
      return {
        success: false,
        message: `Task ${input.taskId} not found.`,
        error: "TASK_NOT_FOUND",
        nxPassed: false,
      };
    }

    if (!state.analysis || !state.branchName) {
      return {
        success: false,
        message: "Cannot execute without an approved analysis plan.",
        error: "NO_ANALYSIS",
        nxPassed: false,
      };
    }

    state.currentPhase = "executing";
    updateTask(state);

    log.info("Starting execution", {
      taskId: input.taskId,
      branchName: state.branchName,
    });

    try {
      // Step 1: Create worktree
      log.info("Creating worktree", {
        taskId: input.taskId,
        branchName: state.branchName,
      });
      const worktreePath = await createWorktree(input.taskId, state.branchName);
      state.worktreePath = worktreePath;
      updateTask(state);
      log.info("Worktree created", { taskId: input.taskId, worktreePath });

      // Step 2: Execute code changes via Claude
      log.info("Invoking Claude to write code", { taskId: input.taskId });
      await executeTask(state.request, state.analysis, worktreePath);
      log.info("Claude code execution complete", { taskId: input.taskId });

      // Step 3: Run nx checks
      log.info("Running nx checks (lint + test)", { taskId: input.taskId });
      const nxResult = await runNxChecks(worktreePath);

      if (!nxResult.passed) {
        log.warn("Nx checks failed on first attempt, auto-fixing", {
          taskId: input.taskId,
          lintPassed: nxResult.lintPassed,
          testPassed: nxResult.testPassed,
        });
        // Auto-fix attempt — pass nx output as review-style markdown feedback
        const nxFeedback =
          `## Nx Check Failures\n\n` +
          `The following lint/test errors need to be fixed:\n\n` +
          `\`\`\`\n${nxResult.output.slice(0, 3000)}\n\`\`\`\n\n` +
          `Fix these lint and test errors.`;
        await fixReviewIssues(
          state.request,
          state.analysis,
          nxFeedback,
          worktreePath,
          input.taskId,
        );

        log.info("Re-running nx checks after auto-fix", {
          taskId: input.taskId,
        });
        const retryNx = await runNxChecks(worktreePath);

        if (!retryNx.passed) {
          log.error("Nx checks still failing after auto-fix", {
            taskId: input.taskId,
          });
          // Clean up and fail
          state.currentPhase = "failed";
          updateTask(state);
          await cleanupOnFailure(worktreePath, state.branchName);
          state.worktreePath = null;
          updateTask(state);

          return {
            success: false,
            message:
              `Nx checks still failing after auto-fix. Worktree cleaned up.\n` +
              `\`\`\`${retryNx.output.slice(0, 1500)}\`\`\``,
            error: "NX_CHECKS_FAILED",
            nxPassed: false,
          };
        }

        // Auto-fix succeeded
        log.info("Nx checks passed after auto-fix", { taskId: input.taskId });
        updateTask(state);
        return {
          success: true,
          message: "Code written and nx checks passed after auto-fix.",
          nxPassed: true,
        };
      }

      // Nx passed on first try
      log.info("Nx checks passed on first try", { taskId: input.taskId });
      updateTask(state);
      return {
        success: true,
        message: "Code written. Lint and tests passed.",
        nxPassed: true,
      };
    } catch (err: unknown) {
      const error = err as Error;
      log.error("Execution threw an exception", {
        taskId: input.taskId,
        error: error.message,
      });
      state.currentPhase = "failed";
      updateTask(state);

      // Clean up worktree on failure
      if (state.worktreePath) {
        log.info("Cleaning up worktree after failure", {
          taskId: input.taskId,
        });
        await cleanupOnFailure(state.worktreePath, state.branchName);
        state.worktreePath = null;
        updateTask(state);
      }

      return {
        success: false,
        message: `Execution failed: ${error.message}`,
        error: error.message,
        nxPassed: false,
      };
    }
  },
};
