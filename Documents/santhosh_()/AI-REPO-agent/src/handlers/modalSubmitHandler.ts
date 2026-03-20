/**
 * handlers/modalSubmitHandler.ts — Two-step modal form submission.
 *
 * Step 1 (ecr_type_select): Reads type + priority, opens Step 2 modal.
 * Step 2 (ecr_task_modal): Validates full input with Zod, then routes:
 *   - Admin submitter: skip approval, start pipeline immediately.
 *   - Non-admin submitter: send to admin DM with approve/reject buttons.
 */

import type { App } from "@slack/bolt";
import {
  TaskRequestSchema,
  generateBranchName,
  validateBranchName,
  getTypeLabel,
} from "../schemas.js";
import type { TaskType } from "../schemas.js";
import { startPipeline } from "../pipeline/coordinator.js";
import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { buildStep2Modal } from "./slashCommandHandler.js";
import type { Step2Metadata } from "./slashCommandHandler.js";
import { getReviewers } from "../utils/reviewerCache.js";

const log = createLogger("ModalSubmit");

/**
 * Register both modal submission handlers.
 */
export function registerModalSubmit(app: App): void {
  // ── Step 1: Type + Priority selection ──
  registerStep1Handler(app);

  // ── Step 2: Full task submission ──
  registerStep2Handler(app);
}

// ─── Step 1 Handler ──────────────────────────────────────────────────────────

function registerStep1Handler(app: App): void {
  app.view("ecr_type_select", async ({ ack, body, view }) => {
    const vals = view.state.values;

    const type = (vals.type_block?.task_type?.selected_option?.value || "bugfix") as TaskType;
    const priority = vals.priority_block?.task_priority?.selected_option?.value || "medium";

    // Parse channelId from Step 1 metadata
    let channelId: string;
    try {
      const meta = JSON.parse(view.private_metadata || "{}");
      channelId = meta.channelId;
    } catch {
      log.error("Failed to parse Step 1 private_metadata");
      await ack();
      return;
    }

    log.info("Step 1 submitted", { type, priority, channelId });

    // Fetch reviewer list (null if REVIEWER_CHANNEL is not configured)
    const reviewers = await getReviewers(app.client);

    // Acknowledge Step 1 and immediately push Step 2 modal
    const step2Meta: Step2Metadata = { channelId, type, priority };

    await ack({
      response_action: "update",
      view: buildStep2Modal(step2Meta, reviewers) as any,
    });
  });
}

// ─── Step 2 Handler ──────────────────────────────────────────────────────────

function registerStep2Handler(app: App): void {
  app.view("ecr_task_modal", async ({ ack, body, view }) => {
    const vals = view.state.values;

    // Parse metadata from Step 1
    let meta: Step2Metadata;
    try {
      meta = JSON.parse(view.private_metadata || "{}") as Step2Metadata;
    } catch {
      log.error("Failed to parse Step 2 private_metadata");
      await ack();
      return;
    }

    const { channelId, type, priority } = meta;

    // Extract common fields
    const title = vals.title_block?.task_title?.value || "";
    const branchNameRaw = vals.branch_block?.branch_name?.value || undefined;

    // Reviewer extraction: multi_users_select returns selected_users,
    // multi_static_select returns selected_options — handle both.
    const reviewerField = vals.reviewer_block?.mr_reviewers as any;
    const reviewerSlackIds: string[] =
      reviewerField?.selected_users ??
      (reviewerField?.selected_options?.map((opt: { value: string }) => opt.value) ?? []);

    // Validate branch name if provided
    if (branchNameRaw) {
      const branchError = validateBranchName(branchNameRaw);
      if (branchError) {
        await ack({
          response_action: "errors",
          errors: { branch_block: branchError },
        });
        return;
      }
    }

    // Build the raw input based on type
    const rawInput: Record<string, unknown> = {
      type,
      title,
      priority,
      branchName: branchNameRaw || undefined,
      reviewerSlackIds: reviewerSlackIds.length > 0 ? reviewerSlackIds : undefined,
    };

    switch (type) {
      case "bugfix":
        rawInput.problemDescription = vals.problem_block?.problem_description?.value || "";
        rawInput.proposedSolution = vals.solution_block?.proposed_solution?.value || "";
        // Compose a description for pipeline consumption
        rawInput.description =
          `Problem: ${rawInput.problemDescription}\n\nProposed Solution: ${rawInput.proposedSolution}`;
        break;

      case "feature": {
        rawInput.featureDescription = vals.feature_desc_block?.feature_description?.value || "";
        const needsEndpoints = vals.needs_endpoints_block?.needs_endpoints?.selected_option?.value === "yes";
        rawInput.needsNewEndpoints = needsEndpoints;

        if (needsEndpoints) {
          const numStr = vals.num_endpoints_block?.num_endpoints?.value;
          const exposeOnForeshore = vals.foreshore_expose_block?.foreshore_expose?.selected_option?.value === "yes";
          const foreshoreParamsStr = vals.foreshore_params_block?.foreshore_params?.value || "";
          const foreshoreQueryStr = vals.foreshore_query_block?.foreshore_query_params?.value || "";

          rawInput.endpointDetails = {
            numberOfEndpoints: numStr ? parseInt(numStr, 10) || 1 : undefined,
            gatewayHeaderName: vals.gateway_header_block?.gateway_header?.value || undefined,
            controllerHeaderName: vals.controller_header_block?.controller_header?.value || undefined,
            exposeOnForeshore,
            foreshoreUrl: vals.foreshore_url_block?.foreshore_url?.value || undefined,
            foreshoreParams: foreshoreParamsStr
              ? foreshoreParamsStr.split(",").map((s: string) => s.trim()).filter(Boolean)
              : undefined,
            foreshoreQueryParams: foreshoreQueryStr
              ? foreshoreQueryStr.split(",").map((s: string) => s.trim()).filter(Boolean)
              : undefined,
          };
        }

        // Compose description
        let desc = `Feature: ${rawInput.featureDescription}`;
        if (needsEndpoints && rawInput.endpointDetails) {
          const ep = rawInput.endpointDetails as Record<string, unknown>;
          desc += `\n\nEndpoint Details:`;
          if (ep.numberOfEndpoints) desc += `\n- Number of endpoints: ${ep.numberOfEndpoints}`;
          if (ep.gatewayHeaderName) desc += `\n- Gateway header: ${ep.gatewayHeaderName}`;
          if (ep.controllerHeaderName) desc += `\n- Controller header: ${ep.controllerHeaderName}`;
          if (ep.exposeOnForeshore) {
            desc += `\n- Expose on Foreshore: Yes`;
            if (ep.foreshoreUrl) desc += `\n- Foreshore URL: ${ep.foreshoreUrl}`;
            if (ep.foreshoreParams) desc += `\n- Foreshore params: ${(ep.foreshoreParams as string[]).join(", ")}`;
            if (ep.foreshoreQueryParams) desc += `\n- Foreshore query params: ${(ep.foreshoreQueryParams as string[]).join(", ")}`;
          }
        }
        rawInput.description = desc;
        break;
      }

      case "refactor":
        rawInput.refactorDescription = vals.refactor_desc_block?.refactor_description?.value || "";
        rawInput.description = `Refactor: ${rawInput.refactorDescription}`;
        break;

      case "documentation":
        rawInput.documentationDescription = vals.docs_desc_block?.documentation_description?.value || "";
        rawInput.description = `Documentation: ${rawInput.documentationDescription}`;
        break;
    }

    // Validate with Zod
    const validated = TaskRequestSchema.safeParse(rawInput);
    if (!validated.success) {
      const errors: Record<string, string> = {};
      for (const issue of validated.error.issues) {
        const field = issue.path[0] as string;
        // Map field names to block IDs for Slack error display
        const blockMap: Record<string, string> = {
          title: "title_block",
          problemDescription: "problem_block",
          proposedSolution: "solution_block",
          featureDescription: "feature_desc_block",
          refactorDescription: "refactor_desc_block",
          documentationDescription: "docs_desc_block",
          branchName: "branch_block",
        };
        const blockId = blockMap[field];
        if (blockId) {
          errors[blockId] = issue.message;
        }
      }

      log.warn("Modal validation failed", { errors });
      if (Object.keys(errors).length > 0) {
        await ack({
          response_action: "errors",
          errors,
        });
        return;
      }
    }

    // Acknowledge the modal immediately
    await ack();

    const requesterId = body.user.id;
    const data = validated.success ? validated.data : (rawInput as any);
    const typeLabel = getTypeLabel(type);
    const isAdmin = requesterId === CONFIG.adminUserId;

    // Auto-generate branch name if not provided
    const branchName = data.branchName || generateBranchName(type, title);

    log.info("Modal submitted", {
      requesterId,
      isAdmin: isAdmin ? "yes" : "no",
      type: typeLabel,
      title,
      priority,
      branchName,
      reviewerSlackIds: data.reviewerSlackIds ?? [],
      sourceChannel: channelId,
    });

    // Build the description summary for Slack messages
    const descriptionSummary = buildDescriptionSummary(type, data);

    // ────────────────────────────────────────────────────────────────────────
    // ADMIN SUBMITTED: Skip approval, start pipeline immediately in admin DM
    // ────────────────────────────────────────────────────────────────────────
    if (isAdmin) {
      log.info("Admin submitted request -- skipping approval gate", { title });

      let adminDmChannelId: string;
      try {
        const dmResult = await app.client.conversations.open({
          users: CONFIG.adminUserId,
        });
        if (!dmResult.channel?.id) {
          throw new Error("conversations.open returned no channel ID");
        }
        adminDmChannelId = dmResult.channel.id;
      } catch (err) {
        log.error("Failed to open admin self-DM", { error: String(err) });
        return;
      }

      let threadTs: string;
      try {
        const msg = await app.client.chat.postMessage({
          channel: adminDmChannelId,
          text: `${typeLabel} request: *"${title}"*`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `${typeLabel} Request (Auto-approved)`,
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: [
                  `*Title:* ${title}`,
                  `*Priority:* ${priority}`,
                  `*Branch:* \`${branchName}\``,
                  `*Submitted by:* <@${requesterId}> (admin)`,
                  ...(data.reviewerSlackIds?.length
                    ? [`*MR Reviewers:* ${data.reviewerSlackIds.map((id: string) => `<@${id}>`).join(", ")}`]
                    : []),
                  descriptionSummary,
                ].join("\n"),
              },
            },
            { type: "divider" },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:fast_forward: *Auto-approved* -- starting pipeline immediately.`,
              },
            },
          ],
        });

        if (!msg.ts) {
          log.error("Failed to get ts from admin DM message");
          return;
        }
        threadTs = msg.ts;
      } catch (err) {
        log.error("Failed to post to admin DM", { error: String(err) });
        return;
      }

      log.info("Starting pipeline (admin auto-approved)", { title, threadTs });
      startPipeline(app, {
        ...data,
        type,
        title,
        priority,
        description: data.description || descriptionSummary,
        branchName,
        reviewerSlackIds: data.reviewerSlackIds,
        userId: CONFIG.adminUserId,
        channelId: adminDmChannelId,
        threadTs,
      }).catch((err) => {
        log.error("startPipeline threw unexpectedly (admin path)", { error: String(err) });
      });

      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // NON-ADMIN SUBMITTED: Send to admin for approval
    // ────────────────────────────────────────────────────────────────────────
    log.info("Non-admin request -- routing to admin for approval", { requesterId, title });

    // Send ephemeral ack to the requester
    try {
      await app.client.chat.postEphemeral({
        channel: channelId,
        user: requesterId,
        text:
          `:white_check_mark: Your ${typeLabel.toLowerCase()} request *"${title}"* has been submitted! ` +
          `You'll be notified in a DM when it's processed.`,
      });
    } catch (err) {
      log.error("Failed to send ephemeral ack", { error: String(err) });
    }

    // Open a DM with the admin
    let adminDmChannelId: string;
    try {
      const dmResult = await app.client.conversations.open({
        users: CONFIG.adminUserId,
      });
      if (!dmResult.channel?.id) {
        throw new Error("conversations.open returned no channel ID");
      }
      adminDmChannelId = dmResult.channel.id;
    } catch (err) {
      log.error("Failed to open DM with admin", { error: String(err) });
      try {
        await app.client.chat.postEphemeral({
          channel: channelId,
          user: requesterId,
          text: `Failed to route your request to the admin. Please try again or contact them directly.`,
        });
      } catch { /* give up */ }
      return;
    }

    // Post request details + approve/reject to admin DM
    try {
      const msg = await app.client.chat.postMessage({
        channel: adminDmChannelId,
        text: `New ${typeLabel} request from <@${requesterId}>`,
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: `New ${typeLabel} Request`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: [
                `*Title:* ${title}`,
                `*Priority:* ${priority}`,
                `*Branch:* \`${branchName}\``,
                `*Requested by:* <@${requesterId}>`,
                `*Source channel:* <#${channelId}>`,
                ...(data.reviewerSlackIds?.length
                  ? [`*MR Reviewers:* ${data.reviewerSlackIds.map((id: string) => `<@${id}>`).join(", ")}`]
                  : []),
                descriptionSummary,
              ].join("\n"),
            },
          },
          { type: "divider" },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Approve & Start Pipeline" },
                style: "primary",
                action_id: "approve_request",
                value: JSON.stringify({
                  ...data,
                  type,
                  title,
                  priority,
                  description: data.description || descriptionSummary,
                  branchName,
                  reviewerSlackIds: data.reviewerSlackIds,
                  requesterId,
                  adminDmChannelId,
                }),
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Reject" },
                style: "danger",
                action_id: "reject_request",
                value: JSON.stringify({
                  requesterId,
                  title,
                }),
              },
            ],
          },
        ],
      });

      if (!msg.ts) {
        log.error("Failed to get ts from admin DM message");
      } else {
        log.info("Request posted to admin DM for approval", { messageTs: msg.ts });
      }
    } catch (err) {
      log.error("Failed to post to admin DM", { error: String(err) });
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a human-readable description summary for Slack display.
 */
function buildDescriptionSummary(type: TaskType, data: Record<string, unknown>): string {
  const parts: string[] = [];

  switch (type) {
    case "bugfix":
      if (data.problemDescription) {
        parts.push(`\n*Problem:*\n${data.problemDescription}`);
      }
      if (data.proposedSolution) {
        parts.push(`\n*Proposed Solution:*\n${data.proposedSolution}`);
      }
      break;

    case "feature":
      if (data.featureDescription) {
        parts.push(`\n*Feature Description:*\n${data.featureDescription}`);
      }
      if (data.needsNewEndpoints) {
        parts.push(`\n*Needs New Endpoints:* Yes`);
        const ep = data.endpointDetails as Record<string, unknown> | undefined;
        if (ep) {
          if (ep.numberOfEndpoints) parts.push(`  - Count: ${ep.numberOfEndpoints}`);
          if (ep.gatewayHeaderName) parts.push(`  - Gateway header: ${ep.gatewayHeaderName}`);
          if (ep.controllerHeaderName) parts.push(`  - Controller header: ${ep.controllerHeaderName}`);
          if (ep.exposeOnForeshore) {
            parts.push(`  - Foreshore: Yes`);
            if (ep.foreshoreUrl) parts.push(`  - URL: ${ep.foreshoreUrl}`);
            if (ep.foreshoreParams) parts.push(`  - Params: ${(ep.foreshoreParams as string[]).join(", ")}`);
            if (ep.foreshoreQueryParams) parts.push(`  - Query params: ${(ep.foreshoreQueryParams as string[]).join(", ")}`);
          }
        }
      }
      break;

    case "refactor":
      if (data.refactorDescription) {
        parts.push(`\n*What to Refactor:*\n${data.refactorDescription}`);
      }
      break;

    case "documentation":
      if (data.documentationDescription) {
        parts.push(`\n*What to Document:*\n${data.documentationDescription}`);
      }
      break;
  }

  return parts.join("\n");
}

/**
 * Register the approve/reject request handlers for the admin DM buttons.
 */
export function registerRequestApproval(app: App): void {
  const approvalLog = createLogger("RequestApproval");

  // ── Approve Request ──
  app.action("approve_request", async ({ ack, body }) => {
    await ack();

    const action = (body as any).actions?.[0];
    if (!action?.value) return;

    let data: Record<string, any>;
    try {
      data = JSON.parse(action.value);
    } catch {
      approvalLog.error("Failed to parse action value");
      return;
    }

    approvalLog.info("Request approved by admin", { title: data.title, requesterId: data.requesterId });

    const channelId = (body as any).channel?.id || data.adminDmChannelId;
    const messageTs = (body as any).message?.ts;

    if (!channelId || !messageTs) {
      approvalLog.error("Missing channel or message ts");
      return;
    }

    // Post approval confirmation in the admin DM thread
    try {
      await app.client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: `:thumbsup: Request approved. Starting pipeline for *"${data.title}"*...`,
      });
    } catch (err) {
      approvalLog.error("Failed to post approval message", { error: String(err) });
    }

    // Start the pipeline in the admin's DM thread
    startPipeline(app, {
      type: data.type,
      title: data.title,
      description: data.description,
      priority: data.priority,
      branchName: data.branchName,
      reviewerSlackIds: data.reviewerSlackIds,
      userId: CONFIG.adminUserId,
      channelId,
      threadTs: messageTs,
      requesterId: data.requesterId,
      // Pass through all type-specific fields
      problemDescription: data.problemDescription,
      proposedSolution: data.proposedSolution,
      featureDescription: data.featureDescription,
      needsNewEndpoints: data.needsNewEndpoints,
      endpointDetails: data.endpointDetails,
      refactorDescription: data.refactorDescription,
      documentationDescription: data.documentationDescription,
    }).catch((err) => {
      approvalLog.error("startPipeline threw unexpectedly", { error: String(err) });
    });
  });

  // ── Reject Request ──
  app.action("reject_request", async ({ ack, body }) => {
    await ack();

    const action = (body as any).actions?.[0];
    if (!action?.value) return;

    let data: { requesterId: string; title: string };
    try {
      data = JSON.parse(action.value);
    } catch {
      return;
    }

    approvalLog.info("Request rejected by admin", { title: data.title, requesterId: data.requesterId });

    const channelId = (body as any).channel?.id;
    const messageTs = (body as any).message?.ts;

    if (channelId && messageTs) {
      try {
        await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: messageTs,
          text: `:no_entry_sign: Request *"${data.title}"* rejected.`,
        });
      } catch (err) {
        approvalLog.error("Failed to post rejection", { error: String(err) });
      }
    }

    // Notify the requester via DM
    try {
      const requesterDm = await app.client.conversations.open({
        users: data.requesterId,
      });
      if (requesterDm.channel?.id) {
        await app.client.chat.postMessage({
          channel: requesterDm.channel.id,
          text:
            `:no_entry_sign: Your request *"${data.title}"* was not approved. ` +
            `Please reach out to the admin for details.`,
        });
      }
    } catch (err) {
      approvalLog.error("Failed to notify requester of rejection", { error: String(err) });
    }
  });
}
