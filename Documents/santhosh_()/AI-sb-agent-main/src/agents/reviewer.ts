/**
 * agents/reviewer.ts — Phase 3: Run external `review` CLI and return feedback.
 *
 * Runs the external `review` CLI tool in the worktree directory (before
 * committing). Passes task context (title, problem, solution) as interactive
 * answers. Returns the raw markdown review content for the Coordinator
 * to post to Slack and pass to the Fixer if issues are found.
 *
 * Uses: reviewerService.runReview
 * Writes: state.reviewIterations, state.currentPhase
 * Slack: none (Coordinator handles all messaging)
 */

import { CONFIG } from "../config.js";
import { runReview, type ReviewContext } from "../services/reviewerService.js";
import { getTask, updateTask } from "../state/store.js";
import { createLogger } from "../utils/logger.js";
import type { AgentInterface, ReviewerInput, ReviewerOutput } from "./types.js";

const log = createLogger("Reviewer");

/**
 * Build the review context from the task request.
 * Maps task fields to the interactive prompts: title, problem, solution.
 */
function buildReviewContext(state: { request: any }): ReviewContext {
  const req = state.request;
  const title = req.title || "Code review";

  let problem: string;
  let solution: string;

  switch (req.type) {
    case "bugfix":
      problem = req.problemDescription || req.description || "Bug fix";
      solution = req.proposedSolution || req.description || "See code changes";
      break;
    case "feature":
      problem = req.featureDescription || req.description || "New feature implementation";
      solution = req.featureDescription || req.description || "See code changes";
      break;
    case "refactor":
      problem = req.refactorDescription || req.description || "Code refactoring";
      solution = req.refactorDescription || req.description || "See code changes";
      break;
    case "documentation":
      problem = req.documentationDescription || req.description || "Documentation update";
      solution = req.documentationDescription || req.description || "See code changes";
      break;
    default:
      problem = req.description || "Code changes";
      solution = req.description || "See code changes";
  }

  return { title, problem, solution };
}

// ─── Reviewer Agent ──────────────────────────────────────────────────────────

export const reviewerAgent: AgentInterface<ReviewerInput, ReviewerOutput> = {
  name: "Reviewer",
  activePhase: "reviewing",

  async run(input: ReviewerInput): Promise<ReviewerOutput> {
    const state = getTask(input.taskId);
    if (!state) {
      return {
        success: false,
        message: `Task ${input.taskId} not found.`,
        error: "TASK_NOT_FOUND",
        review: null,
      };
    }

    if (!state.worktreePath) {
      return {
        success: false,
        message: "Cannot review without a worktree.",
        error: "NO_WORKTREE",
        review: null,
      };
    }

    const iteration = state.reviewIterations.length + 1;

    state.currentPhase = "reviewing";
    updateTask(state);

    const context = buildReviewContext(state);
    log.info("Starting review via CLI", {
      taskId: input.taskId,
      iteration,
      worktreePath: state.worktreePath,
      reviewTitle: context.title,
    });

    try {
      const cliResult = await runReview(state.worktreePath, context);

      const reviewResult = {
        content: cliResult.content,
        mdPath: cliResult.mdPath,
        hasIssues: cliResult.hasIssues,
        rawOutput: cliResult.rawOutput,
        iteration,
      };

      log.info("Review complete", {
        taskId: input.taskId,
        iteration,
        hasIssues: cliResult.hasIssues,
        mdPath: cliResult.mdPath,
      });

      // Persist the review iteration
      state.reviewIterations.push(reviewResult);
      updateTask(state);

      if (!cliResult.hasIssues) {
        return {
          success: true,
          message: `Review passed (no issues found). Review file: ${cliResult.mdPath}`,
          review: reviewResult,
        };
      }

      return {
        success: true,
        message:
          `Review found issues (Iteration ${iteration}/${CONFIG.pipeline.maxReviewIterations}).\n` +
          `Review file: ${cliResult.mdPath}`,
        review: reviewResult,
      };
    } catch (err: unknown) {
      const error = err as Error;
      log.error("Review CLI threw an exception", { taskId: input.taskId, error: error.message });
      state.currentPhase = "failed";
      updateTask(state);

      return {
        success: false,
        message: `Reviewer failed: ${error.message}`,
        error: error.message,
        review: null,
      };
    }
  },
};
