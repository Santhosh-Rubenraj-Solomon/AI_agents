/**
 * agents/analyzer.ts — Phase 1: Analyze the task and produce an execution plan.
 *
 * Read-only agent. Reads the monorepo codebase, understands the task,
 * and produces a structured TaskAnalysis with file lists, approach,
 * risks, and a branch name.
 *
 * Uses: claudeAgent.analyzeTask (service layer)
 * Writes: state.analysis, state.branchName, state.currentPhase
 * Slack: none (Coordinator handles all messaging)
 */

import { CONFIG, assertPathsInScope } from "../config.js";
import { analyzeTask } from "../services/claudeAgent.js";
import { getTask, updateTask } from "../state/store.js";
import { createLogger } from "../utils/logger.js";
import type { AgentInterface, AnalyzerInput, AnalyzerOutput } from "./types.js";

const log = createLogger("Analyzer");

// ─── Analyzer Agent ──────────────────────────────────────────────────────────

export const analyzerAgent: AgentInterface<AnalyzerInput, AnalyzerOutput> = {
  name: "Analyzer",
  activePhase: "analyzing",

  async run(input: AnalyzerInput): Promise<AnalyzerOutput> {
    const state = getTask(input.taskId);
    if (!state) {
      return {
        success: false,
        message: `Task ${input.taskId} not found.`,
        error: "TASK_NOT_FOUND",
        analysis: null,
      };
    }

    // Mark phase
    state.currentPhase = "analyzing";
    updateTask(state);

    log.info("Starting analysis", { taskId: input.taskId, title: state.request.title });

    try {
      const analysis = await analyzeTask(state.request);

      log.info("Analysis returned", {
        taskId: input.taskId,
        branchName: analysis.branchName,
        filesToChange: analysis.filesToChange.length,
        filesToCreate: analysis.filesToCreate.length,
        complexity: analysis.estimatedComplexity,
      });

      // Validate all paths are within service scope
      assertPathsInScope([...analysis.filesToChange, ...analysis.filesToCreate]);

      // Persist analysis results
      state.analysis = analysis;
      state.branchName = analysis.branchName;
      state.currentPhase = "awaiting_plan_approval";
      updateTask(state);

      return {
        success: true,
        message:
          `Analysis complete. Branch: \`${analysis.branchName}\`. ` +
          `${analysis.filesToChange.length} file(s) to modify, ` +
          `${analysis.filesToCreate.length} to create. ` +
          `Complexity: ${analysis.estimatedComplexity}.`,
        analysis,
      };
    } catch (err: unknown) {
      const error = err as Error;
      log.error("Analysis threw an exception", { taskId: input.taskId, error: error.message });
      state.currentPhase = "failed";
      updateTask(state);

      return {
        success: false,
        message: `Analysis failed: ${error.message}`,
        error: error.message,
        analysis: null,
      };
    }
  },
};
