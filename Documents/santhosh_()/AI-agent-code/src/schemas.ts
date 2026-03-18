/**
 * schemas.ts — Single source of truth for all Zod schemas.
 *
 * Every structured boundary (user input, AI output, persisted state)
 * is validated through these schemas.
 */

import { z } from "zod";

// ─── Tech Profile (auto-detected from codebase) ─────────────────────────────

export const TechProfileSchema = z.object({
  languages: z.array(z.object({
    name: z.string(),
    percentage: z.number(),
    fileCount: z.number(),
  })),
  frameworks: z.array(z.string()),
  buildTools: z.array(z.string()),
  databases: z.array(z.string()),
  architecture: z.string(),
  packageManager: z.string(),
  testFrameworks: z.array(z.string()),
  linters: z.array(z.string()),
  ciCd: z.array(z.string()),
  entryPoints: z.array(z.string()),
  totalFiles: z.number(),
  totalLinesEstimate: z.number(),
  dependencies: z.record(z.string()),
  devDependencies: z.record(z.string()),
});

// ─── Analysis Result ─────────────────────────────────────────────────────────

export const AnalysisResultSchema = z.object({
  summary: z.string(),
  architecture: z.string(),
  keyComponents: z.array(z.object({
    name: z.string(),
    path: z.string(),
    purpose: z.string(),
    type: z.enum(["controller", "service", "model", "middleware", "utility", "config", "test", "migration", "other"]),
  })),
  dataModels: z.array(z.object({
    name: z.string(),
    path: z.string(),
    fields: z.array(z.string()),
    relationships: z.array(z.string()),
  })),
  apiEndpoints: z.array(z.object({
    method: z.string(),
    path: z.string(),
    handler: z.string(),
    description: z.string(),
  })),
  concerns: z.array(z.string()),
  strengths: z.array(z.string()),
});

// ─── Breaking Change Analysis ────────────────────────────────────────────────

export const BreakingChangeResultSchema = z.object({
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "BREAKING"]),
  changeType: z.array(z.enum(["API", "Database", "Message", "Library", "Config", "None"])),
  affectedConsumers: z.array(z.string()),
  findings: z.array(z.object({
    file: z.string(),
    change: z.string(),
    breaking: z.boolean(),
    impact: z.string(),
  })),
  recommendations: z.array(z.string()),
  checklist: z.object({
    dtosChecked: z.boolean(),
    enumsChecked: z.boolean(),
    typesChecked: z.boolean(),
    defaultsChecked: z.boolean(),
    databaseChecked: z.boolean(),
    messagesChecked: z.boolean(),
    consumersChecked: z.boolean(),
    rollbackChecked: z.boolean(),
  }),
});

// ─── Session State (persisted in SQLite) ─────────────────────────────────────

export const SessionPhaseSchema = z.enum([
  "idle",
  "cloning",
  "profiling",
  "analyzing",
  "awaiting_input",
  "detecting_breaking_changes",
  "advising_bugfix",
  "advising_feature",
  "complete",
  "failed",
]);

export const SessionStateSchema = z.object({
  sessionId: z.string(),
  chatId: z.number(),
  userId: z.number(),
  repoUrl: z.string().nullable(),
  repoLocalPath: z.string().nullable(),
  currentPhase: SessionPhaseSchema,
  taskType: z.enum(["bugfix", "feature", "breaking_changes", "architecture", "general"]).nullable(),
  profileJson: z.string().nullable(),
  analysisJson: z.string().nullable(),
  conversationHistory: z.string().default("[]"),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// ─── AI output parse utilities ───────────────────────────────────────────────

export class AIParseError extends Error {
  constructor(
    message: string,
    public readonly rawOutput: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "AIParseError";
  }
}

/**
 * Parse raw AI output into a Zod-validated typed result.
 * Strips markdown fences, extracts JSON, validates with schema.
 */
export function parseAIJson<T>(raw: string, schema: z.ZodSchema<T>): T {
  let cleaned = raw.replace(/```(?:json)?\s*\n?/g, "").replace(/```/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new AIParseError("Could not extract JSON from AI output", raw);
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch (innerErr) {
      throw new AIParseError("Extracted JSON block is not valid JSON", raw, innerErr);
    }
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new AIParseError(`AI output failed schema validation:\n${issues}`, raw, result.error);
  }

  return result.data;
}
