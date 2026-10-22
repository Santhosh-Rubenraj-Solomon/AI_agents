/**
 * utils/slackFileUpload.ts — Slack .md file upload helper.
 *
 * Shared utility for uploading markdown documents as downloadable .md files
 * to Slack threads. Used by the summary service, coordinator, and summary
 * writer agent integration.
 *
 * Uses `client.files.uploadV2` which is the current recommended API for
 * file uploads in Slack.
 */

import type { WebClient } from "@slack/web-api";
import { createLogger } from "./logger.js";
import { redactSecrets } from "./redact.js";

const log = createLogger("SlackFileUpload");

/**
 * Upload a markdown document as a .md file to a Slack thread.
 *
 * @param client     - Slack WebClient (from app.client)
 * @param channelId  - The channel to upload to
 * @param threadTs   - Thread timestamp (file appears in-thread)
 * @param filename   - Descriptive filename (e.g., "execution-plan-abc123.md")
 * @param content    - The markdown content to upload
 * @param message    - Optional brief context message shown alongside the file
 */
export async function uploadMdToSlack(
  client: WebClient,
  channelId: string,
  threadTs: string,
  filename: string,
  content: string,
  message?: string,
): Promise<void> {
  log.info("Uploading .md file to Slack", {
    channelId,
    threadTs,
    filename,
    contentLength: content.length,
  });

  try {
    await client.files.uploadV2({
      channel_id: channelId,
      thread_ts: threadTs,
      filename,
      content: redactSecrets(content),
      initial_comment: redactSecrets(message ?? `Attached: ${filename}`),
    });

    log.info("File uploaded successfully", { filename });
  } catch (err) {
    const error = err as Error;
    log.error("Failed to upload .md file to Slack", {
      filename,
      error: error.message,
    });
    throw new Error(`Slack file upload failed for ${filename}: ${error.message}`);
  }
}
