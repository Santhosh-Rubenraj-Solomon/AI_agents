/**
 * handlers/messageHandler.ts — Handles free-text messages in Telegram.
 *
 * Routes messages based on session state:
 * - If no session: check if it's a GitHub URL to auto-analyze
 * - If in Q&A flow: forward to advisor agent
 * - If idle with session: treat as general question about the repo
 */

import { Telegraf } from "telegraf";
import { getSession, updateSession } from "../state/store.js";
import {
  generateAdvisorResponse,
  generateInitialQuestions
} from "../agents/advisor.js";
import { runAnalysis } from "./commands.js";
import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import type {
  TechProfile,
  AnalysisResult,
  TaskType,
  ConversationContext
} from "../schemas.js";

const log = createLogger("MessageHandler");

function isAllowed(userId: number): boolean {
  if (CONFIG.allowedUserIds.length === 0) return true;
  return CONFIG.allowedUserIds.includes(String(userId));
}

function isGitHubUrl(text: string): boolean {
  return /https?:\/\/github\.com\/[^/]+\/[^/\s]+/.test(text);
}

export function registerMessageHandler(bot: Telegraf): void {
  bot.on("text", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return;

    const text = ctx.message.text;

    // Skip if it's a command
    if (text.startsWith("/")) return;

    // Check if it's a GitHub URL — auto-analyze
    if (isGitHubUrl(text)) {
      const urlMatch = text.match(/https?:\/\/github\.com\/[^\s]+/);
      if (urlMatch) {
        return runAnalysis(ctx, urlMatch[0].replace(/[.,;!?]+$/, ""));
      }
    }

    // Get current session
    const session = getSession(ctx.chat.id);
    if (!session) {
      return ctx.reply(
        "👋 Send me a GitHub repository URL to get started!\n\nExample: https://github.com/expressjs/express\n\nOr use /help to see all commands."
      );
    }

    // If no repo analyzed yet
    if (!session.repo_local_path || !session.profile_json) {
      return ctx.reply(
        "No repo analyzed yet. Send me a GitHub URL or use /analyze <url>"
      );
    }

    // Parse stored data
    let profile: TechProfile;
    let analysis: AnalysisResult | null = null;
    try {
      profile = JSON.parse(session.profile_json) as TechProfile;
      if (session.analysis_json) {
        analysis = JSON.parse(session.analysis_json) as AnalysisResult;
      }
    } catch {
      return ctx.reply("Session data is corrupted. Use /reset and try again.");
    }

    // Build conversation context
    let history: Array<{ role: "user" | "assistant"; content: string }>;
    try {
      history = JSON.parse(session.conversation_history || "[]");
    } catch {
      history = [];
    }
    const taskType: TaskType = (session.task_type as TaskType) || "general";

    // If in a Q&A flow, check if we should ask the next question or generate a response
    const questions = generateInitialQuestions(taskType);
    const currentStep = Math.floor(history.length / 2); // Each step = 1 user + 1 assistant message

    // Add user message to history
    history.push({ role: "user", content: text });

    const context: ConversationContext = {
      sessionId: session.session_id,
      repoUrl: session.repo_url || "",
      taskType,
      profile,
      questions: history,
      currentStep,
      totalSteps: questions.length
    };

    // Show typing indicator
    await ctx.sendChatAction("typing");

    try {
      // Generate AI response
      const response = await generateAdvisorResponse(
        context,
        text,
        profile,
        analysis,
        session.repo_local_path
      );

      // Add assistant response to history
      history.push({ role: "assistant", content: response });

      // Update session
      updateSession({
        session_id: session.session_id,
        conversation_history: JSON.stringify(history),
        current_phase: "awaiting_input"
      });

      // If in a structured flow and there are more questions, append the next one
      if (taskType !== "general" && currentStep < questions.length - 1) {
        const nextQ = questions[currentStep + 1];
        const fullResponse = `${response}\n\n---\n\n*Question ${
          currentStep + 2
        }/${questions.length}:*\n${nextQ}`;

        // Split long messages (Telegram has 4096 char limit)
        if (fullResponse.length > 4000) {
          await ctx.reply(response);
          await ctx.reply(
            `*Question ${currentStep + 2}/${questions.length}:*\n${nextQ}`,
            { parse_mode: "Markdown" }
          );
        } else {
          await ctx.reply(fullResponse, { parse_mode: "Markdown" });
        }
      } else {
        // Split long messages
        if (response.length > 4000) {
          const chunks = splitMessage(response, 4000);
          for (const chunk of chunks) {
            await ctx.reply(chunk);
          }
        } else {
          await ctx.reply(response);
        }
      }
    } catch (err) {
      log.error("Message handling failed", { error: (err as Error).message });
      await ctx.reply(
        `❌ Error generating response: ${
          (err as Error).message
        }\n\nTry rephrasing your question.`
      );
    }
  });

  log.info("Message handler registered");
}

function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Find a good split point (newline or space)
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength / 2)
      splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}
