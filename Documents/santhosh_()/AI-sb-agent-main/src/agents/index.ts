/**
 * agents/index.ts — Barrel export for all agents.
 *
 * Import agents from here rather than from individual files.
 * The Coordinator uses these exports to dispatch work.
 */

export { analyzerAgent } from "./analyzer.js";
export { coderAgent } from "./coder.js";
export { reviewerAgent } from "./reviewer.js";
export { fixerAgent } from "./fixer.js";
export { finalizerAgent } from "./finalizer.js";
export { summaryWriterAgent } from "./summaryWriter.js";

export type {
  AgentInterface,
  AgentResult,
  AnalyzerInput,
  AnalyzerOutput,
  CoderInput,
  CoderOutput,
  ReviewerInput,
  ReviewerOutput,
  FixerInput,
  FixerOutput,
  FinalizerInput,
  FinalizerOutput,
  SummaryWriterInput,
  SummaryWriterOutput,
} from "./types.js";
