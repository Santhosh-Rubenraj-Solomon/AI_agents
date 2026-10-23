/**
 * handlers/messageHandler.ts — Conversational chatbot for ECR questions.
 *
 * Listens to:
 *   - Direct messages (im channel type)
 *   - App mentions (@bot in channels)
 *
 * Ignores bot messages, pipeline button interactions, and slash commands.
 * Routes conversational questions to Claude via the chat() function.
 *
 * Each user may have at most one question in flight: every question spawns
 * a Claude CLI process, so unbounded concurrency would let a single user
 * (or a pasted loop) exhaust the host and the API budget.
 */

import type { App } from "@slack/bolt";
import { chat } from "../services/claudeAgent.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("MessageHandler");

/** Users with a chat() call currently running. */
const inFlightUsers = new Set<string>();

const BUSY_MESSAGE =
  ":hourglass_flowing_sand: I'm still working on your previous question -- I'll answer that first.";

/**
 * Register message and app_mention event handlers.
 */
export function registerMessageHandler(app: App): void {
  // ── Direct Messages ──
  app.event("message", async ({ event, say }) => {
    // Only handle IM (direct message) channels
    if ((event as any).channel_type !== "im") return;

    // Ignore bot messages, message_changed, message_deleted, etc.
    if ((event as any).subtype) return;

    // Ignore messages without text (e.g., file uploads only)
    const text = (event as any).text;
    if (!text || typeof text !== "string") return;

    // Ignore pipeline button interactions (these have their own handlers)
    // Button clicks don't come through as message events, but just in case
    if (text.startsWith("/")) return;

    const userId = (event as any).user;
    if (!userId) return;

    log.info("DM received", { userId, textLength: text.length });

    if (inFlightUsers.has(userId)) {
      await say(BUSY_MESSAGE);
      return;
    }
    inFlightUsers.add(userId);

    try {
      // Show typing indicator by reacting (Slack doesn't have a "typing" API for bots)
      const response = await chat(text);
      log.info("DM response sent", { userId, responseLength: response.length });

      // Truncate if needed (Slack has a 4000 char limit per message block)
      const truncated =
        response.length > 3900
          ? response.slice(0, 3900) + "\n\n_...response truncated_"
          : response;

      await say(truncated);
    } catch (err) {
      log.error("Chat failed", { userId, error: String(err) });
      await say(
        "Sorry, I ran into an error trying to answer that. Please try again in a moment."
      );
    } finally {
      inFlightUsers.delete(userId);
    }
  });

  // ── App Mentions (@bot in channels) ──
  app.event("app_mention", async ({ event, say }) => {
    const text = (event as any).text;
    if (!text || typeof text !== "string") return;

    // Strip the bot mention from the beginning of the message
    // Mentions look like: <@U12345> what is the ECR service?
    const cleanedText = text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();

    if (!cleanedText) {
      await say("Hey! Ask me anything about the ECR service.");
      return;
    }

    log.info("App mention received", { textLength: cleanedText.length });

    const userId: string | undefined = (event as any).user;
    const threadTsForReply = (event as any).thread_ts || (event as any).ts;
    if (userId && inFlightUsers.has(userId)) {
      await say({ text: BUSY_MESSAGE, thread_ts: threadTsForReply });
      return;
    }
    if (userId) inFlightUsers.add(userId);

    try {
      const response = await chat(cleanedText);
      log.info("App mention response sent", { responseLength: response.length });

      const truncated =
        response.length > 3900
          ? response.slice(0, 3900) + "\n\n_...response truncated_"
          : response;

      // Reply in thread if the mention was in a thread, otherwise just reply
      const threadTs = (event as any).thread_ts || (event as any).ts;
      await say({ text: truncated, thread_ts: threadTs });
    } catch (err) {
      log.error("Chat (mention) failed", { error: String(err) });
      await say({
        text: "Sorry, I ran into an error trying to answer that. Please try again in a moment.",
        thread_ts: (event as any).thread_ts || (event as any).ts,
      });
    } finally {
      if (userId) inFlightUsers.delete(userId);
    }
  });
}
