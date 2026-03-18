/**
 * handlers/commands.ts — Telegram bot command handlers.
 *
 * Registers all bot commands:
 *   /start       — Welcome message
 *   /analyze     — Clone and analyze a GitHub repo
 *   /profile     — Show detected tech profile
 *   /breaking    — Detect breaking changes
 *   /bugfix      — Start bug fix Q&A flow
 *   /feature     — Start feature implementation Q&A flow
 *   /architecture — Start architecture Q&A flow
 *   /summary     — Generate conversation summary
 *   /reset       — Clear current session
 *   /help        — Show available commands
 */

import { Telegraf, Context } from "telegraf";
import { v4 as uuidv4 } from "uuid";
import { cloneOrPullRepo } from "../services/github.js";
import { detectTechProfile } from "../services/techDetector.js";
import { analyzeCodebase } from "../agents/analyzer.js";
import { detectBreakingChanges } from "../agents/breakingChange.js";
import { generateInitialQuestions } from "../agents/advisor.js";
import {
  getSession,
  createSession,
  updateSession,
  deleteSession,
  type SessionRow
} from "../state/store.js";
import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import type {
  TechProfile,
  AnalysisResult,
  TaskType,
  ConversationContext
} from "../types.js";

const log = createLogger("Commands");

// ─── Access control ──────────────────────────────────────────────────────────

function isAllowed(userId: number): boolean {
  if (CONFIG.allowedUserIds.length === 0) return true;
  return CONFIG.allowedUserIds.includes(String(userId));
}

// ─── Format helpers ──────────────────────────────────────────────────────────

function formatProfile(profile: TechProfile): string {
  const langs = profile.languages
    .slice(0, 8)
    .map((l) => `  • ${l.name}: ${l.percentage}% (${l.fileCount} files)`)
    .join("\n");

  return `🔍 *Tech Profile*

📝 *Languages:*
${langs}

🏗 *Architecture:* ${profile.architecture}
📦 *Frameworks:* ${profile.frameworks.join(", ") || "none"}
🗄 *Databases:* ${profile.databases.join(", ") || "none"}
🔧 *Build Tools:* ${profile.buildTools.join(", ") || "none"}
🧪 *Test Frameworks:* ${profile.testFrameworks.join(", ") || "none"}
📏 *Linters:* ${profile.linters.join(", ") || "none"}
🚀 *CI/CD:* ${profile.ciCd.join(", ") || "none"}
📂 *Package Manager:* ${profile.packageManager}
📄 *Total Files:* ${profile.totalFiles}
📊 *Est. Lines:* ~${profile.totalLinesEstimate.toLocaleString()}
🚪 *Entry Points:* ${profile.entryPoints.join(", ") || "none found"}`;
}

function formatAnalysis(analysis: AnalysisResult): string {
  const components = analysis.keyComponents
    .slice(0, 10)
    .map((c) => `  • \`${c.path}\` — ${c.name} (${c.type}): ${c.purpose}`)
    .join("\n");

  const endpoints = analysis.apiEndpoints
    .slice(0, 10)
    .map((e) => `  • \`${e.method} ${e.path}\` — ${e.description}`)
    .join("\n");

  const models = analysis.dataModels
    .slice(0, 5)
    .map((m) => `  • *${m.name}* — ${m.fields.slice(0, 5).join(", ")}`)
    .join("\n");

  const concerns = analysis.concerns
    .slice(0, 5)
    .map((c) => `  ⚠️ ${c}`)
    .join("\n");

  const strengths = analysis.strengths
    .slice(0, 5)
    .map((s) => `  ✅ ${s}`)
    .join("\n");

  return `📊 *Deep Analysis*

*Summary:* ${analysis.summary}

*Architecture:* ${analysis.architecture}

🧩 *Key Components:*
${components || "  None detected"}

🔌 *API Endpoints:*
${endpoints || "  None detected"}

📋 *Data Models:*
${models || "  None detected"}

⚠️ *Concerns:*
${concerns || "  None"}

✅ *Strengths:*
${strengths || "  None noted"}`;
}

// ─── Register all commands ───────────────────────────────────────────────────

export function registerCommands(bot: Telegraf): void {
  // /start
  bot.start((ctx) => {
    if (!isAllowed(ctx.from.id)) {
      return ctx.reply("⛔ You are not authorized to use this bot.");
    }
    return ctx.reply(
      `🤖 *AI Code Analyzer*

I analyze open-source GitHub repositories and help you:
• Detect tech stack, architecture & data models
• Find breaking changes before they ship
• Guide bug fixes with targeted questions
• Plan feature implementations end-to-end
• Understand codebase architecture

*Quick Start:*
Send me a GitHub URL to begin!
Example: https://github.com/expressjs/express

Or use /help to see all commands.`,
      { parse_mode: "Markdown" }
    );
  });

  // /help
  bot.help((ctx) => {
    return ctx.reply(
      `📋 *Available Commands:*

/analyze <github-url> — Clone & analyze a repo
/profile — Show detected tech profile
/breaking [commits] — Detect breaking changes
/bugfix — Start bug fix guidance flow
/feature — Start feature implementation flow
/architecture — Explore codebase architecture
/summary — Summarize current conversation
/reset — Clear session & start fresh
/help — Show this message

💡 *Tip:* Just paste a GitHub URL to auto-analyze!`,
      { parse_mode: "Markdown" }
    );
  });

  // /analyze <url>
  bot.command("analyze", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return ctx.reply("⛔ Not authorized.");

    const args = ctx.message.text.split(" ").slice(1);
    const url = args[0];

    if (!url || !url.includes("github.com")) {
      return ctx.reply(
        "Usage: /analyze <github-url>\nExample: /analyze https://github.com/expressjs/express"
      );
    }

    await runAnalysis(ctx, url);
  });

  // /profile
  bot.command("profile", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return ctx.reply("⛔ Not authorized.");

    const session = getSession(ctx.chat.id);
    if (!session?.profile_json) {
      return ctx.reply(
        "No repo analyzed yet. Use /analyze <github-url> first."
      );
    }

    try {
      const profile = JSON.parse(session.profile_json) as TechProfile;
      return ctx.reply(formatProfile(profile), { parse_mode: "Markdown" });
    } catch {
      return ctx.reply("Profile data is corrupted. Try /analyze again.");
    }
  });

  // /breaking [commits]
  bot.command("breaking", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return ctx.reply("⛔ Not authorized.");

    const session = getSession(ctx.chat.id);
    if (!session?.repo_local_path || !session?.profile_json) {
      return ctx.reply(
        "No repo analyzed yet. Use /analyze <github-url> first."
      );
    }

    const args = ctx.message.text.split(" ").slice(1);
    const commits = parseInt(args[0]) || 5;

    await ctx.reply(
      `🔍 Analyzing last ${commits} commits for breaking changes...`
    );

    try {
      const profile = JSON.parse(session.profile_json) as TechProfile;
      const result = await detectBreakingChanges(
        session.repo_local_path,
        profile,
        commits
      );

      if (!result.success || !result.data) {
        return ctx.reply(`❌ ${result.message}`);
      }

      const bc = result.data;
      const riskEmoji =
        bc.riskLevel === "BREAKING"
          ? "🔴"
          : bc.riskLevel === "HIGH"
          ? "🟠"
          : bc.riskLevel === "MEDIUM"
          ? "🟡"
          : "🟢";

      let msg = `${riskEmoji} *Breaking Change Analysis*\n\n*Risk Level:* ${
        bc.riskLevel
      }\n*Change Types:* ${bc.changeType.join(", ")}\n`;

      if (bc.affectedConsumers.length > 0) {
        msg += `*Affected Consumers:* ${bc.affectedConsumers.join(", ")}\n`;
      }

      if (bc.findings.length > 0) {
        msg += `\n*Findings:*\n`;
        for (const f of bc.findings.slice(0, 10)) {
          const icon = f.breaking ? "🔴" : "🟢";
          msg += `${icon} \`${f.file}\`: ${f.change}\n   Impact: ${f.impact}\n`;
        }
      }

      if (bc.recommendations.length > 0) {
        msg += `\n*Recommendations:*\n`;
        for (const r of bc.recommendations) {
          msg += `• ${r}\n`;
        }
      }

      // Checklist
      const cl = bc.checklist;
      msg += `\n*Checklist:*\n`;
      msg += `${cl.dtosChecked ? "✅" : "❌"} DTOs checked\n`;
      msg += `${cl.enumsChecked ? "✅" : "❌"} Enums checked\n`;
      msg += `${cl.typesChecked ? "✅" : "❌"} Types checked\n`;
      msg += `${cl.defaultsChecked ? "✅" : "❌"} Defaults checked\n`;
      msg += `${cl.databaseChecked ? "✅" : "❌"} Database checked\n`;
      msg += `${cl.messagesChecked ? "✅" : "❌"} Messages checked\n`;
      msg += `${cl.consumersChecked ? "✅" : "❌"} Consumers checked\n`;
      msg += `${cl.rollbackChecked ? "✅" : "❌"} Rollback checked`;

      return ctx.reply(msg, { parse_mode: "Markdown" });
    } catch (err) {
      return ctx.reply(`❌ Error: ${(err as Error).message}`);
    }
  });

  // /bugfix, /feature, /architecture — start Q&A flows
  for (const cmd of ["bugfix", "feature", "architecture"] as const) {
    bot.command(cmd, async (ctx) => {
      if (!isAllowed(ctx.from.id)) return ctx.reply("⛔ Not authorized.");

      const session = getSession(ctx.chat.id);
      if (!session?.repo_local_path) {
        return ctx.reply(
          "No repo analyzed yet. Use /analyze <github-url> first."
        );
      }

      const taskType: TaskType = cmd === "architecture" ? "architecture" : cmd;
      const questions = generateInitialQuestions(taskType);

      updateSession({
        session_id: session.session_id,
        task_type: taskType,
        current_phase: "awaiting_input",
        conversation_history: JSON.stringify([])
      });

      const taskLabels: Record<string, string> = {
        bugfix: "🐛 Bug Fix",
        feature: "✨ Feature Implementation",
        architecture: "🏗 Architecture Review"
      };

      let msg = `${taskLabels[cmd]} *Mode Activated*\n\nI'll guide you through this step by step. Let's start:\n\n`;
      msg += `*Question 1/${questions.length}:*\n${questions[0]}`;

      return ctx.reply(msg, { parse_mode: "Markdown" });
    });
  }

  // /summary
  bot.command("summary", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return ctx.reply("⛔ Not authorized.");

    const session = getSession(ctx.chat.id);
    if (!session) {
      return ctx.reply("No active session. Use /analyze <github-url> first.");
    }

    let history: Array<{ role: "user" | "assistant"; content: string }>;
    try {
      history = JSON.parse(session.conversation_history || "[]");
    } catch {
      history = [];
    }
    if (history.length === 0) {
      return ctx.reply("No conversation history to summarize.");
    }

    await ctx.reply("📝 Generating summary...");

    try {
      const { generateTaskSummary } = await import("../agents/advisor.js");
      const profile = session.profile_json
        ? (JSON.parse(session.profile_json) as TechProfile)
        : null;
      if (!profile || !session.repo_local_path) {
        return ctx.reply("Missing profile or repo data.");
      }

      const context: ConversationContext = {
        sessionId: session.session_id,
        repoUrl: session.repo_url || "",
        taskType: (session.task_type || "general") as TaskType,
        profile,
        questions: history,
        currentStep: history.length,
        totalSteps: 5
      };

      const summary = await generateTaskSummary(
        context,
        profile,
        session.repo_local_path
      );
      return ctx.reply(summary, { parse_mode: "Markdown" });
    } catch (err) {
      return ctx.reply(`❌ Error: ${(err as Error).message}`);
    }
  });

  // /reset
  bot.command("reset", (ctx) => {
    const session = getSession(ctx.chat.id);
    if (session) {
      deleteSession(session.session_id);
    }
    return ctx.reply("🔄 Session cleared. Send a GitHub URL to start fresh!");
  });

  log.info("All commands registered");
}

// ─── Core analysis flow ──────────────────────────────────────────────────────

export async function runAnalysis(ctx: Context, url: string): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  await ctx.reply(`📥 Cloning repository...\n\`${url}\``);

  try {
    // Step 1: Clone
    const repo = await cloneOrPullRepo(url);
    await ctx.reply(
      `✅ Repository cloned: \`${repo.owner}/${repo.name}\` (branch: ${repo.defaultBranch})`
    );

    // Step 2: Tech detection (fast, no AI)
    await ctx.reply("🔍 Detecting tech stack...");
    const profile = detectTechProfile(repo.localPath);

    // Create/update session
    const sessionId = uuidv4().slice(0, 12);
    const existing = getSession(chatId);
    if (existing) {
      updateSession({
        session_id: existing.session_id,
        repo_url: url,
        repo_local_path: repo.localPath,
        current_phase: "profiling",
        profile_json: JSON.stringify(profile),
        analysis_json: null,
        conversation_history: "[]",
        task_type: null
      });
    } else {
      createSession({
        session_id: sessionId,
        chat_id: chatId,
        user_id: userId,
        repo_url: url,
        repo_local_path: repo.localPath,
        current_phase: "profiling",
        task_type: null,
        profile_json: JSON.stringify(profile),
        analysis_json: null,
        conversation_history: "[]",
        created_at: Date.now(),
        updated_at: Date.now()
      });
    }

    await ctx.reply(formatProfile(profile), { parse_mode: "Markdown" });

    // Step 3: Deep AI analysis
    await ctx.reply(
      "🧠 Running deep AI analysis... (this may take 1-2 minutes)"
    );
    const analysisResult = await analyzeCodebase(repo.localPath, profile);

    const session = getSession(chatId)!;
    if (analysisResult.success && analysisResult.data) {
      updateSession({
        session_id: session.session_id,
        current_phase: "idle",
        analysis_json: JSON.stringify(analysisResult.data)
      });

      await ctx.reply(formatAnalysis(analysisResult.data), {
        parse_mode: "Markdown"
      });

      await ctx.reply(
        `✅ *Analysis Complete!*

What would you like to do next?
• /bugfix — Get help fixing a bug
• /feature — Plan a new feature
• /breaking — Check for breaking changes
• /architecture — Explore the architecture
• Or just ask me anything about the codebase!`,
        { parse_mode: "Markdown" }
      );
    } else {
      updateSession({
        session_id: session.session_id,
        current_phase: "idle"
      });
      await ctx.reply(
        `⚠️ AI analysis partially failed: ${analysisResult.message}\n\nTech profile is available. You can still use /bugfix, /feature, /breaking commands.`
      );
    }
  } catch (err) {
    log.error("Analysis flow failed", { error: (err as Error).message });
    await ctx.reply(`❌ Failed: ${(err as Error).message}`);
  }
}
