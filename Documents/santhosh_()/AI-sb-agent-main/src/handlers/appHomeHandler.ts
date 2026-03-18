/**
 * handlers/appHomeHandler.ts — App Home tab.
 *
 * Shows a welcome message, usage instructions, and current
 * pipeline status when a user opens the bot's Home tab.
 */

import type { App } from "@slack/bolt";
import { getActiveTasks } from "../state/store.js";
import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("AppHome");

/**
 * Register the app_home_opened event handler.
 */
export function registerAppHome(app: App): void {
  app.event("app_home_opened", async ({ event, client }) => {
    // Only update for the "home" tab (not "messages")
    if (event.tab !== "home") return;

    log.debug("App Home opened", { userId: event.user });

    // Build active pipeline status
    const activeTasks = getActiveTasks();
    let statusText: string;

    if (activeTasks.length === 0) {
      statusText = "_No active pipelines._";
    } else {
      statusText = activeTasks
        .map(
          (t) =>
            `*${t.taskId}* — ${t.request.title}\n` +
            `  Phase: \`${t.currentPhase}\` | Priority: ${t.request.priority} | ` +
            `Requested by: <@${t.requesterId || t.request.userId}>`
        )
        .join("\n\n");
    }

    try {
      await client.views.publish({
        user_id: event.user,
        view: {
          type: "home",
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: "ECR Dev Factory",
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text:
                  `Welcome to the *ECR Dev Factory* bot! I help automate development tasks ` +
                  `for *${CONFIG.service.name}* and related services (${CONFIG.allowedServicePaths.join(", ")}).`,
              },
            },
            { type: "divider" },
            {
              type: "header",
              text: {
                type: "plain_text",
                text: "How to use /ecr",
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text:
                  `1. Type \`/ecr\` in any channel\n` +
                  `2. Fill out the task form (bug fix or feature request)\n` +
                  `3. Your request will be sent to the admin for approval\n` +
                  `4. Once approved, the pipeline runs automatically: *Analysis -> Execution -> Review -> MR*\n` +
                  `5. You'll get a DM when your merge request is ready`,
              },
            },
            { type: "divider" },
            {
              type: "header",
              text: {
                type: "plain_text",
                text: "Ask me questions",
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text:
                  `You can DM me or mention me in a channel to ask questions about the ECR service.\n\n` +
                  `*Examples:*\n` +
                  `- "How does the receipt printing module work?"\n` +
                  `- "What endpoints does the ECR service expose?"\n` +
                  `- "Explain the transaction flow"\n\n` +
                  `I can only answer questions about the *ECR service* — for other services, please ask the relevant team.`,
              },
            },
            { type: "divider" },
            {
              type: "header",
              text: {
                type: "plain_text",
                text: "Active Pipelines",
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: statusText,
              },
            },
          ],
        },
      });
    } catch (err) {
      log.error("Failed to publish home tab", { error: String(err) });
    }
  });
}
