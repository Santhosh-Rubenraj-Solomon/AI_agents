/**
 * handlers/planApprovalHandler.ts — Approve/reject plan buttons.
 *
 * Looks up the task from SQLite by the button value (taskId).
 * Validates the task is in awaiting_plan_approval phase before
 * proceeding.
 */

import type { App } from "@slack/bolt";
import { getTask } from "../state/store.js";
import { executePlan, cancelPipeline } from "../pipeline/coordinator.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("PlanApproval");

/**
 * Register plan approval/rejection button handlers.
 */
export function registerPlanApproval(app: App): void {
  // ── Approve Plan ──
  app.action("approve_plan", async ({ ack, body }) => {
    await ack();

    const action = (body as any).actions?.[0];
    const taskId = action?.value;
    if (!taskId) return;

    const state = getTask(taskId);
    if (!state || state.currentPhase !== "awaiting_plan_approval") {
      log.warn("Task not in awaiting_plan_approval", { taskId, currentPhase: state?.currentPhase });
      return;
    }

    const userId = (body as any).user?.id;
    log.info("Plan approved", { taskId, userId });

    // Post approval acknowledgement to thread
    try {
      await app.client.chat.postMessage({
        channel: state.request.channelId,
        thread_ts: state.request.threadTs,
        text: `:thumbsup: Plan approved by <@${userId}>. Starting execution...`,
      });
    } catch (err) {
      log.error("Failed to post approval message", { taskId, error: String(err) });
    }

    // Kick off execution (fire and forget — errors handled inside)
    executePlan(taskId, app).catch((err) => {
      log.error("executePlan threw unexpectedly", { taskId, error: String(err) });
    });
  });

  // ── Reject Plan ──
  app.action("reject_plan", async ({ ack, body }) => {
    await ack();

    const action = (body as any).actions?.[0];
    const taskId = action?.value;
    if (!taskId) return;

    const state = getTask(taskId);
    if (!state || state.currentPhase !== "awaiting_plan_approval") return;

    const userId = (body as any).user?.id;
    log.info("Plan rejected", { taskId, userId });
    await cancelPipeline(
      taskId,
      app,
      `Plan rejected by <@${userId}>. Pipeline cancelled.`
    );
  });
}
