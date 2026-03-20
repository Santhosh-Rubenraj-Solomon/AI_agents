/**
 * state/ttl.ts — Stale task cleanup timer.
 *
 * Runs on a configurable interval to:
 * 1. Cancel tasks stuck in awaiting_* phases past TTL
 * 2. Delete terminal tasks older than 24h
 * 3. Prune orphaned git worktrees at startup
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "../config.js";
import {
  getStaleTasks,
  getOldTerminalTaskIds,
  updateTask,
  deleteTask,
} from "./store.js";
import { removeWorktree } from "../services/gitService.js";
import type { SayFn } from "../types.js";
import type { App } from "@slack/bolt";
import { createSayFn } from "../types.js";

const execFileAsync = promisify(execFile);

const TERMINAL_CLEANUP_MS = 24 * 60 * 60 * 1000; // 24 hours
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
      console.error("[TTL] Cleanup error:", err);
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
    console.log(`[TTL] Cancelling stale task ${task.taskId} (phase: ${task.currentPhase})`);

    // Clean up worktree if it exists
    if (task.worktreePath) {
      try {
        await removeWorktree(task.worktreePath);
      } catch (err) {
        console.error(`[TTL] Failed to remove worktree for ${task.taskId}:`, err);
      }
    }

    // Mark as cancelled
    task.currentPhase = "cancelled";
    updateTask(task);

    // Notify the thread
    try {
      const say = createSayFn(app, task.request.channelId, task.request.threadTs);
      await say(
        `Task \`${task.taskId}\` has expired after ${CONFIG.pipeline.taskTtlMinutes} minutes ` +
        `of inactivity. Pipeline cancelled. Submit a new request to try again.`
      );
    } catch (err) {
      console.error(`[TTL] Failed to notify thread for ${task.taskId}:`, err);
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
    console.log(`[TTL] Deleted old terminal task ${id}`);
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
    console.log("[TTL] Pruned orphaned worktrees");
  } catch (err) {
    console.error("[TTL] Failed to prune worktrees:", err);
  }
}
