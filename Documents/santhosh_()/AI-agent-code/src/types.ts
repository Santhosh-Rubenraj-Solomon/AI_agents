/**
 * types.ts — All types have been consolidated into schemas.ts.
 *
 * This file is kept for backward compatibility but all types
 * should be imported from "./schemas.js" instead.
 */
export type {
  TechProfile,
  AnalysisResult,
  BreakingChangeResult,
  SessionState,
  SessionPhase,
  AgentResult,
  RepoInfo,
  FileEntry,
  TaskType,
  ConversationContext
} from "./schemas.js";
