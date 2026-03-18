/**
 * types.ts — Core type definitions for the AI agent.
 */

import { z } from "zod";
import {
  AnalysisResultSchema,
  BreakingChangeResultSchema,
  SessionStateSchema,
  TechProfileSchema,
} from "./schemas.js";

// ─── Inferred types ───────────────────────────────────────────────────────────

export type TechProfile = z.infer<typeof TechProfileSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
export type BreakingChangeResult = z.infer<typeof BreakingChangeResultSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;

// ─── Session phases ───────────────────────────────────────────────────────────

export type SessionPhase =
  | "idle"
  | "cloning"
  | "profiling"
  | "analyzing"
  | "awaiting_input"
  | "detecting_breaking_changes"
  | "advising_bugfix"
  | "advising_feature"
  | "complete"
  | "failed";

// ─── Agent interfaces ─────────────────────────────────────────────────────────

export interface AgentResult<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  error?: string;
}

// ─── GitHub repo info ─────────────────────────────────────────────────────────

export interface RepoInfo {
  owner: string;
  name: string;
  url: string;
  localPath: string;
  defaultBranch: string;
}

// ─── File analysis entry ──────────────────────────────────────────────────────

export interface FileEntry {
  path: string;
  extension: string;
  sizeBytes: number;
  language: string;
}

// ─── Question flow ────────────────────────────────────────────────────────────

export type TaskType = "bugfix" | "feature" | "breaking_changes" | "architecture" | "general";

export interface ConversationContext {
  sessionId: string;
  repoUrl: string;
  taskType: TaskType;
  profile?: TechProfile;
  questions: Array<{ role: "user" | "assistant"; content: string }>;
  currentStep: number;
  totalSteps: number;
}
