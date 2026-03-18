/**
 * agents/advisor.ts — Conversational advisor for bugs, features, and architecture.
 *
 * Generates intelligent questions and guidance based on the codebase context.
 * Each task type has its own question flow that guides the user through
 * completing their task end-to-end.
 */

import { chatAI } from "../services/aiEngine.js";
import { getFileTree, readRepoFile } from "../services/techDetector.js";
import { createLogger } from "../utils/logger.js";
import type { TechProfile, AnalysisResult, TaskType, ConversationContext } from "../types.js";

const log = createLogger("Advisor");

// ─── Question templates per task type ────────────────────────────────────────

const BUGFIX_QUESTIONS = [
  "What is the bug you're experiencing? Please describe the expected vs actual behavior.",
  "Can you share the error message or stack trace (if any)?",
  "Which part of the application is affected? (e.g., API endpoint, UI component, database query)",
  "When did this start happening? Was there a recent change or deployment?",
  "Can you reproduce the bug consistently? What are the steps to reproduce?",
];

const FEATURE_QUESTIONS = [
  "Describe the feature you want to add. What problem does it solve?",
  "Who are the users/consumers of this feature? (API consumers, UI users, internal services)",
  "Does this feature require new API endpoints, database changes, or message patterns?",
  "Are there any existing components that this feature will interact with or modify?",
  "What are the acceptance criteria? How will you know the feature is complete?",
];

const BREAKING_CHANGE_QUESTIONS = [
  "Which files or components were recently changed?",
  "How many commits back should I analyze for breaking changes? (default: 5)",
  "Are there known downstream consumers or services that depend on this codebase?",
  "Are there any database migrations included in the changes?",
  "Is there a rollback plan if breaking changes are detected?",
];

const ARCHITECTURE_QUESTIONS = [
  "What aspect of the architecture would you like to understand? (data flow, component interaction, deployment, etc.)",
  "Are you looking at a specific feature flow or the overall system design?",
  "Do you need recommendations for improvements or just documentation of the current state?",
];

function getQuestions(taskType: TaskType): string[] {
  switch (taskType) {
    case "bugfix": return BUGFIX_QUESTIONS;
    case "feature": return FEATURE_QUESTIONS;
    case "breaking_changes": return BREAKING_CHANGE_QUESTIONS;
    case "architecture": return ARCHITECTURE_QUESTIONS;
    case "general": return ["What would you like to know about this codebase?"];
  }
}

// ─── Generate initial questions ──────────────────────────────────────────────

export function generateInitialQuestions(taskType: TaskType): string[] {
  return getQuestions(taskType);
}

// ─── Generate AI-powered response to user answer ─────────────────────────────

export async function generateAdvisorResponse(
  context: ConversationContext,
  userMessage: string,
  profile: TechProfile,
  analysis: AnalysisResult | null,
  repoPath: string,
): Promise<string> {
  log.info("Generating advisor response", {
    sessionId: context.sessionId,
    taskType: context.taskType,
    step: context.currentStep,
  });

  const fileTree = getFileTree(repoPath, 2);
  const historyText = context.questions
    .map((q) => `${q.role === "user" ? "User" : "Assistant"}: ${q.content}`)
    .join("\n");

  const analysisContext = analysis
    ? `\nKEY COMPONENTS:\n${analysis.keyComponents.map((c) => `- ${c.name} (${c.type}): ${c.purpose}`).join("\n")}\n\nAPI ENDPOINTS:\n${analysis.apiEndpoints.map((e) => `- ${e.method} ${e.path}: ${e.description}`).join("\n")}\n\nDATA MODELS:\n${analysis.dataModels.map((m) => `- ${m.name}: ${m.fields.join(", ")}`).join("\n")}`
    : "";

  const taskPrompts: Record<TaskType, string> = {
    bugfix: `You are a senior developer helping debug a bug in this open-source project.
Based on the conversation so far and the user's latest message, provide:
1. Root cause analysis — identify the most likely location and cause of the bug
2. Specific files and lines to investigate (reference real paths from the file tree)
3. A step-by-step fix with code snippets if possible
4. How to test the fix
5. If you need more information, ask a specific targeted question

IMPORTANT: Be specific about file paths and code. Reference real files from the project.`,

    feature: `You are a senior architect guiding the implementation of a new feature.
Based on the conversation so far and the user's latest message, provide:
1. Architecture decisions — where to add new code, which patterns to follow
2. Files to create or modify (reference real paths)
3. Data model changes needed (if any)
4. API endpoint design (if applicable)
5. Step-by-step implementation plan with specific code examples
6. Breaking change considerations — will this affect existing consumers?
7. Testing strategy

IMPORTANT: Follow the existing codebase patterns. Reference real files and conventions.`,

    breaking_changes: `You are a senior architect analyzing breaking changes.
Based on the conversation and user's input, provide:
1. Which changes could break existing consumers
2. API contract analysis — field additions, removals, type changes
3. Database schema impact
4. Message bus / event contract changes
5. Mitigation strategies for each breaking change
6. Recommended rollout plan (backward-compatible → deprecation → removal)

Use the breaking change analysis checklist:
□ DTOs: Are all changed fields optional? Any required fields added?
□ Enums: Any enum values removed or renumbered?
□ Types: Any TypeScript types narrowed?
□ Defaults: Do new required fields have sensible defaults?
□ Database: Will existing rows remain valid after migration?
□ Messages: Will old message payloads still deserialize?
□ Consumers: Have all known API consumers been identified?
□ Rollback: Can this change be rolled back without data loss?`,

    architecture: `You are a senior architect explaining this codebase's architecture.
Based on the conversation and user's question, provide:
1. Clear explanation of the relevant architectural patterns
2. Component interaction diagrams (in text/ASCII form)
3. Data flow description
4. Key design decisions and their rationale
5. Recommendations for improvements (if asked)

Reference specific files and components from the codebase.`,

    general: `You are a helpful assistant that answers questions about this open-source codebase.
Based on the conversation and user's question, provide clear, specific answers.
Reference actual files and components from the project.`,
  };

  const prompt = `${taskPrompts[context.taskType]}

## Codebase Context
- Languages: ${profile.languages.map((l) => `${l.name} (${l.percentage}%)`).join(", ")}
- Frameworks: ${profile.frameworks.join(", ") || "none"}
- Architecture: ${profile.architecture}
- Databases: ${profile.databases.join(", ") || "none"}
${analysisContext}

## File Tree
${fileTree}

## Conversation History
${historyText}

## User's Latest Message
${userMessage}

Respond concisely but thoroughly. Use markdown formatting. If you reference files, use their actual paths from the project. If you need more information to give a complete answer, ask a specific follow-up question.`;

  try {
    // Attempt to read any files the user mentions
    const filePatterns = userMessage.match(/[\w/.-]+\.(ts|js|py|java|go|rs|rb|php|vue|svelte|sql|yaml|yml|json|toml)/g);
    let fileContents = "";
    if (filePatterns) {
      for (const fp of filePatterns.slice(0, 3)) {
        const content = readRepoFile(repoPath, fp);
        if (content) {
          fileContents += `\n\n=== ${fp} ===\n${content.slice(0, 3000)}`;
        }
      }
    }

    const fullPrompt = fileContents
      ? `${prompt}\n\n## Referenced File Contents${fileContents}`
      : prompt;

    return await chatAI(fullPrompt, repoPath);
  } catch (err) {
    const error = err as Error;
    log.error("Advisor response failed", { error: error.message });
    return `I encountered an error generating a response: ${error.message}\n\nPlease try rephrasing your question or provide more details.`;
  }
}

/**
 * Generate a summary of the complete conversation/task.
 */
export async function generateTaskSummary(
  context: ConversationContext,
  profile: TechProfile,
  repoPath: string,
): Promise<string> {
  const historyText = context.questions
    .map((q) => `${q.role === "user" ? "User" : "Assistant"}: ${q.content}`)
    .join("\n");

  const prompt = `Summarize this technical conversation about a ${context.taskType} task for the project at ${context.repoUrl}.

Tech Stack: ${profile.frameworks.join(", ")} / ${profile.languages.map((l) => l.name).join(", ")}

Conversation:
${historyText}

Provide a concise summary with:
1. What was discussed
2. Key decisions/findings
3. Action items (if any)
4. Files to modify (if applicable)

Format as a clean markdown document.`;

  try {
    return await chatAI(prompt, repoPath);
  } catch {
    return "Unable to generate summary.";
  }
}
