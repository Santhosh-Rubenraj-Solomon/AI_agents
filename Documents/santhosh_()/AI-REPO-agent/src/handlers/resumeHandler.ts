/**
 * handlers/resumeHandler.ts — /ecr-resume slash command for pipeline recovery.
 *
 * Allows the admin to resume stuck or failed pipeline tasks from Slack.
 *
 * Usage:
 *   /ecr-resume          — Lists all resumable tasks with action buttons
 *   /ecr-resume {taskId} — Resumes a specific task directly
 *
 * Only the admin (CONFIG.adminUserId) can use this command.
 *
 * NOTE: You must also create the /ecr-resume slash command in your Slack
 *       app settings (api.slack.com) -> Slash Commands -> Create New Command.
 *       Request URL is handled by Socket Mode, so no URL is needed.
 */

import fs from "node:fs";
import type { App } from "@slack/bolt";
import { CONFIG } from "../config.js";
import { getTaskRaw, getResumableTasks } from "../state/store.js";
import { resumePipeline } from "../pipeline/coordinator.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ResumeHandler");

/**
 * Map of legacy phase names to human-readable descriptions.
 * Used for display in the task list.
 */
const PHASE_DISPLAY: Record<string, string> = {
  analyzing: "Analyzing",
  awaiting_plan_approval: "Awaiting Plan Approval",
  executing: "Executing",
  reviewing: "Reviewing",
  awaiting_review_approval: "Awaiting Review Approval (legacy)",
  fixing: "Fixing",
  creating_mr: "Creating MR",
  failed: "Failed",
};

/**
 * Determine what phase a task would resume from.
 * Mirrors the logic in coordinator.ts resolveResumeTarget.
 *
 * For failed tasks, accepts the raw state to infer the best resume point
 * based on what work was already completed.
 */
function getResumeDescription(
  phase: string,
  state?: { reviewIterations?: unknown[]; worktreePath?: string | null } | null,
): string {
  const LEGACY_MAP: Record<string, string> = {
    awaiting_review_approval: "reviewing",
  };
  const mapped = LEGACY_MAP[phase] ?? phase;

  switch (mapped) {
    case "analyzing":
      return "Will restart from analysis (Phase 1)";
    case "awaiting_plan_approval":
      return "Awaiting plan approval — buttons should be in thread";
    case "executing":
      return "Will restart execution (Phase 2)";
    case "reviewing":
    case "fixing":
      return "Will resume review loop (Phase 3)";
    case "creating_mr":
      return "Will resume finalize (Phase 4 — review already done)";
    case "complete":
      return "Already complete — nothing to resume";
    case "failed": {
      const hasReviews = state?.reviewIterations && state.reviewIterations.length > 0;
      const hasWorktree = !!state?.worktreePath;
      if (hasReviews && hasWorktree) {
        return "Will resume finalize (Phase 4 — review was already done before failure)";
      }
      if (hasWorktree) {
        return "Will resume review loop (Phase 3, from failed)";
      }
      return "Will restart from analysis (Phase 1, from failed)";
    }
    default:
      return `Unknown phase: ${phase}`;
  }
}

/**
 * Register the /ecr-resume slash command handler.
 */
export function registerResumeCommand(app: App): void {
  log.info("Registering /ecr-resume command. Ensure this slash command exists in your Slack app settings.");

  app.command("/ecr-resume", async ({ command, ack, respond }) => {
    await ack();

    const userId = command.user_id;
    log.info("/ecr-resume invoked", { userId, text: command.text });

    // ── Admin-only gate ──
    if (userId !== CONFIG.adminUserId) {
      log.warn("Non-admin attempted /ecr-resume", { userId });
      await respond({
        response_type: "ephemeral",
        text: "Only the admin can resume pipelines.",
      });
      return;
    }

    const taskIdArg = command.text?.trim() || "";

    // ── Direct resume: /ecr-resume {taskId} ──
    if (taskIdArg) {
      await handleDirectResume(app, respond, taskIdArg);
      return;
    }

    // ── List resumable tasks ──
    await handleListResumable(app, respond);
  });

  // ── Button action: resume_task_{taskId} ──
  // We use a regex action to match dynamic action_ids
  app.action(/^resume_task_.+$/, async ({ ack, body, action }) => {
    await ack();

    const userId = (body as any).user?.id;
    if (userId !== CONFIG.adminUserId) {
      log.warn("Non-admin attempted resume button", { userId });
      return;
    }

    const actionId = (action as any).action_id as string;
    const taskId = actionId.replace("resume_task_", "");

    log.info("Resume button clicked", { taskId, userId });

    // Post acknowledgement
    const channelId = (body as any).channel?.id;
    if (channelId) {
      try {
        await app.client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `Resuming task \`${taskId}\`... Check the task's thread for progress.`,
        });
      } catch {
        // Non-fatal
      }
    }

    // Kick off resume (fire and forget — errors handled inside)
    resumePipeline(app, taskId).catch((err) => {
      log.error("resumePipeline threw unexpectedly", { taskId, error: String(err) });
    });
  });
}

// ─── Direct Resume ──────────────────────────────────────────────────────────

async function handleDirectResume(
  app: App,
  respond: (msg: any) => Promise<any>,
  taskId: string
): Promise<void> {
  log.info("Direct resume requested", { taskId });

  // Check task exists (use raw getter to handle legacy phases)
  const rawState = getTaskRaw(taskId);
  if (!rawState) {
    await respond({
      response_type: "ephemeral",
      text: `Task \`${taskId}\` not found in the database.`,
    });
    return;
  }

  const phase = rawState.currentPhase;
  const worktreePath = rawState.worktreePath;

  // Check if task is in a terminal state that can't be resumed
  if (phase === "complete" || phase === "cancelled") {
    await respond({
      response_type: "ephemeral",
      text: `Task \`${taskId}\` is in phase \`${phase}\` and cannot be resumed.`,
    });
    return;
  }

  // Check worktree exists (needed for most phases)
  const needsWorktree = !["analyzing", "awaiting_plan_approval"].includes(phase);
  if (needsWorktree && worktreePath) {
    if (!fs.existsSync(worktreePath)) {
      await respond({
        response_type: "ephemeral",
        text:
          `Task \`${taskId}\` worktree at \`${worktreePath}\` no longer exists.\n` +
          `Cannot resume without a worktree. The task must be restarted from scratch.`,
      });
      return;
    }
  }

  const phaseLabel = PHASE_DISPLAY[phase] ?? phase;
  const resumeDesc = getResumeDescription(phase, rawState);

  await respond({
    response_type: "ephemeral",
    text:
      `Resuming task \`${taskId}\` (current phase: ${phaseLabel}).\n` +
      `${resumeDesc}.\n` +
      `Check the task's DM thread for progress.`,
  });

  // Kick off resume
  resumePipeline(app, taskId).catch((err) => {
    log.error("resumePipeline threw unexpectedly (direct)", { taskId, error: String(err) });
  });
}

// ─── List Resumable Tasks ───────────────────────────────────────────────────

async function handleListResumable(
  app: App,
  respond: (msg: any) => Promise<any>
): Promise<void> {
  const tasks = getResumableTasks();

  if (tasks.length === 0) {
    await respond({
      response_type: "ephemeral",
      text: "No resumable tasks found. All pipelines are either complete or cancelled.",
    });
    return;
  }

  log.info("Listing resumable tasks", { count: tasks.length });

  // Build blocks for each task
  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Resumable Tasks" },
    },
  ];

  for (const task of tasks) {
    const phaseLabel = PHASE_DISPLAY[task.phase] ?? task.phase;
    const resumeDesc = getResumeDescription(task.phase, task);
    const hasWorktree = task.worktreePath ? fs.existsSync(task.worktreePath) : false;
    const worktreeStatus = task.worktreePath
      ? (hasWorktree ? "exists" : "MISSING")
      : "none";
    const updatedAgo = Math.round((Date.now() - task.updatedAt) / 60000);

    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*Task:* \`${task.taskId}\` -- ${task.title}`,
            `*Phase:* ${phaseLabel}`,
            `*Worktree:* ${worktreeStatus}`,
            `*Last updated:* ${updatedAgo} minutes ago`,
            `_${resumeDesc}_`,
          ].join("\n"),
        },
        accessory: hasWorktree || !task.worktreePath
          ? {
              type: "button",
              text: { type: "plain_text", text: "Resume" },
              style: "primary",
              action_id: `resume_task_${task.taskId}`,
              value: task.taskId,
            }
          : undefined,
      }
    );

    // If worktree is missing and needed, show a warning
    if (task.worktreePath && !hasWorktree) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `:warning: Worktree missing at \`${task.worktreePath}\`. Cannot resume — must restart from scratch.`,
          },
        ],
      });
    }
  }

  await respond({
    response_type: "ephemeral",
    text: `Found ${tasks.length} resumable task(s).`,
    blocks,
  });
}
