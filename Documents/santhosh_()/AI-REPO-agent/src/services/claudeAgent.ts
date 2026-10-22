/**
 * services/claudeAgent.ts — Async Claude CLI wrapper.
 *
 * Implements the ClaudeAgentInterface with three methods:
 * - analyze: read-only, no tools
 * - execute: write mode, scoped tools
 * - review: read-only, no tools
 *
 * The Claude CLI is spawned directly (no shell) with an argument array and
 * the prompt written to its stdin, so user-supplied descriptions can never
 * be interpreted by a shell. The child gets an environment without the
 * bot's Slack/GitLab credentials (see utils/redact.ts#scrubbedEnv).
 *
 * All calls are async. Timeouts are enforced (5min analysis/review,
 * 10min execution): on timeout the CLI gets SIGTERM, then SIGKILL.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG, assertPathsInScope } from "../config.js";
import { parseClaudeJson, TaskAnalysisSchema, getTypeLabel } from "../schemas.js";
import { createLogger } from "../utils/logger.js";
import { scrubbedEnv } from "../utils/redact.js";
import type {
  ClaudeAgentInterface,
  TaskAnalysis,
} from "../types.js";
import type { FullTaskRequest } from "../types.js";

const execFileAsync = promisify(execFile);
const log = createLogger("Claude");

const ANALYSIS_TIMEOUT = 5 * 60 * 1000;  // 5 minutes
const EXECUTION_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const CHAT_TIMEOUT = 2 * 60 * 1000;       // 2 minutes (conversational responses should be fast)
const MAX_BUFFER = 1024 * 1024 * 10;       // 10 MB
const KILL_GRACE_MS = 5_000;

/** Tools denied in read-only modes (analysis, summaries, chat). */
const READ_ONLY_DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
];

// ─── Core Claude CLI runner ───────────────────────────────────────────────────

/**
 * Build the `claude` argument list. Exported for tests.
 */
export function buildClaudeArgs(tools: boolean, allowedPaths: string[]): string[] {
  const args: string[] = ["-p"];

  if (tools && allowedPaths.length > 0) {
    const toolList = [
      "Edit",
      "Write",
      "Read",
      ...allowedPaths.map((p) => `Bash(find:${p})`),
      ...allowedPaths.map((p) => `Bash(cat:${p})`),
    ].join(",");
    args.push("--allowedTools", toolList);
  } else {
    // Read-only modes (analysis, summaries, chat): explicitly deny every
    // tool that can modify files, run commands or reach the network, so a
    // prompt-injected request cannot escalate beyond reading the repo.
    args.push("--allowedTools", "");
    args.push("--disallowedTools", READ_ONLY_DISALLOWED_TOOLS.join(","));
  }
  return args;
}

/**
 * Spawn a command without a shell, feed `input` on stdin, and collect
 * stdout. Rejects on non-zero exit, spawn error, timeout or oversized output.
 */
export function runWithStdin(
  command: string,
  args: string[],
  input: string,
  opts: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv; maxBuffer?: number },
): Promise<string> {
  const maxBuffer = opts.maxBuffer ?? MAX_BUFFER;

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? scrubbedEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (err: Error | null, out?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out ?? "");
    };

    const kill = () => {
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      kill();
      finish(new Error(`${command} timed out after ${Math.round(opts.timeout / 1000)}s`));
    }, opts.timeout);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > maxBuffer) {
        kill();
        finish(new Error(`${command} output exceeded ${maxBuffer} bytes`));
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      // Keep only the tail — enough for an error message.
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    proc.on("error", (err) => finish(new Error(`Failed to spawn ${command}: ${err.message}`)));
    proc.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) {
        finish(null, stdout);
      } else {
        finish(
          new Error(
            `${command} exited with ${code !== null ? `code ${code}` : `signal ${signal}`}` +
              (stderr.trim() ? `: ${stderr.trim().slice(-1000)}` : "")
          )
        );
      }
    });

    // EPIPE if the child exits before reading stdin — surfaced via close/error.
    proc.stdin?.on("error", () => {});
    proc.stdin?.end(input, "utf-8");
  });
}

async function runClaude(
  prompt: string,
  cwd: string,
  opts: {
    tools?: boolean;
    allowedPaths?: string[];
    timeout?: number;
  } = {}
): Promise<string> {
  const { tools = false, allowedPaths = [], timeout = ANALYSIS_TIMEOUT } = opts;

  log.info("Invoking Claude CLI", {
    promptLength: prompt.length,
    cwd,
    tools: tools ? "write" : "read-only",
    timeoutMs: timeout,
  });
  const startTime = Date.now();

  const stdout = await runWithStdin("claude", buildClaudeArgs(tools, allowedPaths), prompt, {
    cwd,
    timeout,
    maxBuffer: MAX_BUFFER,
    env: scrubbedEnv(),
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info("Claude CLI returned", { elapsedSec: elapsed, responseLength: stdout.length });

  return stdout;
}

// ─── Concrete implementation ──────────────────────────────────────────────────

export const claudeAgent: ClaudeAgentInterface = {
  async analyze(prompt: string, cwd: string): Promise<string> {
    return runClaude(prompt, cwd, { tools: false, timeout: ANALYSIS_TIMEOUT });
  },

  async execute(prompt: string, cwd: string, allowedPaths: string[]): Promise<string> {
    return runClaude(prompt, cwd, {
      tools: true,
      allowedPaths,
      timeout: EXECUTION_TIMEOUT,
    });
  },
};

// ─── Summary generation ────────────────────────────────────────────────────────

const SUMMARY_TIMEOUT = 3 * 60 * 1000; // 3 minutes

/**
 * Generate a human-friendly MR summary document using Claude CLI.
 *
 * Runs in read-only mode (no tools). The prompt should include all context
 * needed: task details, analysis, files changed, diff stats, review history,
 * and MR URL. Claude returns raw markdown.
 *
 * @param prompt - The fully assembled summary generation prompt
 * @param cwd   - Working directory (typically the monorepo root)
 * @returns Raw markdown string from Claude
 */
export async function generateSummary(prompt: string, cwd: string): Promise<string> {
  return runClaude(prompt, cwd, { tools: false, timeout: SUMMARY_TIMEOUT });
}

// ─── Conversational chat mode ────────────────────────────────────────────────

/**
 * Chat with Claude in read-only mode, scoped to the ECR service.
 *
 * Uses a system prompt that constrains answers to ECR-related topics
 * and general/friendly conversation. No tools — read-only.
 *
 * @param message - The user's message
 * @param context - Optional additional context (e.g., thread history)
 * @returns Claude's response text
 */
export async function chat(message: string, context?: string): Promise<string> {
  const systemPrompt = `You are the ECR Dev Factory assistant — a friendly, concise Slack bot that helps people with questions about the ECR (Electronic Cash Register) service.

RULES:
- You can answer questions about the ECR service and related services located at: ${CONFIG.allowedServicePaths.join(", ")}
- You can answer generic/general questions normally (greetings, programming concepts, etc.)
- If someone asks about a service outside the allowed scope, politely decline: "I'm only able to help with ECR and its related services!"
- Keep responses concise and conversational — this is Slack, not a documentation site.
- Use Slack markdown formatting (bold with *, code with backticks, etc.)
- Do NOT make changes to any files. You are read-only.
- If you are unsure about something specific in the codebase, say so rather than guessing.

SERVICE: ${CONFIG.service.name}
ALLOWED SERVICE PATHS: ${CONFIG.allowedServicePaths.join(", ")}`;

  const fullPrompt = context
    ? `${systemPrompt}\n\nCONTEXT:\n${context}\n\nUSER MESSAGE:\n${message}`
    : `${systemPrompt}\n\nUSER MESSAGE:\n${message}`;

  const cwd = CONFIG.repo.root;
  return runClaude(fullPrompt, cwd, { tools: false, timeout: CHAT_TIMEOUT });
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

/**
 * Build the file tree for the service directory.
 * Uses execFile to avoid shell injection.
 */
async function getServiceFileTree(cwd: string): Promise<string> {
  try {
    const trees: string[] = [];
    for (const svcPath of CONFIG.allowedServicePaths) {
      try {
        const { stdout } = await execFileAsync(
          "find",
          [svcPath, "-type", "f", "-name", "*.ts"],
          { cwd, timeout: 10_000, maxBuffer: MAX_BUFFER }
        );
        trees.push(stdout);
      } catch {
        // Some paths may not exist yet
      }
    }
    return trees
      .join("\n")
      .split("\n")
      .slice(0, 150)
      .join("\n");
  } catch {
    return "(could not read file tree)";
  }
}

/**
 * Get shared imports used by the service.
 *
 * Runs grep via execFile with an argument array (no shell), then sorts,
 * de-duplicates and truncates in JS — equivalent to the old
 * `grep ... | sort -u | head -40` pipeline without shell interpolation of
 * the configured paths.
 */
export async function getSharedImports(cwd: string): Promise<string> {
  const grepPaths = CONFIG.allowedServicePaths.map((p) => `${p}/src`);
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(
      "grep",
      ["-rh", "--include=*.ts", "-e", "from '@", "--", ...grepPaths],
      { cwd, timeout: 10_000, maxBuffer: MAX_BUFFER }
    ));
  } catch (err: unknown) {
    // grep exits 1 for "no match" and 2 for missing paths, but may still
    // have printed matches for the paths that do exist.
    stdout = (err as { stdout?: string }).stdout ?? "";
  }
  const lines = [...new Set(stdout.split("\n").filter(Boolean))].sort().slice(0, 40);
  return lines.length > 0 ? lines.join("\n") + "\n" : "None";
}

/**
 * Get the main module content.
 */
async function getMainModule(cwd: string): Promise<string> {
  try {
    const content = await fs.readFile(
      path.join(cwd, CONFIG.service.path, "src", "app.module.ts"),
      "utf-8"
    );
    return content.slice(0, 2000);
  } catch {
    return "Not found";
  }
}

// ─── Type-specific prompt context ─────────────────────────────────────────────

/**
 * Build additional context for the prompt based on the task type.
 * Extracts type-specific fields and formats them for Claude.
 */
function buildTypeSpecificContext(request: FullTaskRequest): string {
  const sections: string[] = [];

  switch (request.type) {
    case "bugfix":
      if (request.problemDescription) {
        sections.push(`PROBLEM DESCRIPTION:\n${request.problemDescription}`);
      }
      if (request.proposedSolution) {
        sections.push(`PROPOSED SOLUTION:\n${request.proposedSolution}`);
      }
      sections.push(
        `IMPORTANT: Before proceeding, validate whether the proposed solution is technically feasible ` +
        `given the codebase structure. If it is not feasible or would cause issues, explain why ` +
        `in your reasoning and propose an alternative approach.`
      );
      break;

    case "feature":
      if (request.featureDescription) {
        sections.push(`FEATURE DESCRIPTION:\n${request.featureDescription}`);
      }
      if (request.needsNewEndpoints && request.endpointDetails) {
        const ep = request.endpointDetails;
        const epLines: string[] = ["ENDPOINT REQUIREMENTS:"];
        if (ep.numberOfEndpoints) epLines.push(`- Number of endpoints: ${ep.numberOfEndpoints}`);
        if (ep.gatewayHeaderName) epLines.push(`- Gateway header name: ${ep.gatewayHeaderName}`);
        if (ep.controllerHeaderName) epLines.push(`- Controller header name: ${ep.controllerHeaderName}`);
        if (ep.exposeOnForeshore) {
          epLines.push(`- Expose on Foreshore: YES`);
          if (ep.foreshoreUrl) epLines.push(`- Foreshore URL path: ${ep.foreshoreUrl}`);
          if (ep.foreshoreParams?.length) epLines.push(`- Foreshore path params: ${ep.foreshoreParams.join(", ")}`);
          if (ep.foreshoreQueryParams?.length) epLines.push(`- Foreshore query params: ${ep.foreshoreQueryParams.join(", ")}`);
          epLines.push(
            `\nFORESHORE ARCHITECTURE NOTE:`,
            `Foreshore is the API Gateway / BFF layer. It receives external REST requests,`,
            `routes them via gateway headers to internal microservices.`,
            `When exposing on Foreshore, you need:`,
            `1. A controller in Foreshore with the URL path`,
            `2. The controller delegates to AppService which uses performRPCWithRequestId`,
            `3. The gateway header routes the request to the correct internal service`,
            `4. DTOs/validation at the Foreshore layer`,
          );
        }
        sections.push(epLines.join("\n"));
      }
      break;

    case "refactor":
      if (request.refactorDescription) {
        sections.push(`REFACTOR DETAILS:\n${request.refactorDescription}`);
      }
      sections.push(
        `REFACTOR RULES:\n` +
        `- Preserve all existing functionality and API contracts\n` +
        `- Do not change public interfaces unless explicitly requested\n` +
        `- Ensure all existing tests still pass`
      );
      break;

    case "documentation":
      if (request.documentationDescription) {
        sections.push(`DOCUMENTATION DETAILS:\n${request.documentationDescription}`);
      }
      sections.push(
        `DOCUMENTATION RULES:\n` +
        `- Write clear, concise documentation using JSDoc or markdown as appropriate\n` +
        `- Do not modify runtime code, only add/update documentation\n` +
        `- Include examples where helpful`
      );
      break;
  }

  return sections.join("\n\n");
}

// ─── High-level task functions ────────────────────────────────────────────────

/**
 * PHASE 1: Analysis — read-only, returns structured plan.
 * Runs against MONOREPO_ROOT (no worktree yet).
 */
export async function analyzeTask(
  request: FullTaskRequest
): Promise<TaskAnalysis> {
  const cwd = CONFIG.repo.root;
  const typeLabel = getTypeLabel(request.type);
  const typePrefix = request.type === "feature" ? "feat" :
                     request.type === "bugfix" ? "fix" :
                     request.type === "refactor" ? "refactor" : "docs";

  const [tree, imports, moduleContent] = await Promise.all([
    getServiceFileTree(cwd),
    getSharedImports(cwd),
    getMainModule(cwd),
  ]);

  const typeContext = buildTypeSpecificContext(request);

  // Use user-provided branch name hint if available
  const branchHint = request.branchName
    ? `Use the user-provided branch name: "${request.branchName}"`
    : `Generate a branch name in the format: ${CONFIG.service.name}/${typePrefix}/short-descriptive-name (max 30 chars total)`;

  const allowedPathsList = CONFIG.allowedServicePaths.map((p) => `  - ${p}/`).join("\n");
  const prompt = `
You are a senior NestJS/Nx architect analyzing a task for the ECR system.

RULES:
- ONLY plan changes within the following allowed service paths:
${allowedPathsList}
- Do NOT plan changes to other apps/* or libs/* outside the allowed paths
- If shared lib changes are needed, flag needsLibChanges: true

SERVICE: ${CONFIG.service.name} (primary: ${CONFIG.service.path}/)
ALLOWED PATHS:
${allowedPathsList}

File tree:
${tree}

Shared imports:
${imports}

Main module:
${moduleContent}

REQUEST TYPE: ${typeLabel} (${request.type})
TITLE: ${request.title}
PRIORITY: ${request.priority}
DESCRIPTION: ${request.description}

${typeContext}

BRANCH NAME: ${branchHint}

Respond ONLY with valid JSON (no markdown fences):
{
  "reasoning": "Detailed step-by-step thought process. For bug fixes, validate whether the proposed solution is feasible.",
  "approach": ["Step 1: ...", "Step 2: ..."],
  "filesToChange": ["${CONFIG.allowedServicePaths[0]}/src/..."],
  "filesToCreate": [],
  "affectedServices": [],
  "proposedChanges": "Detailed description of every change",
  "estimatedComplexity": "low|medium|high",
  "branchName": "${CONFIG.service.name}/${typePrefix}/short-name",
  "risks": [],
  "needsLibChanges": false
}`;

  const raw = await claudeAgent.analyze(prompt, cwd);
  const analysis = parseClaudeJson(raw, TaskAnalysisSchema);
  assertPathsInScope([...analysis.filesToChange, ...analysis.filesToCreate]);
  return analysis;
}

/**
 * PHASE 2: Execute — write code changes scoped to the worktree.
 */
export async function executeTask(
  request: FullTaskRequest,
  analysis: TaskAnalysis,
  worktreePath: string
): Promise<void> {
  const typeLabel = getTypeLabel(request.type);
  const typeContext = buildTypeSpecificContext(request);

  const allowedPathsList = CONFIG.allowedServicePaths.map((p) => `  - ${p}/`).join("\n");
  const prompt = `
You are a senior NestJS engineer working on the ECR system.

HARD CONSTRAINTS:
- ONLY modify/create files under these allowed service paths:
${allowedPathsList}
- Do NOT touch anything else

SERVICE: ${CONFIG.service.name} (primary: ${CONFIG.service.path}/)
ALLOWED PATHS:
${allowedPathsList}
TASK TYPE: ${typeLabel}
TASK: ${request.title}
DESCRIPTION: ${request.description}

${typeContext}

PLAN:
${analysis.approach.map((s, i) => `${i + 1}. ${s}`).join("\n")}

FILES TO MODIFY: ${analysis.filesToChange.join(", ")}
FILES TO CREATE: ${analysis.filesToCreate.join(", ") || "none"}

CHANGES:
${analysis.proposedChanges}

Follow NestJS conventions. Use proper DTOs, decorators, DI, error handling.`;

  await claudeAgent.execute(prompt, worktreePath, CONFIG.allowedServicePaths);
}

/**
 * PHASE 3b: Fix review issues based on raw markdown feedback from the external reviewer.
 *
 * Claude reads the review markdown, fixes actionable issues, and writes a
 * disagreements file for any comments it considers incorrect or inapplicable.
 */
export async function fixReviewIssues(
  request: FullTaskRequest,
  analysis: TaskAnalysis,
  reviewContent: string,
  worktreePath: string,
  taskId: string,
): Promise<void> {
  const allowedPathsList = CONFIG.allowedServicePaths.map((p) => `  - ${p}/`).join("\n");
  const prompt = `
You are a senior NestJS engineer fixing code review issues in the ECR system.

HARD CONSTRAINTS:
- ONLY modify files under these allowed service paths:
${allowedPathsList}
- Fix issues identified in the review below
- If you DISAGREE with any review comment (it is incorrect, inapplicable, or
  would make the code worse), do NOT apply that fix. Instead, write your
  reasoning to the file: review-disagreements-${taskId}.md in the current
  working directory. Format each disagreement as:

  ## Comment: <brief quote of the review comment>
  **Reasoning:** <why you disagree>

SERVICE: ${CONFIG.service.name} (primary: ${CONFIG.service.path}/)
ALLOWED PATHS:
${allowedPathsList}
ORIGINAL TASK: ${request.title}

REVIEW FEEDBACK (from external reviewer):
${reviewContent.slice(0, 48000)}

Read the review feedback above carefully. For each actionable issue:
1. Locate the relevant file and code
2. Apply the fix if you agree it improves the code
3. If you disagree, document it in the disagreements file

Do not refactor unrelated code. Focus only on the reviewer's comments.`;

  await claudeAgent.execute(prompt, worktreePath, CONFIG.allowedServicePaths);
}
