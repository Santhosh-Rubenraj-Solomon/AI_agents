/**
 * agents/finalizer.ts — Phase 4: Commit, push, create MR, post summary.
 *
 * Write-scoped agent. Commits the worktree changes, pushes to remote,
 * creates a GitLab merge request, generates the final summary markdown,
 * and cleans up the worktree.
 *
 * Uses: gitService.commitAndPush, gitlabService.createMergeRequest,
 *       summaryService.generateFinalSummaryMd, summaryService.buildMrDescription
 * Writes: state.commitHash, state.mrUrl, state.currentPhase
 * Slack: none (Coordinator handles all messaging)
 */

import { CONFIG } from "../config.js";
import { commitAndPush, removeWorktree } from "../services/gitService.js";
import { createMergeRequest } from "../services/gitlabService.js";
import {
  generateFinalSummaryMd,
  buildMrDescription,
} from "../services/summaryService.js";
import { buildConventionalCommitMessage } from "../schemas.js";
import { getTask, updateTask } from "../state/store.js";
import { createLogger } from "../utils/logger.js";
import type { AgentInterface, FinalizerInput, FinalizerOutput } from "./types.js";

const log = createLogger("Finalizer");

// ─── Finalizer Agent ─────────────────────────────────────────────────────────

export const finalizerAgent: AgentInterface<FinalizerInput, FinalizerOutput> = {
  name: "Finalizer",
  activePhase: "creating_mr",

  async run(input: FinalizerInput): Promise<FinalizerOutput> {
    const state = getTask(input.taskId);
    if (!state) {
      return {
        success: false,
        message: `Task ${input.taskId} not found.`,
        error: "TASK_NOT_FOUND",
        commitHash: null,
        mrUrl: null,
      };
    }

    if (!state.worktreePath || !state.branchName) {
      return {
        success: false,
        message: "Cannot finalize without a worktree and branch name.",
        error: "MISSING_PREREQUISITES",
        commitHash: null,
        mrUrl: null,
      };
    }

    state.currentPhase = "creating_mr";
    updateTask(state);

    log.info("Starting finalization", { taskId: input.taskId, branchName: state.branchName });

    try {
      // Step 1: Commit and push
      log.info("Committing and pushing", { taskId: input.taskId, branchName: state.branchName });
      const commitHash = await commitAndPush(
        state.worktreePath,
        state.branchName,
        state.request.title,
        state.request.type,
      );
      state.commitHash = commitHash;
      updateTask(state);
      log.info("Pushed successfully", { taskId: input.taskId, commitHash });

      // Step 2: Create GitLab MR
      log.info("Creating GitLab merge request", { taskId: input.taskId });
      const mrTitle = buildConventionalCommitMessage(
        state.request.type,
        CONFIG.service.name,
        state.request.title,
      );
      const mrResult = await createMergeRequest({
        branchName: state.branchName,
        title: mrTitle,
        description: buildMrDescription(state),
        reviewerIds: state.reviewerGitLabIds ?? undefined,
      });
      state.mrUrl = mrResult.url;
      updateTask(state);
      log.info("Merge request created", { taskId: input.taskId, mrUrl: mrResult.url });

      // Step 3: Generate final summary markdown (saved to worktree)
      const summaryMd = await generateFinalSummaryMd(state);

      // Step 4: Mark complete
      state.currentPhase = "complete";
      updateTask(state);
      log.info("Pipeline marked complete", { taskId: input.taskId });

      // Step 5: Clean up worktree (best-effort)
      if (state.worktreePath) {
        try {
          await removeWorktree(state.worktreePath);
        } catch (err) {
          console.error(
            `[Finalizer] Worktree cleanup failed for ${input.taskId}:`,
            err
          );
        }
      }

      // Build the result message
      const lastReview =
        state.reviewIterations[state.reviewIterations.length - 1];

      return {
        success: true,
        message:
          `Pipeline complete.\n` +
          `Branch: \`${state.branchName}\`\n` +
          `Commit: \`${commitHash}\`\n` +
          `Review Clean: ${lastReview ? (lastReview.hasIssues ? "No" : "Yes") : "N/A"}\n` +
          `Review Iterations: ${state.reviewIterations.length}\n` +
          `Merge Request: ${mrResult.url}`,
        commitHash,
        mrUrl: mrResult.url,
      };
    } catch (err: unknown) {
      const error = err as Error;
      log.error("Finalizer threw an exception", { taskId: input.taskId, error: error.message });
      state.currentPhase = "failed";
      updateTask(state);

      return {
        success: false,
        message: `Finalize failed: ${error.message}`,
        error: error.message,
        commitHash: state.commitHash,
        mrUrl: state.mrUrl,
      };
    }
  },
};
