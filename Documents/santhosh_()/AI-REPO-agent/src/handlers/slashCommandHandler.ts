/**
 * handlers/slashCommandHandler.ts — /ecr slash command + two-step modal flow.
 *
 * Step 1 Modal (ecr_type_select): Ask for type + priority.
 * Step 2 Modal (ecr_task_modal): Dynamic form tailored to the selected type.
 *
 * Slack modals don't support dynamic fields within a single modal,
 * so we use a two-step flow: submit step 1 -> open step 2 with
 * fields appropriate to the chosen request type.
 */

import type { App } from "@slack/bolt";
import { checkRateLimit } from "../middleware/rateLimit.js";
import { createLogger } from "../utils/logger.js";
import type { TaskType } from "../schemas.js";
import { getReviewers } from "../utils/reviewerCache.js";
import type { ReviewerInfo } from "../utils/reviewerCache.js";

const log = createLogger("SlashCommand");

/**
 * Register the /ecr slash command handler.
 */
export function registerSlashCommand(app: App): void {
  app.command("/ecr", async ({ command, ack, respond }) => {
    await ack();

    log.info("/ecr invoked", { userId: command.user_id, channelId: command.channel_id });

    // Rate limit check (no authorization check — anyone can submit, admin approves in DMs)
    const limit = checkRateLimit(command.user_id);
    if (!limit.allowed) {
      log.warn("Rate limited", { userId: command.user_id, retryAfterSeconds: limit.retryAfterSeconds });
      await respond({
        response_type: "ephemeral",
        text: `Please wait ${limit.retryAfterSeconds}s before submitting another task.`,
      });
      return;
    }

    // Open Step 1 modal (type + priority selection)
    try {
      await app.client.views.open({
        trigger_id: command.trigger_id,
        view: buildStep1Modal(command.channel_id),
      });
    } catch (err) {
      log.error("Failed to open modal", { error: String(err) });
      await respond({
        response_type: "ephemeral",
        text: "Failed to open the task form. Please try again.",
      });
    }
  });
}

// ─── Step 1 Modal: Type + Priority ───────────────────────────────────────────

/**
 * Build Step 1 modal — select type and priority.
 * callback_id: ecr_type_select
 */
function buildStep1Modal(channelId: string) {
  return {
    type: "modal" as const,
    callback_id: "ecr_type_select",
    private_metadata: JSON.stringify({ channelId }),
    title: { type: "plain_text" as const, text: "ECR Dev Factory" },
    submit: { type: "plain_text" as const, text: "Next" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Select the type of change and priority, then fill in the details on the next screen.",
        },
      },
      {
        type: "input",
        block_id: "type_block",
        label: { type: "plain_text", text: "Request Type" },
        element: {
          type: "static_select",
          action_id: "task_type",
          options: [
            { text: { type: "plain_text", text: "Bug Fix" }, value: "bugfix" },
            { text: { type: "plain_text", text: "Feature" }, value: "feature" },
            { text: { type: "plain_text", text: "Refactor" }, value: "refactor" },
            { text: { type: "plain_text", text: "Documentation" }, value: "documentation" },
          ],
        },
      },
      {
        type: "input",
        block_id: "priority_block",
        label: { type: "plain_text", text: "Priority" },
        element: {
          type: "static_select",
          action_id: "task_priority",
          options: [
            { text: { type: "plain_text", text: "Low" }, value: "low" },
            { text: { type: "plain_text", text: "Medium" }, value: "medium" },
            { text: { type: "plain_text", text: "High" }, value: "high" },
            { text: { type: "plain_text", text: "Critical" }, value: "critical" },
          ],
        },
      },
    ],
  };
}

// ─── Step 2 Modal Builders ───────────────────────────────────────────────────

/**
 * Metadata carried from Step 1 to Step 2.
 * Encoded in private_metadata of the Step 2 modal.
 */
export interface Step2Metadata {
  channelId: string;
  type: TaskType;
  priority: string;
}

/**
 * Build the Step 2 modal based on selected type.
 * callback_id: ecr_task_modal (same as before — submission handler processes final data).
 *
 * When reviewers are provided, the MR Reviewer field uses a static_select
 * limited to those users. When null/undefined, falls back to multi_users_select
 * showing all workspace members.
 */
export function buildStep2Modal(meta: Step2Metadata, reviewers?: ReviewerInfo[] | null) {
  const blocks = getBlocksForType(meta.type, reviewers ?? null);

  return {
    type: "modal" as const,
    callback_id: "ecr_task_modal",
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text" as const, text: "ECR Dev Factory" },
    submit: { type: "plain_text" as const, text: "Submit" },
    blocks,
  };
}

/**
 * Return Slack Block Kit blocks appropriate for the given task type.
 * When reviewers is non-null, the reviewer field is a static multi-select
 * limited to those users; otherwise it's a multi_users_select (all members).
 */
function getBlocksForType(type: TaskType, reviewers: ReviewerInfo[] | null): object[] {
  const blocks: object[] = [];

  // Header showing the selected type
  const typeLabels: Record<TaskType, string> = {
    bugfix: "Bug Fix",
    feature: "Feature",
    refactor: "Refactor",
    documentation: "Documentation",
  };

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Request Type:* ${typeLabels[type]}`,
    },
  });

  // Title — common to all types
  blocks.push({
    type: "input",
    block_id: "title_block",
    label: { type: "plain_text", text: "Title" },
    element: {
      type: "plain_text_input",
      action_id: "task_title",
      placeholder: {
        type: "plain_text",
        text: getTitlePlaceholder(type),
      },
    },
  });

  // Type-specific fields
  switch (type) {
    case "bugfix":
      blocks.push(
        {
          type: "input",
          block_id: "problem_block",
          label: { type: "plain_text", text: "Problem Description" },
          element: {
            type: "plain_text_input",
            action_id: "problem_description",
            multiline: true,
            placeholder: {
              type: "plain_text",
              text: "Explain the bug/problem in detail...",
            },
          },
        },
        {
          type: "input",
          block_id: "solution_block",
          label: { type: "plain_text", text: "Proposed Solution" },
          element: {
            type: "plain_text_input",
            action_id: "proposed_solution",
            multiline: true,
            placeholder: {
              type: "plain_text",
              text: "Describe the fix you want implemented...",
            },
          },
        }
      );
      break;

    case "feature":
      blocks.push(
        {
          type: "input",
          block_id: "feature_desc_block",
          label: { type: "plain_text", text: "Feature Description" },
          element: {
            type: "plain_text_input",
            action_id: "feature_description",
            multiline: true,
            placeholder: {
              type: "plain_text",
              text: "What is the feature? Describe in detail...",
            },
          },
        },
        {
          type: "input",
          block_id: "needs_endpoints_block",
          label: { type: "plain_text", text: "Needs New Endpoints?" },
          element: {
            type: "static_select",
            action_id: "needs_endpoints",
            options: [
              { text: { type: "plain_text", text: "No" }, value: "no" },
              { text: { type: "plain_text", text: "Yes" }, value: "yes" },
            ],
          },
        },
        // Endpoint details — always shown for features, optional to fill
        {
          type: "input",
          block_id: "num_endpoints_block",
          label: { type: "plain_text", text: "Number of Endpoints" },
          optional: true,
          element: {
            type: "plain_text_input",
            action_id: "num_endpoints",
            placeholder: { type: "plain_text", text: "e.g. 2" },
          },
        },
        {
          type: "input",
          block_id: "gateway_header_block",
          label: { type: "plain_text", text: "Gateway Header Name" },
          optional: true,
          element: {
            type: "plain_text_input",
            action_id: "gateway_header",
            placeholder: { type: "plain_text", text: "e.g. ecr-receipts" },
          },
        },
        {
          type: "input",
          block_id: "controller_header_block",
          label: { type: "plain_text", text: "Controller Header Name" },
          optional: true,
          element: {
            type: "plain_text_input",
            action_id: "controller_header",
            placeholder: { type: "plain_text", text: "e.g. ReceiptsController" },
          },
        },
        {
          type: "input",
          block_id: "foreshore_expose_block",
          label: { type: "plain_text", text: "Expose on Foreshore?" },
          optional: true,
          element: {
            type: "static_select",
            action_id: "foreshore_expose",
            options: [
              { text: { type: "plain_text", text: "No" }, value: "no" },
              { text: { type: "plain_text", text: "Yes" }, value: "yes" },
            ],
          },
        },
        {
          type: "input",
          block_id: "foreshore_url_block",
          label: { type: "plain_text", text: "Foreshore URL Path" },
          optional: true,
          element: {
            type: "plain_text_input",
            action_id: "foreshore_url",
            placeholder: { type: "plain_text", text: "e.g. /ecr/receipts/:receiptId" },
          },
        },
        {
          type: "input",
          block_id: "foreshore_params_block",
          label: { type: "plain_text", text: "Foreshore Params" },
          optional: true,
          element: {
            type: "plain_text_input",
            action_id: "foreshore_params",
            placeholder: { type: "plain_text", text: "comma-separated param names, e.g. receiptId,storeId" },
          },
        },
        {
          type: "input",
          block_id: "foreshore_query_block",
          label: { type: "plain_text", text: "Foreshore Query Params" },
          optional: true,
          element: {
            type: "plain_text_input",
            action_id: "foreshore_query_params",
            placeholder: { type: "plain_text", text: "comma-separated query param names, e.g. startDate,endDate" },
          },
        }
      );
      break;

    case "refactor":
      blocks.push({
        type: "input",
        block_id: "refactor_desc_block",
        label: { type: "plain_text", text: "What to Refactor" },
        element: {
          type: "plain_text_input",
          action_id: "refactor_description",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "Describe what needs refactoring and why...",
          },
        },
      });
      break;

    case "documentation":
      blocks.push({
        type: "input",
        block_id: "docs_desc_block",
        label: { type: "plain_text", text: "What to Document" },
        element: {
          type: "plain_text_input",
          action_id: "documentation_description",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "Describe what needs documentation...",
          },
        },
      });
      break;
  }

  // MR Reviewer(s) — common optional field.
  // When a reviewer channel is configured, use a static multi-select limited
  // to that channel's members. Otherwise fall back to multi_users_select.
  blocks.push(
    { type: "divider" },
    {
      type: "input",
      block_id: "reviewer_block",
      label: { type: "plain_text", text: "MR Reviewer(s)" },
      optional: true,
      element: buildReviewerElement(reviewers),
    }
  );

  // Branch name — common optional field at the bottom
  blocks.push(
    {
      type: "input",
      block_id: "branch_block",
      label: { type: "plain_text", text: "Branch Name (optional)" },
      optional: true,
      element: {
        type: "plain_text_input",
        action_id: "branch_name",
        placeholder: {
          type: "plain_text",
          text: "Auto-generated if empty (max 30 chars, e.g. fix/receipt-reprint)",
        },
      },
    }
  );

  return blocks;
}

/**
 * Build the reviewer element — either a static multi-select (when reviewers
 * are provided from a specific channel) or a multi_users_select (all members).
 */
function buildReviewerElement(reviewers: ReviewerInfo[] | null): object {
  if (reviewers && reviewers.length > 0) {
    return {
      type: "multi_static_select",
      action_id: "mr_reviewers",
      placeholder: {
        type: "plain_text",
        text: "Select reviewer(s) for the merge request",
      },
      options: reviewers.map((r) => ({
        text: { type: "plain_text", text: r.displayName },
        value: r.slackId,
      })),
    };
  }

  // Fallback: show all workspace members
  return {
    type: "multi_users_select",
    action_id: "mr_reviewers",
    placeholder: {
      type: "plain_text",
      text: "Select reviewer(s) for the merge request",
    },
  };
}

function getTitlePlaceholder(type: TaskType): string {
  switch (type) {
    case "bugfix":
      return "e.g. Fix receipt reprint on voided transactions";
    case "feature":
      return "e.g. Add tips summary to Z report endpoint";
    case "refactor":
      return "e.g. Consolidate report service methods";
    case "documentation":
      return "e.g. Document Z report calculation logic";
  }
}
