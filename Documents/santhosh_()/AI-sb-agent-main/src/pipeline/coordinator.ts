/**
 * pipeline/coordinator.ts — Thin orchestrator routing work to specialized agents.
 *
 * The Coordinator is the ONLY component that:
 *   1. Talks to Slack (posts messages, renders approval buttons)
 *   2. Manages state transitions between pipeline phases
 *   3. Decides which agent to invoke based on the current phase
 *
 * Agents never see Slack. They read/write state through SQLite and return
 * typed results. The Coordinator interprets those results and decides
 * what happens next.
 *
 * State machine:
 *   startPipeline   -> Analyzer -> awaiting_plan_approval
 *   executePlan      -> Coder -> Review Loop (automatic)
 *   Review Loop      -> Reviewer -> [Fixer -> Reviewer]* -> Finalizer
 *   finalize         -> Finalizer -> complete
 *   cancel           -> cleanup -> cancelled
 */

import { v4 as uuidv4 } from "uuid";
import fs from "node:fs/promises";
import path from "node:path";
import type { App } from "@slack/bolt";
import { CONFIG } from "../config.js";
import { createTask, updateTask, getTask } from "../state/store.js";
import { cleanupOnFailure } from "../services/gitService.js";
import {
  generatePlanMd,
  generateFinalSummaryMd,
  postMdToThread,
} from "../services/summaryService.js";
import { uploadMdToSlack } from "../utils/slackFileUpload.js";
import { createBroadcastSayFn } from "../types.js";
import type { PipelineState, SayFn, FullTaskRequest } from "../types.js";
import { getTypeLabel } from "../schemas.js";
import type { TaskType } from "../schemas.js";
import { createLogger } from "../utils/logger.js";
import { resolveGitLabReviewers } from "../utils/userMapping.js";

// Agents
import {
  analyzerAgent,
  coderAgent,
  reviewerAgent,
  fixerAgent,
  finalizerAgent,
  summaryWriterAgent,
} from "../agents/index.js";

const log = createLogger("Coordinator");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load task from DB and reconstruct say function.
 * Returns null if task not found.
 */
function loadTask(
  taskId: string,
  app: App
): { state: PipelineState; say: SayFn } | null {
  const state = getTask(taskId);
  if (!state) {
    log.warn("Task not found in DB", { taskId });
    return null;
  }
  log.debug("Loaded task from DB", { taskId, phase: state.currentPhase });
  const say = createBroadcastSayFn(
    app,
    state.request.channelId,
    state.request.threadTs,
    state.requesterChannelId,
    state.requesterThreadTs,
  );
  return { state, say };
}

/**
 * Upload a .md file to Slack, mirroring to requester's DM thread if present.
 */
async function broadcastMdUpload(
  app: App,
  state: PipelineState,
  filename: string,
  content: string,
  message?: string,
): Promise<void> {
  // Upload to admin thread
  await uploadMdToSlack(
    app.client,
    state.request.channelId,
    state.request.threadTs,
    filename,
    content,
    message,
  );

  // Mirror to requester thread
  if (state.requesterChannelId && state.requesterThreadTs) {
    try {
      await uploadMdToSlack(
        app.client,
        state.requesterChannelId,
        state.requesterThreadTs,
        filename,
        content,
        message,
      );
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Post a .md document to both admin and requester threads.
 */
async function broadcastMdPost(
  app: App,
  state: PipelineState,
  title: string,
  content: string,
  taskId: string,
): Promise<void> {
  await postMdToThread(
    app.client,
    state.request.channelId,
    state.request.threadTs,
    title,
    content,
    taskId,
  );

  if (state.requesterChannelId && state.requesterThreadTs) {
    try {
      await postMdToThread(
        app.client,
        state.requesterChannelId,
        state.requesterThreadTs,
        title,
        content,
        taskId,
      );
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Read the disagreements file if it exists in the worktree.
 */
async function readDisagreements(worktreePath: string, taskId: string): Promise<string | null> {
  const filePath = path.join(worktreePath, `review-disagreements-${taskId}.md`);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

/**
 * Start a new pipeline from a Slack form submission.
 *
 * Creates the initial task state in SQLite, posts the "analyzing"
 * message, and dispatches to the Analyzer agent.
 *
 * Accepts all type-specific fields from the two-step modal flow.
 */
export async function startPipeline(
  app: App,
  input: {
    type: string;
    title: string;
    description: string;
    priority: string;
    userId: string;
    channelId: string;
    threadTs: string;
    /** The Slack user who submitted /ecr (may differ from userId when admin is running the pipeline). */
    requesterId?: string;
    /** Pre-computed or user-provided branch name. */
    branchName?: string;
    /** Slack user IDs of selected MR reviewers. */
    reviewerSlackIds?: string[];

    // Type-specific fields (from two-step modal)
    problemDescription?: string;
    proposedSolution?: string;
    featureDescription?: string;
    needsNewEndpoints?: boolean;
    endpointDetails?: Record<string, unknown>;
    refactorDescription?: string;
    documentationDescription?: string;
  }
): Promise<void> {
  const taskId = uuidv4().slice(0, 8);
  const now = Date.now();
  const taskType = input.type as TaskType;
  const typeLabel = getTypeLabel(taskType);

  log.info("Starting new pipeline", {
    taskId,
    type: typeLabel,
    title: input.title,
    priority: input.priority,
    userId: input.userId,
    requesterId: input.requesterId ?? "N/A",
    branchName: input.branchName ?? "auto",
  });

  const state: PipelineState = {
    taskId,
    request: {
      type: taskType,
      title: input.title,
      description: input.description,
      priority: input.priority as "low" | "medium" | "high" | "critical",
      userId: input.userId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      branchName: input.branchName,
      reviewerSlackIds: input.reviewerSlackIds,
      // Type-specific fields
      problemDescription: input.problemDescription,
      proposedSolution: input.proposedSolution,
      featureDescription: input.featureDescription,
      needsNewEndpoints: input.needsNewEndpoints,
      endpointDetails: input.endpointDetails as any,
      refactorDescription: input.refactorDescription,
      documentationDescription: input.documentationDescription,
    },
    requesterId: input.requesterId ?? null,
    requesterChannelId: null,
    requesterThreadTs: null,
    reviewerGitLabIds: null,
    analysis: null,
    branchName: input.branchName ?? null,
    worktreePath: null,
    commitHash: null,
    reviewIterations: [],
    currentPhase: "analyzing",
    mrUrl: null,
    createdAt: now,
    updatedAt: now,
  };

  // Persist before any async work
  createTask(state);

  // If a different person submitted the request, open a DM with them and
  // create a thread so they can follow along with pipeline progress.
  if (input.requesterId && input.requesterId !== input.userId) {
    try {
      const requesterDm = await app.client.conversations.open({
        users: input.requesterId,
      });
      if (requesterDm.channel?.id) {
        const introMsg = await app.client.chat.postMessage({
          channel: requesterDm.channel.id,
          text:
            `:rocket: Your ${typeLabel.toLowerCase()} request *"${input.title}"* has been approved!\n` +
            `Task ID: \`${taskId}\`\n` +
            `I'll post updates here as the pipeline runs.`,
        });
        if (introMsg.ts) {
          state.requesterChannelId = requesterDm.channel.id;
          state.requesterThreadTs = introMsg.ts;
          updateTask(state);
        }
      }
    } catch (err) {
      log.warn("Could not open requester DM for updates", { requesterId: input.requesterId, error: String(err) });
    }
  }

  const say = createBroadcastSayFn(
    app,
    input.channelId,
    input.threadTs,
    state.requesterChannelId,
    state.requesterThreadTs,
  );

  await say(
    `:brain: *Phase 1 -- Analysis*\n` +
      `Analyzing ${typeLabel.toLowerCase()} task within allowed services...\n` +
      `Task ID: \`${taskId}\``
  );

  // ── Dispatch to Analyzer Agent ──
  log.info("Dispatching to Analyzer agent", { taskId });
  const result = await analyzerAgent.run({ taskId });

  if (!result.success) {
    log.error("Analysis failed", { taskId, error: result.message });
    await say(`:x: *Analysis Failed:* ${result.message}`);
    return;
  }

  log.info("Analysis complete", { taskId });

  // Re-read state (agent updated it)
  const updatedState = getTask(taskId);
  if (!updatedState || !updatedState.analysis) return;

  // Post plan markdown as a downloadable .md file in the thread
  const planMd = generatePlanMd(
    taskId,
    updatedState.request,
    updatedState.analysis
  );
  await broadcastMdPost(app, state, "Execution Plan", planMd, taskId);

  // Post approval buttons
  await say({
    text: "Plan ready for approval",
    blocks: [
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `<@${input.userId}> -- Review the plan above.\n` +
            `*Type:* ${typeLabel}\n` +
            `*Branch:* \`${updatedState.analysis.branchName}\`\n` +
            `*Files:* ${updatedState.analysis.filesToChange.length} modify, ` +
            `${updatedState.analysis.filesToCreate.length} create\n` +
            `*Affected Services:* ${updatedState.analysis.affectedServices.join(", ") || "none"}\n` +
            `*Complexity:* ${updatedState.analysis.estimatedComplexity}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve Plan" },
            style: "primary",
            action_id: "approve_plan",
            value: taskId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Reject" },
            style: "danger",
            action_id: "reject_plan",
            value: taskId,
          },
        ],
      },
    ],
  });
}

// ─── PHASE 2: EXECUTION ──────────────────────────────────────────────────────

/**
 * Execute the approved plan.
 *
 * Dispatches to the Coder agent, then if successful, enters the review loop.
 */
export async function executePlan(
  taskId: string,
  app: App
): Promise<void> {
  const loaded = loadTask(taskId, app);
  if (!loaded) return;
  const { state, say } = loaded;

  await say(
    `:seedling: *Phase 2 -- Execution*\nCreating worktree and branch \`${state.branchName}\`...`
  );

  // ── Dispatch to Coder Agent ──
  log.info("Dispatching to Coder agent", { taskId });
  const result = await coderAgent.run({ taskId });

  if (!result.success) {
    log.error("Execution failed", { taskId, error: result.message });
    await say(`:x: *Execution Failed:* ${result.message}`);
    return;
  }

  log.info("Execution complete", { taskId, nxPassed: result.nxPassed });

  // Post nx status
  if (result.nxPassed) {
    await say(`:white_check_mark: ${result.message}`);
  } else {
    await say(`:warning: ${result.message}`);
  }

  // Enter the automatic review loop (no human gate)
  await runReviewLoop(taskId, app);
}

// ─── PHASE 3: AUTOMATIC REVIEW LOOP ─────────────────────────────────────────

/**
 * Automatic review loop: run review CLI, fix issues, repeat.
 *
 * This loop runs without human intervention:
 *   1. Run `review` CLI in the worktree (before committing)
 *   2. Post review content to Slack
 *   3. If issues found, dispatch Fixer agent
 *   4. After fixing, run `review` CLI again
 *   5. Loop until clean or max iterations reached
 *   6. On completion: post disagreements file if it exists
 *   7. Proceed to finalize (commit + push + MR)
 */
async function runReviewLoop(
  taskId: string,
  app: App
): Promise<void> {
  const loaded = loadTask(taskId, app);
  if (!loaded) return;
  const { say } = loaded;

  const maxIterations = CONFIG.pipeline.maxReviewIterations;

  for (let i = 0; i < maxIterations; i++) {
    // Re-read state each iteration (agents mutate it)
    const currentState = getTask(taskId);
    if (!currentState) {
      log.error("Task disappeared mid-review-loop", { taskId });
      return;
    }

    const iteration = currentState.reviewIterations.length + 1;

    log.info("Review loop iteration", { taskId, iteration, maxIterations });

    await say(
      `:eyes: *Phase 3 -- Code Review (Iteration ${iteration}/${maxIterations})*\n` +
        `Running external reviewer on changes...`
    );

    // ── Dispatch to Reviewer Agent ──
    log.info("Dispatching to Reviewer agent", { taskId, iteration });
    const reviewResult = await reviewerAgent.run({ taskId });

    if (!reviewResult.success) {
      log.error("Reviewer failed", { taskId, error: reviewResult.message });
      await say(`:x: *Reviewer Failed:* ${reviewResult.message}`);
      return;
    }

    // Post review content as a downloadable .md file
    if (reviewResult.review) {
      const reviewFilename = `review-feedback-iteration-${iteration}.md`;
      await broadcastMdUpload(
        app,
        currentState,
        reviewFilename,
        reviewResult.review.content,
        `:page_facing_up: *Review Feedback (Iteration ${iteration})*`,
      );
    }

    // Review passed -> proceed to finalize
    if (!reviewResult.review?.hasIssues) {
      log.info("Review passed -- proceeding to finalize", { taskId, iteration });
      await say(`:white_check_mark: *Review Passed* -- No issues found.`);

      // Post disagreements if any exist from previous fix iterations
      await postDisagreementsIfExist(taskId, currentState, app);

      await finalizePipeline(taskId, app);
      return;
    }

    // Review has issues — check if we have iterations left
    if (i === maxIterations - 1) {
      // Last iteration — no more fix attempts
      log.warn("Max review iterations reached", { taskId, iteration, maxIterations });
      await say(
        `:warning: *Max review iterations reached (${maxIterations}).* ` +
          `Proceeding to finalize with remaining issues.`
      );

      await postDisagreementsIfExist(taskId, currentState, app);

      await finalizePipeline(taskId, app);
      return;
    }

    // Fix issues automatically
    log.info("Review found issues — dispatching Fixer", { taskId, iteration });
    await say(`:wrench: *Fixing issues from review...*`);

    const fixResult = await fixerAgent.run({ taskId });

    if (!fixResult.success) {
      log.error("Fix failed", { taskId, error: fixResult.message });
      await say(`:x: *Fix Failed:* ${fixResult.message}`);
      return;
    }

    // Post fix status
    if (fixResult.nxPassed) {
      await say(`:white_check_mark: ${fixResult.message}`);
    } else {
      await say(`:warning: ${fixResult.message}`);
    }

    // Loop continues — next iteration will re-run the reviewer
  }
}

/**
 * Read and upload the disagreements file to Slack as a .md file if it exists.
 */
async function postDisagreementsIfExist(
  taskId: string,
  state: PipelineState,
  app: App,
): Promise<void> {
  if (!state.worktreePath) return;

  const disagreements = await readDisagreements(state.worktreePath, taskId);
  if (disagreements) {
    log.info("Uploading review disagreements to Slack", { taskId });
    await broadcastMdUpload(
      app,
      state,
      `review-disagreements-${taskId}.md`,
      disagreements,
      `:speech_balloon: *Review Disagreements* -- Claude disagreed with some review comments. See attached.`,
    );
  }
}

// ─── PHASE 4: FINALIZE ───────────────────────────────────────────────────────

/**
 * Commit, push, create MR, post summary, clean up worktree.
 *
 * Dispatches to the Finalizer agent, then posts the results to Slack.
 */
async function finalizePipeline(
  taskId: string,
  app: App
): Promise<void> {
  const loaded = loadTask(taskId, app);
  if (!loaded) return;
  const { state, say } = loaded;

  log.info("Finalize phase starting", { taskId, branchName: state.branchName });

  // Resolve MR reviewers (Slack user IDs -> GitLab user IDs) before finalize
  const reviewerSlackIds = state.request.reviewerSlackIds;
  if (reviewerSlackIds && reviewerSlackIds.length > 0) {
    log.info("Resolving MR reviewers", { taskId, reviewerSlackIds });
    try {
      const gitlabIds = await resolveGitLabReviewers(
        app.client,
        reviewerSlackIds,
      );
      if (gitlabIds.length > 0) {
        state.reviewerGitLabIds = gitlabIds;
        updateTask(state);
        log.info("Resolved MR reviewers", { taskId, gitlabIds });
      } else {
        log.warn("No reviewers could be resolved", { taskId, reviewerSlackIds });
      }
    } catch (err) {
      // Non-fatal — proceed without reviewers
      log.error("Reviewer resolution failed (non-fatal)", { taskId, error: String(err) });
    }
  }

  await say(
    `:rocket: *Phase 4 -- Finalize*\nCommitting and pushing \`${state.branchName}\`...`
  );

  // Generate summary BEFORE finalizer cleans up the worktree
  let summaryMd: string | null = null;
  if (state.worktreePath) {
    try {
      summaryMd = await generateFinalSummaryMd(state);
    } catch {
      // Non-fatal — we'll skip the summary post
    }
  }

  // ── Dispatch to Finalizer Agent ──
  log.info("Dispatching to Finalizer agent", { taskId });
  const result = await finalizerAgent.run({ taskId });

  if (!result.success) {
    log.error("Finalize failed", { taskId, error: result.message });
    await say(`:x: *Finalize Failed:* ${result.message}`);
    return;
  }

  log.info("Pipeline complete", { taskId, commitHash: result.commitHash, mrUrl: result.mrUrl });

  // Post MR link
  if (result.mrUrl) {
    await say(`:white_check_mark: *Merge Request:* ${result.mrUrl}`);
  }

  // Post final execution summary as .md file
  if (summaryMd) {
    await broadcastMdPost(app, state, "Execution Summary", summaryMd, taskId);
  }

  // Re-read final state for the completion message
  const finalState = getTask(taskId);
  if (!finalState) return;

  const typeLabel = getTypeLabel(finalState.request.type);
  const lastReview =
    finalState.reviewIterations[finalState.reviewIterations.length - 1];

  await say({
    text: `Pipeline complete for ${taskId}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Pipeline Complete -- ${taskId}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*Task:* ${finalState.request.title}`,
            `*Type:* ${typeLabel}`,
            `*Branch:* \`${finalState.branchName}\``,
            `*Commit:* \`${result.commitHash}\``,
            `*Review Iterations:* ${finalState.reviewIterations.length}`,
            `*Last Review Had Issues:* ${lastReview?.hasIssues ? "Yes" : "No"}`,
            `*Merge Request:* ${result.mrUrl}`,
          ].join("\n"),
        },
      },
    ],
  });

  // ── Dispatch Summary Writer agent ──
  log.info("Dispatching Summary Writer agent", { taskId });
  let mrSummaryContent: string | null = null;
  try {
    const summaryResult = await summaryWriterAgent.run({ taskId });

    if (summaryResult.success && summaryResult.content) {
      mrSummaryContent = summaryResult.content;

      // Upload the human-friendly MR summary as a .md file to both threads
      await broadcastMdUpload(
        app,
        finalState,
        `merge-request-summary-${taskId}.md`,
        mrSummaryContent,
        `:memo: *MR Summary* -- a human-friendly overview of all changes`,
      );
    } else {
      log.warn("Summary Writer did not produce content", {
        taskId,
        message: summaryResult.message,
      });
    }
  } catch (err) {
    // Non-fatal — the pipeline is already complete
    log.error("Summary Writer failed (non-fatal)", { taskId, error: String(err) });
  }

}

// ─── RESUME ──────────────────────────────────────────────────────────────────

/**
 * Map legacy phase names (from before refactors) to current valid phases.
 * This allows tasks stuck in old phases to be resumed properly.
 */
const LEGACY_PHASE_MAP: Record<string, string> = {
  awaiting_review_approval: "reviewing",
};

/**
 * Determine which pipeline phase to resume from, given the task's current
 * (possibly legacy) phase and its state. Returns the target phase and a
 * human-readable description of what will happen.
 *
 * For failed tasks, we inspect the task state to infer the last active phase
 * rather than blindly defaulting to the review loop:
 *   - Has reviewIterations AND was creating_mr? -> finalize
 *   - Has reviewIterations? -> review loop
 *   - Has worktreePath? -> execution
 *   - Otherwise -> analysis
 */
function resolveResumeTarget(
  rawPhase: string,
  state?: { reviewIterations?: unknown[]; worktreePath?: string | null; branchName?: string | null } | null,
): { phase: string; label: string } | null {
  // Map legacy phases first
  const phase = LEGACY_PHASE_MAP[rawPhase] ?? rawPhase;

  switch (phase) {
    case "analyzing":
      return { phase: "analyzing", label: "analysis (Phase 1)" };
    case "awaiting_plan_approval":
      return { phase: "awaiting_plan_approval", label: "awaiting plan approval (buttons already posted)" };
    case "executing":
      return { phase: "executing", label: "execution (Phase 2)" };
    case "reviewing":
    case "fixing":
      return { phase: "reviewing", label: "review loop (Phase 3)" };
    case "creating_mr":
      return { phase: "creating_mr", label: "finalize (Phase 4 — skip review)" };
    case "complete":
      return { phase: "complete", label: "already complete" };
    case "failed":
      return inferResumeFromFailed(state);
    default:
      return null;
  }
}

/**
 * For failed tasks, infer the best resume point from the task state.
 */
function inferResumeFromFailed(
  state?: { reviewIterations?: unknown[]; worktreePath?: string | null; branchName?: string | null } | null,
): { phase: string; label: string } {
  if (!state) {
    return { phase: "analyzing", label: "analysis (Phase 1, from failed — no state)" };
  }

  const hasReviews = state.reviewIterations && state.reviewIterations.length > 0;
  const hasWorktree = !!state.worktreePath;

  // If review was done, the task was likely in creating_mr when it failed
  if (hasReviews && hasWorktree) {
    return { phase: "creating_mr", label: "finalize (Phase 4, from failed — review already done)" };
  }

  if (hasWorktree) {
    return { phase: "reviewing", label: "review loop (Phase 3, from failed)" };
  }

  return { phase: "analyzing", label: "analysis (Phase 1, from failed)" };
}

/**
 * Resume a pipeline from a specific phase.
 *
 * This is called by the /ecr-resume handler after validating admin access
 * and task existence. It reconstructs the Slack say function from stored
 * channel/thread, updates the phase in DB, and dispatches to the right
 * part of the pipeline.
 *
 * For tasks with legacy phases (e.g. "awaiting_review_approval"), the phase
 * is first mapped to a current valid phase.
 */
export async function resumePipeline(
  app: App,
  taskId: string,
  targetPhase?: string
): Promise<void> {
  // Use raw getter first to handle legacy phases that Zod would reject
  const { getTaskRaw, forceUpdatePhase } = await import("../state/store.js");
  const rawState = getTaskRaw(taskId);

  if (!rawState) {
    log.error("Resume failed: task not found", { taskId });
    return;
  }

  const currentRawPhase = rawState.currentPhase;
  log.info("Resuming pipeline", { taskId, currentRawPhase, requestedPhase: targetPhase ?? "auto" });

  // Determine target phase (pass full state so failed tasks can be routed intelligently)
  const target = targetPhase
    ? { phase: targetPhase, label: targetPhase }
    : resolveResumeTarget(currentRawPhase, rawState);

  if (!target) {
    log.error("Cannot determine resume target", { taskId, phase: currentRawPhase });
    return;
  }

  // Force-update the phase in DB to a valid phase so normal getTask() works
  const validPhase = target.phase as import("../types.js").PipelinePhase;
  forceUpdatePhase(taskId, validPhase);

  // Now load via normal path (Zod-validated)
  const loaded = loadTask(taskId, app);
  if (!loaded) {
    log.error("Resume failed: could not load task after phase fix", { taskId });
    return;
  }

  const { state, say } = loaded;

  await say(
    `:recycle: *Resuming pipeline from ${target.label}*\n` +
      `Task ID: \`${taskId}\`\n` +
      `Previous phase: \`${currentRawPhase}\` -> \`${target.phase}\``
  );

  // Dispatch to the right pipeline phase
  try {
    switch (target.phase) {
      case "analyzing":
        log.info("Resume: restarting from analysis", { taskId });
        // Re-run the full startPipeline is too heavy — just re-dispatch analyzer
        // But analysis needs the full startPipeline flow. Post a note.
        await say(`:brain: *Phase 1 -- Analysis*\nRe-analyzing task...`);
        const analyzerResult = await analyzerAgent.run({ taskId });
        if (!analyzerResult.success) {
          await say(`:x: *Analysis Failed:* ${analyzerResult.message}`);
          return;
        }
        // Re-read state and post plan for approval
        const updatedState = getTask(taskId);
        if (!updatedState || !updatedState.analysis) return;
        const planMd = generatePlanMd(taskId, updatedState.request, updatedState.analysis);
        await broadcastMdPost(app, state, "Execution Plan", planMd, taskId);
        await say({
          text: "Plan ready for approval",
          blocks: [
            { type: "divider" },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text:
                  `Review the plan above.\n` +
                  `*Branch:* \`${updatedState.analysis.branchName}\`\n` +
                  `*Files:* ${updatedState.analysis.filesToChange.length} modify, ` +
                  `${updatedState.analysis.filesToCreate.length} create`,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Approve Plan" },
                  style: "primary",
                  action_id: "approve_plan",
                  value: taskId,
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "Reject" },
                  style: "danger",
                  action_id: "reject_plan",
                  value: taskId,
                },
              ],
            },
          ],
        });
        break;

      case "awaiting_plan_approval":
        log.info("Resume: task is awaiting plan approval — nothing to do", { taskId });
        await say(
          `:information_source: Task \`${taskId}\` is awaiting plan approval.\n` +
            `The approval buttons should be in the thread above. If not, re-run analysis with \`/ecr-resume ${taskId}\` after setting the phase.`
        );
        break;

      case "executing":
        log.info("Resume: restarting execution", { taskId });
        await executePlan(taskId, app);
        break;

      case "reviewing":
        log.info("Resume: entering review loop", { taskId });
        await runReviewLoop(taskId, app);
        break;

      case "creating_mr":
        log.info("Resume: skipping to finalize (review already done)", { taskId });
        await finalizePipeline(taskId, app);
        break;

      case "complete":
        log.info("Resume: task already complete — nothing to do", { taskId });
        await say(`:white_check_mark: Task \`${taskId}\` is already complete. Nothing to resume.`);
        break;

      default:
        log.error("Unknown resume target phase", { taskId, phase: target.phase });
        await say(`:x: Unknown resume phase: \`${target.phase}\``);
    }
  } catch (err) {
    log.error("Resume pipeline failed with exception", {
      taskId,
      phase: target.phase,
      error: String(err),
    });

    // Mark as failed
    const failedState = getTask(taskId);
    if (failedState) {
      failedState.currentPhase = "failed";
      updateTask(failedState);
    }

    await say(`:x: *Resume failed:* ${String(err)}`);
  }
}

// ─── CANCEL ───────────────────────────────────────────────────────────────────

/**
 * Cancel a pipeline. Cleans up worktree and marks as cancelled.
 */
export async function cancelPipeline(
  taskId: string,
  app: App,
  reason: string
): Promise<void> {
  const loaded = loadTask(taskId, app);
  if (!loaded) return;
  const { state, say } = loaded;

  log.warn("Pipeline cancelled", { taskId, reason });

  if (state.worktreePath) {
    await cleanupOnFailure(state.worktreePath, state.branchName);
  }

  state.currentPhase = "cancelled";
  state.worktreePath = null;
  updateTask(state);

  await say(`:no_entry_sign: ${reason}`);
}
