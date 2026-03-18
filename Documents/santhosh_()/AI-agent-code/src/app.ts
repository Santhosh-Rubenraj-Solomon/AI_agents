/**
 * app.ts — Telegram bot entry point.
 *
 * Validates environment, initializes the database, registers all
 * command and message handlers, and starts the bot.
 */

import { Telegraf } from "telegraf";
import { CONFIG } from "./config.js";
import { createLogger } from "./utils/logger.js";
import { getDb, closeDb } from "./state/store.js";
import { registerCommands } from "./handlers/commands.js";
import { registerMessageHandler } from "./handlers/messageHandler.js";

const log = createLogger("App");

// ─── Initialize Telegram bot ─────────────────────────────────────────────────

const bot = new Telegraf(CONFIG.telegram.botToken);

// ─── Register handlers ──────────────────────────────────────────────────────

registerCommands(bot);
registerMessageHandler(bot);

// ─── Startup ─────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Initialize database
  getDb();
  log.info("SQLite initialized", { path: CONFIG.paths.db });

  // Set bot commands menu
  await bot.telegram.setMyCommands([
    { command: "analyze", description: "Clone & analyze a GitHub repo" },
    { command: "profile", description: "Show detected tech profile" },
    { command: "breaking", description: "Detect breaking changes" },
    { command: "bugfix", description: "Start bug fix guidance" },
    { command: "feature", description: "Plan feature implementation" },
    { command: "architecture", description: "Explore architecture" },
    { command: "summary", description: "Summarize conversation" },
    { command: "reset", description: "Clear session" },
    { command: "help", description: "Show help" },
  ]);

  // Start polling
  await bot.launch();

  log.info("AI Code Analyzer bot running", {
    aiEngine: CONFIG.ai.engine,
    reposDir: CONFIG.paths.reposBase,
    db: CONFIG.paths.db,
    allowedUsers: CONFIG.allowedUserIds.length || "all",
  });
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown(signal: string): void {
  log.info("Shutting down", { signal });
  bot.stop(signal);
  closeDb();
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// ─── Unhandled rejection safety net ──────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection", { reason: String(reason) });
});

// ─── Start ───────────────────────────────────────────────────────────────────

start().catch((err) => {
  log.error("Failed to start AI Code Analyzer", { error: String(err) });
  process.exit(1);
});
