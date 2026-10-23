/**
 * handlers/planApprovalHandler.ts — Approve/reject plan buttons.
 *
 * Looks up the task from SQLite by the button value (taskId).
 * Only the admin (CONFIG.adminUserId) may approve or reject a plan — the
 * requester can follow progress but never approve their own plan.
 * The awaiting_plan_approval -> next phase transition is done atomically,
 * so a double click cannot start two executions.
 */

import type { App } from "@slack/bolt";
import { CONFIG } from "../config.js";
import { getTask, transitionPhase } from "../state/store.js";
import { executePlan, cancelPipeline } from "../pipeline/coordinator.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("PlanApproval");

/**
 * Tell a non-admin clicker (ephemerally) that they cannot act on the plan.
 */
async function rejectUnauthorisedClick(app: App, body: any, verb: string): Promise<void> {
  const userId = body?.user?.id;
  const channelId = body?.channel?.id;
  if (!userId || !channelId) return;
  try {
    await app.client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: `:lock: Only the admin can ${verb} plans.`,
    });
  } catch (err) {
    log.warn("Failed to send unauthorised-click notice", { userId, error: String(err) });
  }
}

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

    const userId = (body as any).user?.id;
    if (userId !== CONFIG.adminUserId) {
      log.warn("Non-admin attempted to approve a plan", { taskId, userId });
      await rejectUnauthorisedClick(app, body, "approve");
      return;
    }

    const state = getTask(taskId);
    if (!state || state.currentPhase !== "awaiting_plan_approval") {
      log.warn("Task not in awaiting_plan_approval", { taskId, currentPhase: state?.currentPhase });
      return;
    }

    // Claim the transition before any await, so a second click is a no-op.
    if (!transitionPhase(taskId, "awaiting_plan_approval", "executing")) {
      log.warn("Plan approval already handled", { taskId });
      return;
    }

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

    const userId = (body as any).user?.id;
    if (userId !== CONFIG.adminUserId) {
      log.warn("Non-admin attempted to reject a plan", { taskId, userId });
      await rejectUnauthorisedClick(app, body, "reject");
      return;
    }

    const state = getTask(taskId);
    if (!state || state.currentPhase !== "awaiting_plan_approval") return;

    if (!transitionPhase(taskId, "awaiting_plan_approval", "cancelled")) {
      log.warn("Plan rejection already handled", { taskId });
      return;
    }

    log.info("Plan rejected", { taskId, userId });
    try {
      await cancelPipeline(
        taskId,
        app,
        `Plan rejected by <@${userId}>. Pipeline cancelled.`
      );
    } catch (err) {
      log.error("cancelPipeline threw unexpectedly", { taskId, error: String(err) });
    }
  });
}
