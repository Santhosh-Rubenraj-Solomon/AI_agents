/**
 * app.ts — Slack Bolt entry point with Socket Mode.
 *
 * Validates environment, initializes the database, registers
 * all handlers (including /ecr-resume), prunes orphaned worktrees,
 * starts the TTL timer, and marks in-flight tasks as failed on
 * restart (with guidance to use /ecr-resume for recovery).
 */

import { App } from "@slack/bolt";
import { CONFIG } from "./config.js";
import { createLogger } from "./utils/logger.js";
import { getDb, closeDb, markInFlightTasksFailed } from "./state/store.js";
import { startTtlTimer, stopTtlTimer, pruneOrphanedWorktrees } from "./state/ttl.js";

const log = createLogger("App");
import { registerSlashCommand } from "./handlers/slashCommandHandler.js";
import { registerModalSubmit, registerRequestApproval } from "./handlers/modalSubmitHandler.js";
import { registerPlanApproval } from "./handlers/planApprovalHandler.js";
import { registerMessageHandler } from "./handlers/messageHandler.js";
import { registerAppHome } from "./handlers/appHomeHandler.js";
import { registerResumeCommand } from "./handlers/resumeHandler.js";

// ─── Initialize Slack app ─────────────────────────────────────────────────────

const app = new App({
  token: CONFIG.slack.botToken,
  signingSecret: CONFIG.slack.signingSecret,
  socketMode: true,
  appToken: CONFIG.slack.appToken,
});

// ─── Register handlers ────────────────────────────────────────────────────────

registerSlashCommand(app);
registerResumeCommand(app);
registerModalSubmit(app);
registerRequestApproval(app);
registerPlanApproval(app);
registerMessageHandler(app);
registerAppHome(app);

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Initialize database (runs migrations)
  getDb();
  log.info("SQLite initialized", { path: CONFIG.db.path });

  // Mark any in-flight tasks as failed (from a previous crash).
  // Log each one so the admin knows they can use /ecr-resume.
  const failedTasks = markInFlightTasksFailed();
  if (failedTasks.length > 0) {
    log.warn("Marked in-flight tasks as failed on startup", { count: failedTasks.length });
    for (const t of failedTasks) {
      const hasWorktree = t.worktreePath ? "worktree exists" : "no worktree";
      log.warn(`  Recoverable task: ${t.taskId} (was in phase "${t.phase}", ${hasWorktree}). Use /ecr-resume ${t.taskId} to resume.`);
    }
  }

  // Prune orphaned git worktrees
  log.info("Pruning orphaned worktrees");
  await pruneOrphanedWorktrees();

  // Start stale task cleanup timer
  startTtlTimer(app);
  log.info("TTL timer started", { ttlMinutes: CONFIG.pipeline.taskTtlMinutes });

  // Start the Slack app
  await app.start();
  log.info("ECR Dev Factory running", {
    service: CONFIG.service.name,
    path: CONFIG.service.path,
    allowedPaths: CONFIG.allowedServicePaths,
    repo: CONFIG.repo.root,
    db: CONFIG.db.path,
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

/**
 * Stop accepting Slack events first, then stop timers and close SQLite
 * (closing the DB while a handler might still run would make it throw).
 * A second signal, or a hung app.stop(), forces exit.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    log.warn("Second shutdown signal received -- forcing exit", { signal });
    process.exit(1);
  }
  shuttingDown = true;
  log.info("Shutting down", { signal });

  const forceExit = setTimeout(() => {
    log.error("Graceful shutdown timed out -- forcing exit", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  let exitCode = 0;
  try {
    await app.stop();
  } catch (err) {
    exitCode = 1;
    log.error("Error stopping Slack app", { error: String(err) });
  }
  stopTtlTimer();
  try {
    closeDb();
  } catch (err) {
    exitCode = 1;
    log.error("Error closing SQLite", { error: String(err) });
  }
  clearTimeout(forceExit);
  log.info("Shutdown complete", { exitCode });
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// ─── Unhandled rejection safety net ───────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  log.error("Unhandled rejection", { reason: detail });
  // Don't crash — log it. The pipeline has its own error handling.
});

// ─── Bolt-level error handler ─────────────────────────────────────────────────

app.error(async (error) => {
  // Errors thrown from listeners end up here instead of being swallowed.
  log.error("Unhandled Slack listener error", { error: String(error) });
});

// ─── Start ────────────────────────────────────────────────────────────────────

start().catch((err) => {
  log.error("Failed to start ECR Dev Factory", { error: String(err) });
  try {
    closeDb();
  } catch {
    // Best effort
  }
  process.exit(1);
});
