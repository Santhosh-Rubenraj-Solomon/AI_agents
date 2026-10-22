/**
 * types.ts — Re-exports inferred types from Zod schemas.
 *
 * Import types from here, schemas from schemas.ts.
 * This keeps validation logic and type usage cleanly separated.
 */

import { z } from "zod";
import type { App } from "@slack/bolt";
import {
  TaskRequestSchema,
  TaskAnalysisSchema,
  ReviewIssueSchema,
  ReviewResultSchema,
  PipelinePhaseSchema,
  PipelineStateSchema,
  EndpointDetailsSchema,
} from "./schemas.js";
import { redactDeep } from "./utils/redact.js";

// ─── Inferred types ───────────────────────────────────────────────────────────

export type TaskRequest = z.infer<typeof TaskRequestSchema>;

export type TaskAnalysis = z.infer<typeof TaskAnalysisSchema>;

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export type PipelinePhase = z.infer<typeof PipelinePhaseSchema>;

export type PipelineState = z.infer<typeof PipelineStateSchema>;

export type EndpointDetails = z.infer<typeof EndpointDetailsSchema>;

/** The full request as persisted — includes Slack context. */
export type FullTaskRequest = PipelineState["request"];

/** Review result with iteration number attached. */
export type ReviewIterationResult = PipelineState["reviewIterations"][number];

// ─── Service interfaces ───────────────────────────────────────────────────────

/**
 * Swappable Claude agent interface.
 * Concrete implementation uses Claude CLI via async execFile.
 * Can be swapped to Agent SDK later.
 */
export interface ClaudeAgentInterface {
  /** Read-only analysis. Returns raw string output. */
  analyze(prompt: string, cwd: string): Promise<string>;

  /** Write-mode execution. Returns raw string output. */
  execute(prompt: string, cwd: string, allowedPaths: string[]): Promise<string>;
}

/**
 * Function to post messages into a Slack thread.
 * Reconstructed from stored channel_id + thread_ts on demand.
 */
export type SayFn = (
  args: string | { text: string; blocks?: unknown[]; [key: string]: unknown }
) => Promise<void>;

/**
 * Constructs a say function from app client + stored coordinates.
 * Message text and blocks are passed through redactDeep() so error
 * messages that echo credentials are never posted to Slack.
 */
export function createSayFn(
  app: App,
  channelId: string,
  threadTs: string
): SayFn {
  return async (args) => {
    const payload = redactDeep(
      typeof args === "string" ? { text: args } : args
    );
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      ...payload,
    });
  };
}

/**
 * Constructs a say function that posts to BOTH the admin thread AND
 * the requester's DM thread. If requester coordinates are null (admin
 * submitted the request), it behaves like a normal say function.
 */
export function createBroadcastSayFn(
  app: App,
  adminChannelId: string,
  adminThreadTs: string,
  requesterChannelId: string | null,
  requesterThreadTs: string | null,
): SayFn {
  return async (args) => {
    const payload = redactDeep(
      typeof args === "string" ? { text: args } : args
    );

    // Always post to admin thread
    await app.client.chat.postMessage({
      channel: adminChannelId,
      thread_ts: adminThreadTs,
      ...payload,
    });

    // Mirror to requester's DM thread if they are a different person
    if (requesterChannelId && requesterThreadTs) {
      try {
        await app.client.chat.postMessage({
          channel: requesterChannelId,
          thread_ts: requesterThreadTs,
          ...payload,
        });
      } catch {
        // Non-fatal — don't break pipeline if requester DM fails
      }
    }
  };
}

// ─── Nx check result ──────────────────────────────────────────────────────────

export interface NxCheckResult {
  passed: boolean;
  output: string;
  lintPassed: boolean;
  testPassed: boolean;
}

// ─── GitLab MR types ──────────────────────────────────────────────────────────

export interface MrInput {
  branchName: string;
  title: string;
  description: string;
  /** GitLab user IDs to assign as MR reviewers. */
  reviewerIds?: number[];
}

export interface MrResult {
  url: string;
  iid: number;
}
