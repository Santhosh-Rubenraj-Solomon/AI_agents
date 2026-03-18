/**
 * agents/types.ts — Shared agent interface and I/O schemas.
 *
 * Every agent implements the same AgentInterface: a single `run()` method
 * that takes typed input, reads/writes state through the store, and returns
 * typed output. Agents never talk to Slack directly — that is the
 * Coordinator's job.
 *
 * Input/output contracts are Zod-validated so agents can be tested in
 * isolation without Slack, without the Coordinator, and without each other.
 */

import { z } from "zod";
import {
  TaskRequestSchema,
  TaskAnalysisSchema,
  ReviewResultSchema,
  PipelineStateSchema,
} from "../schemas.js";

// ─── Agent result envelope ───────────────────────────────────────────────────

/**
 * Every agent returns a uniform result envelope.
 * The Coordinator inspects `success` to decide the next step.
 */
export const AgentResultSchema = z.object({
  /** Whether the agent completed its work without fatal errors. */
  success: z.boolean(),
  /** Human-readable message for Slack thread (Coordinator posts it). */
  message: z.string(),
  /** Optional structured error for logging / dashboards. */
  error: z.string().optional(),
});

export type AgentResult = z.infer<typeof AgentResultSchema>;

// ─── Analyzer Agent ──────────────────────────────────────────────────────────

export const AnalyzerInputSchema = z.object({
  taskId: z.string(),
});

export const AnalyzerOutputSchema = AgentResultSchema.extend({
  analysis: TaskAnalysisSchema.nullable(),
});

export type AnalyzerInput = z.infer<typeof AnalyzerInputSchema>;
export type AnalyzerOutput = z.infer<typeof AnalyzerOutputSchema>;

// ─── Coder Agent ─────────────────────────────────────────────────────────────

export const CoderInputSchema = z.object({
  taskId: z.string(),
});

export const CoderOutputSchema = AgentResultSchema.extend({
  /** Whether nx checks passed (after optional auto-fix). */
  nxPassed: z.boolean().optional(),
});

export type CoderInput = z.infer<typeof CoderInputSchema>;
export type CoderOutput = z.infer<typeof CoderOutputSchema>;

// ─── Reviewer Agent ──────────────────────────────────────────────────────────

export const ReviewerInputSchema = z.object({
  taskId: z.string(),
});

export const ReviewerOutputSchema = AgentResultSchema.extend({
  review: ReviewResultSchema.extend({ iteration: z.number() }).nullable(),
});

/** Convenience type for a single review iteration result. */
export type ReviewIterationResult = z.infer<typeof ReviewerOutputSchema>["review"];

export type ReviewerInput = z.infer<typeof ReviewerInputSchema>;
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

// ─── Fixer Agent ─────────────────────────────────────────────────────────────

export const FixerInputSchema = z.object({
  taskId: z.string(),
});

export const FixerOutputSchema = AgentResultSchema.extend({
  nxPassed: z.boolean().optional(),
});

export type FixerInput = z.infer<typeof FixerInputSchema>;
export type FixerOutput = z.infer<typeof FixerOutputSchema>;

// ─── Finalizer Agent ─────────────────────────────────────────────────────────

export const FinalizerInputSchema = z.object({
  taskId: z.string(),
});

export const FinalizerOutputSchema = AgentResultSchema.extend({
  commitHash: z.string().nullable().optional(),
  mrUrl: z.string().nullable().optional(),
});

export type FinalizerInput = z.infer<typeof FinalizerInputSchema>;
export type FinalizerOutput = z.infer<typeof FinalizerOutputSchema>;

// ─── Summary Writer Agent ────────────────────────────────────────────────────

export const SummaryWriterInputSchema = z.object({
  taskId: z.string(),
});

export const SummaryWriterOutputSchema = AgentResultSchema.extend({
  /** Path to the saved .md file in the worktree (null if worktree unavailable). */
  mdPath: z.string().nullable(),
  /** The full markdown content of the summary (null on failure). */
  content: z.string().nullable(),
});

export type SummaryWriterInput = z.infer<typeof SummaryWriterInputSchema>;
export type SummaryWriterOutput = z.infer<typeof SummaryWriterOutputSchema>;

// ─── Generic agent interface ─────────────────────────────────────────────────

/**
 * All agents implement this interface. The generic parameters allow each
 * agent to declare its own input/output shape while keeping the Coordinator
 * generic over agents.
 *
 * Agents:
 *  - Read pipeline state from SQLite via `getTask()`
 *  - Call existing services (claudeAgent, gitService, nxService, etc.)
 *  - Write updated state back via `updateTask()`
 *  - Return a typed result to the Coordinator
 *  - NEVER import Slack types or post messages directly
 */
export interface AgentInterface<TInput, TOutput extends AgentResult> {
  /** Human-readable name, used in logs and Slack status messages. */
  readonly name: string;

  /** The pipeline phase this agent sets when it starts running. */
  readonly activePhase: string;

  /**
   * Execute the agent's work.
   *
   * @param input - Zod-validated input specific to this agent
   * @returns Typed output with success/failure and agent-specific data
   */
  run(input: TInput): Promise<TOutput>;
}
