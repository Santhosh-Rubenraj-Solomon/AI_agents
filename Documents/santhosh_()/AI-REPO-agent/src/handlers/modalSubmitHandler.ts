/**
 * handlers/modalSubmitHandler.ts — Two-step modal form submission.
 *
 * Step 1 (ecr_type_select): Reads type + priority, opens Step 2 modal.
 * Step 2 (ecr_task_modal): Validates full input with Zod, then routes:
 *   - Admin submitter: skip approval, start pipeline immediately.
 *   - Non-admin submitter: store the validated request in SQLite and send
 *     the admin a DM with approve/reject buttons that carry only its ID.
 *
 * Invalid input never starts a pipeline: every Zod issue is mapped to a
 * modal block (falling back to the title block) and shown inline.
 * Only the admin may act on approve_request / reject_request buttons.
 */

import type { App } from "@slack/bolt";
import { v4 as uuidv4 } from "uuid";
import type { ZodIssue } from "zod";
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
import {
  createPendingRequest,
  getPendingRequest,
  resolvePendingRequest,
} from "../state/store.js";

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

// ─── Validation helpers ──────────────────────────────────────────────────────

/** Top-level TaskRequest fields -> Step 2 modal block IDs. */
const FIELD_BLOCK_MAP: Record<string, string> = {
  title: "title_block",
  problemDescription: "problem_block",
  proposedSolution: "solution_block",
  featureDescription: "feature_desc_block",
  needsNewEndpoints: "needs_endpoints_block",
  refactorDescription: "refactor_desc_block",
  documentationDescription: "docs_desc_block",
  branchName: "branch_block",
  reviewerSlackIds: "reviewer_block",
};

/** endpointDetails.* fields -> Step 2 modal block IDs. */
const ENDPOINT_BLOCK_MAP: Record<string, string> = {
  numberOfEndpoints: "num_endpoints_block",
  gatewayHeaderName: "gateway_header_block",
  controllerHeaderName: "controller_header_block",
  exposeOnForeshore: "foreshore_expose_block",
  foreshoreUrl: "foreshore_url_block",
  foreshoreParams: "foreshore_params_block",
  foreshoreQueryParams: "foreshore_query_block",
};

/** Block that shows errors for fields that have no block of their own. */
const FALLBACK_ERROR_BLOCK = "title_block";

/**
 * Map Zod issues to Slack `response_action: "errors"` entries.
 *
 * Every issue produces an error somewhere: fields without a dedicated
 * block (e.g. type/priority from private_metadata) are reported on the
 * title block, so validation failures can never be silently dropped.
 */
export function mapIssuesToBlockErrors(issues: ZodIssue[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const [field, sub] = issue.path;
    let blockId: string | undefined =
      field === "endpointDetails" && typeof sub === "string"
        ? ENDPOINT_BLOCK_MAP[sub]
        : FIELD_BLOCK_MAP[String(field)];
    let message = issue.message;
    if (!blockId) {
      blockId = FALLBACK_ERROR_BLOCK;
      message = `Invalid ${issue.path.join(".") || "request"}: ${issue.message}`;
    }
    // Keep the first error per block (Slack shows one message per block).
    if (!errors[blockId]) errors[blockId] = message;
  }
  return errors;
}

/** Slack caps a section block's mrkdwn text at 3000 characters. */
const SECTION_TEXT_MAX = 2900;

function truncateForSection(text: string): string {
  return text.length > SECTION_TEXT_MAX
    ? text.slice(0, SECTION_TEXT_MAX) + "\n_...truncated (full request is stored with the task)_"
    : text;
}

/**
 * Tell a user something, ephemerally in the source channel if possible,
 * otherwise by DM (postEphemeral fails when the bot is not in the channel).
 */
async function notifyUser(
  app: App,
  channelId: string | undefined,
  userId: string,
  text: string,
): Promise<void> {
  if (channelId) {
    try {
      await app.client.chat.postEphemeral({ channel: channelId, user: userId, text });
      return;
    } catch (err) {
      log.warn("postEphemeral failed, falling back to DM", { userId, error: String(err) });
    }
  }
  try {
    const dm = await app.client.conversations.open({ users: userId });
    if (dm.channel?.id) {
      await app.client.chat.postMessage({ channel: dm.channel.id, text });
    }
  } catch (err) {
    log.error("Could not notify user", { userId, error: String(err) });
  }
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
      await ack({
        response_action: "errors",
        errors: { [FALLBACK_ERROR_BLOCK]: "This form is corrupted. Please close it and run /ecr again." },
      });
      return;
    }

    const { channelId, type, priority } = meta;

    // Extract common fields
    const title = (vals.title_block?.task_title?.value || "").trim();
    const branchNameRaw = vals.branch_block?.branch_name?.value?.trim() || undefined;

    // Reviewer extraction: multi_users_select returns selected_users,
    // multi_static_select returns selected_options — handle both.
    const reviewerField = vals.reviewer_block?.mr_reviewers as any;
    const reviewerSlackIds: string[] =
      reviewerField?.selected_users ??
      (reviewerField?.selected_options?.map((opt: { value: string }) => opt.value) ?? []);

    // Field-level errors found before schema validation
    const preErrors: Record<string, string> = {};

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
          const numStr = vals.num_endpoints_block?.num_endpoints?.value?.trim();
          const exposeOnForeshore = vals.foreshore_expose_block?.foreshore_expose?.selected_option?.value === "yes";
          const foreshoreParamsStr = vals.foreshore_params_block?.foreshore_params?.value || "";
          const foreshoreQueryStr = vals.foreshore_query_block?.foreshore_query_params?.value || "";

          let numberOfEndpoints: number | undefined;
          if (numStr) {
            if (/^\d+$/.test(numStr)) {
              numberOfEndpoints = Number(numStr);
            } else {
              preErrors.num_endpoints_block = "Number of endpoints must be a whole number (1-20).";
            }
          }

          rawInput.endpointDetails = {
            numberOfEndpoints,
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

    // Validate with Zod — never proceed on invalid input.
    const validated = TaskRequestSchema.safeParse(rawInput);
    const errors: Record<string, string> = {
      ...(validated.success ? {} : mapIssuesToBlockErrors(validated.error.issues)),
      ...preErrors,
    };
    if (!validated.success || Object.keys(errors).length > 0) {
      log.warn("Modal validation failed", { errors });
      await ack({
        response_action: "errors",
        errors: Object.keys(errors).length > 0
          ? errors
          : { [FALLBACK_ERROR_BLOCK]: "The request is invalid. Please check the fields and try again." },
      });
      return;
    }

    // Acknowledge the modal immediately
    await ack();

    const requesterId = body.user.id;
    const data = validated.data;
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
      let threadTs: string;
      try {
        const dmResult = await app.client.conversations.open({
          users: CONFIG.adminUserId,
        });
        if (!dmResult.channel?.id) {
          throw new Error("conversations.open returned no channel ID");
        }
        adminDmChannelId = dmResult.channel.id;

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
                text: truncateForSection([
                  `*Title:* ${title}`,
                  `*Priority:* ${priority}`,
                  `*Branch:* \`${branchName}\``,
                  `*Submitted by:* <@${requesterId}> (admin)`,
                  ...(data.reviewerSlackIds?.length
                    ? [`*MR Reviewers:* ${data.reviewerSlackIds.map((id: string) => `<@${id}>`).join(", ")}`]
                    : []),
                  descriptionSummary,
                ].join("\n")),
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
          throw new Error("chat.postMessage returned no message ts");
        }
        threadTs = msg.ts;
      } catch (err) {
        log.error("Failed to start admin request in admin DM", { error: String(err) });
        await notifyUser(
          app,
          channelId,
          requesterId,
          `:x: Could not start the pipeline for *"${title}"*: ${err instanceof Error ? err.message : String(err)}. Please try again.`,
        );
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

    const routingFailed = (reason: string) =>
      notifyUser(
        app,
        channelId,
        requesterId,
        `:x: Failed to route your request *"${title}"* to the admin (${reason}). ` +
          `Please try again or contact them directly.`,
      );

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
      await routingFailed("could not open a DM with the admin");
      return;
    }

    // Store the full request server-side; the buttons carry only its ID
    // (Slack caps button values at 2000 characters).
    const requestId = uuidv4();
    try {
      createPendingRequest(requestId, requesterId, {
        ...data,
        type,
        title,
        priority,
        description: data.description || descriptionSummary,
        branchName,
        reviewerSlackIds: data.reviewerSlackIds,
        sourceChannelId: channelId,
      });
    } catch (err) {
      log.error("Failed to store pending request", { error: String(err) });
      await routingFailed("could not save the request");
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
              text: truncateForSection([
                `*Title:* ${title}`,
                `*Priority:* ${priority}`,
                `*Branch:* \`${branchName}\``,
                `*Requested by:* <@${requesterId}>`,
                `*Source channel:* <#${channelId}>`,
                ...(data.reviewerSlackIds?.length
                  ? [`*MR Reviewers:* ${data.reviewerSlackIds.map((id: string) => `<@${id}>`).join(", ")}`]
                  : []),
                descriptionSummary,
              ].join("\n")),
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
                value: requestId,
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Reject" },
                style: "danger",
                action_id: "reject_request",
                value: requestId,
              },
            ],
          },
        ],
      });

      log.info("Request posted to admin DM for approval", { requestId, messageTs: msg.ts });
    } catch (err) {
      log.error("Failed to post to admin DM", { requestId, error: String(err) });
      resolvePendingRequest(requestId, "failed");
      await routingFailed(`Slack error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Only confirm once the admin actually has the request.
    await notifyUser(
      app,
      channelId,
      requesterId,
      `:white_check_mark: Your ${typeLabel.toLowerCase()} request *"${title}"* has been submitted! ` +
        `You'll be notified in a DM when it's processed.`,
    );
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
 *
 * Button values carry only a request ID; the request itself is loaded from
 * SQLite, re-validated, and atomically moved out of "pending" so a double
 * click cannot start two pipelines. Only the admin may click.
 */
export function registerRequestApproval(app: App): void {
  const approvalLog = createLogger("RequestApproval");

  /** Post a short note in the admin's request thread (best effort). */
  async function replyInThread(body: any, text: string): Promise<void> {
    const channelId = body?.channel?.id;
    const messageTs = body?.message?.ts;
    if (!channelId || !messageTs) return;
    try {
      await app.client.chat.postMessage({ channel: channelId, thread_ts: messageTs, text });
    } catch (err) {
      approvalLog.error("Failed to post in request thread", { error: String(err) });
    }
  }

  /** Common checks for both buttons. Returns the pending request or null. */
  async function loadForAdmin(body: any, verb: string) {
    const userId = body?.user?.id;
    if (userId !== CONFIG.adminUserId) {
      approvalLog.warn(`Non-admin attempted to ${verb} a request`, { userId });
      if (userId) {
        await notifyUser(app, body?.channel?.id, userId, `:lock: Only the admin can ${verb} requests.`);
      }
      return null;
    }

    const requestId = body?.actions?.[0]?.value;
    if (!requestId || typeof requestId !== "string") return null;

    let pending;
    try {
      pending = getPendingRequest(requestId);
    } catch (err) {
      approvalLog.error("Failed to load pending request", { requestId, error: String(err) });
      await replyInThread(body, `:x: Could not load this request: ${String(err)}`);
      return null;
    }
    if (!pending) {
      approvalLog.warn("Unknown or expired request", { requestId });
      await replyInThread(
        body,
        `:warning: This request is no longer available (expired or created by an older version). ` +
          `Ask the requester to submit it again with /ecr.`,
      );
      return null;
    }
    if (pending.status !== "pending") {
      approvalLog.info("Request already handled", { requestId, status: pending.status });
      await replyInThread(body, `:information_source: This request was already ${pending.status}.`);
      return null;
    }
    return pending;
  }

  // ── Approve Request ──
  app.action("approve_request", async ({ ack, body }) => {
    await ack();

    const pending = await loadForAdmin(body, "approve");
    if (!pending) return;

    const channelId = (body as any).channel?.id;
    const messageTs = (body as any).message?.ts;
    if (!channelId || !messageTs) {
      approvalLog.error("Missing channel or message ts", { requestId: pending.requestId });
      return;
    }

    // Re-validate what we stored — never start a pipeline on invalid input.
    const validated = TaskRequestSchema.safeParse(pending.payload);
    if (!validated.success) {
      approvalLog.error("Stored request failed validation", { requestId: pending.requestId });
      resolvePendingRequest(pending.requestId, "failed");
      await replyInThread(body, `:x: This request is invalid and cannot be started. Ask the requester to resubmit.`);
      return;
    }
    const data = validated.data;

    // Claim the request before any further await (double-click guard).
    if (!resolvePendingRequest(pending.requestId, "approved")) {
      approvalLog.info("Request approval already handled", { requestId: pending.requestId });
      return;
    }

    approvalLog.info("Request approved by admin", { title: data.title, requesterId: pending.requesterId });

    // Post approval confirmation in the admin DM thread
    await replyInThread(body, `:thumbsup: Request approved. Starting pipeline for *"${data.title}"*...`);

    // Start the pipeline in the admin's DM thread
    startPipeline(app, {
      type: data.type,
      title: data.title,
      description: data.description || data.title,
      priority: data.priority,
      branchName: data.branchName,
      reviewerSlackIds: data.reviewerSlackIds,
      userId: CONFIG.adminUserId,
      channelId,
      threadTs: messageTs,
      requesterId: pending.requesterId,
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

    const pending = await loadForAdmin(body, "reject");
    if (!pending) return;

    if (!resolvePendingRequest(pending.requestId, "rejected")) return;

    const title = String(pending.payload.title ?? "request");
    approvalLog.info("Request rejected by admin", { title, requesterId: pending.requesterId });

    await replyInThread(body, `:no_entry_sign: Request *"${title}"* rejected.`);

    // Notify the requester via DM
    try {
      const requesterDm = await app.client.conversations.open({
        users: pending.requesterId,
      });
      if (requesterDm.channel?.id) {
        await app.client.chat.postMessage({
          channel: requesterDm.channel.id,
          text:
            `:no_entry_sign: Your request *"${title}"* was not approved. ` +
            `Please reach out to the admin for details.`,
        });
      }
    } catch (err) {
      approvalLog.error("Failed to notify requester of rejection", { error: String(err) });
    }
  });
}
