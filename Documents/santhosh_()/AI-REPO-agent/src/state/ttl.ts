/**
 * state/ttl.ts — Stale task cleanup timer.
 *
 * Runs on a configurable interval to:
 * 1. Cancel tasks stuck in awaiting_* phases past TTL
 * 2. Delete terminal tasks older than 24h
 * 3. Delete resolved admin-approval requests older than 24h (and
 *    never-answered ones older than 7 days)
 * 4. Prune orphaned git worktrees at startup
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "../config.js";
import {
  getStaleTasks,
  getOldTerminalTaskIds,
  updateTask,
  deleteTask,
  pruneOldPendingRequests,
  transitionPhase,
} from "./store.js";
import { removeWorktree } from "../services/gitService.js";
import type { App } from "@slack/bolt";
import { createBroadcastSayFn } from "../types.js";
import { createLogger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);
const log = createLogger("TTL");

const TERMINAL_CLEANUP_MS = 24 * 60 * 60 * 1000; // 24 hours
const PENDING_REQUEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CHECK_INTERVAL_MS = 60 * 1000; // check every minute

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the stale-task cleanup loop.
 */
export function startTtlTimer(app: App): void {
  if (timer) return;

  timer = setInterval(async () => {
    try {
      await cleanupStaleTasks(app);
      await cleanupTerminalTasks();
    } catch (err) {
      log.error("Cleanup error", { error: String(err) });
    }
  }, CHECK_INTERVAL_MS);

  // Don't keep the process alive just for cleanup
  timer.unref();
}

/**
 * Stop the cleanup timer.
 */
export function stopTtlTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Cancel tasks that have been awaiting approval too long.
 * Posts an expiration message to the Slack thread.
 */
async function cleanupStaleTasks(app: App): Promise<void> {
  const ttlMs = CONFIG.pipeline.taskTtlMinutes * 60 * 1000;
  const staleTasks = getStaleTasks(ttlMs);

  for (const task of staleTasks) {
    // Claim the cancellation atomically: if the admin approved the plan in
    // the meantime, the task is no longer awaiting approval — leave it alone.
    if (!transitionPhase(task.taskId, task.currentPhase, "cancelled")) continue;

    log.info("Cancelling stale task", { taskId: task.taskId, phase: task.currentPhase });

    // Clean up worktree if it exists
    if (task.worktreePath) {
      try {
        await removeWorktree(task.worktreePath);
      } catch (err) {
        log.error("Failed to remove worktree", { taskId: task.taskId, error: String(err) });
      }
    }

    // Mark as cancelled
    task.currentPhase = "cancelled";
    updateTask(task);

    // Notify the thread
    try {
      // Notify the admin thread and, if present, the requester's DM thread.
      const say = createBroadcastSayFn(
        app,
        task.request.channelId,
        task.request.threadTs,
        task.requesterChannelId,
        task.requesterThreadTs,
      );
      await say(
        `Task \`${task.taskId}\` has expired after ${CONFIG.pipeline.taskTtlMinutes} minutes ` +
        `of inactivity. Pipeline cancelled. Submit a new request to try again.`
      );
    } catch (err) {
      log.error("Failed to notify thread", { taskId: task.taskId, error: String(err) });
    }
  }
}

/**
 * Delete terminal tasks (complete/failed/cancelled) older than 24h.
 */
async function cleanupTerminalTasks(): Promise<void> {
  const oldIds = getOldTerminalTaskIds(TERMINAL_CLEANUP_MS);
  for (const id of oldIds) {
    deleteTask(id);
    log.info("Deleted old terminal task", { taskId: id });
  }

  const prunedRequests = pruneOldPendingRequests(TERMINAL_CLEANUP_MS, PENDING_REQUEST_MAX_AGE_MS);
  if (prunedRequests > 0) {
    log.info("Deleted old approval requests", { count: prunedRequests });
  }
}

/**
 * Prune orphaned worktrees at startup.
 * Runs `git worktree prune` in the monorepo root.
 */
export async function pruneOrphanedWorktrees(): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "prune"], {
      cwd: CONFIG.repo.root,
      timeout: 10_000,
    });
    log.info("Pruned orphaned worktrees");
  } catch (err) {
    log.error("Failed to prune worktrees", { error: String(err) });
  }
}
