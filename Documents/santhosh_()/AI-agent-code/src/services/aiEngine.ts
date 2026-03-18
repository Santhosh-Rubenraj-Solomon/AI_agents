/**
 * services/aiEngine.ts — AI engine abstraction.
 *
 * Supports Claude CLI and OpenAI API. The engine is selected via
 * AI_ENGINE env var. All agents call through this unified interface.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);
const log = createLogger("AIEngine");

const MAX_BUFFER = 1024 * 1024 * 10; // 10 MB

// ─── Temp file helpers ───────────────────────────────────────────────────────

async function writeTmpPrompt(content: string): Promise<string> {
  const filename = `ai-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  const filepath = path.join(os.tmpdir(), filename);
  await fs.writeFile(filepath, content, "utf-8");
  return filepath;
}

async function cleanTmp(filepath: string): Promise<void> {
  try { await fs.unlink(filepath); } catch { /* best-effort */ }
}

// ─── Claude CLI runner ───────────────────────────────────────────────────────

async function runClaude(prompt: string, cwd: string, timeout: number): Promise<string> {
  log.info("Invoking Claude CLI", { promptLength: prompt.length, cwd, timeoutMs: timeout });
  const startTime = Date.now();
  const tmpFile = await writeTmpPrompt(prompt);

  try {
    const shellCmd = `cat "${tmpFile}" | claude -p --allowedTools ""`;
    const { stdout } = await execFileAsync("/bin/bash", ["-c", shellCmd], {
      cwd,
      timeout,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env },
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.info("Claude CLI returned", { elapsedSec: elapsed, responseLength: stdout.length });
    return stdout;
  } finally {
    await cleanTmp(tmpFile);
  }
}

// ─── OpenAI API runner ───────────────────────────────────────────────────────

async function runOpenAI(prompt: string, timeout: number): Promise<string> {
  const apiKey = CONFIG.ai.openaiKey;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set but AI_ENGINE=openai");

  log.info("Invoking OpenAI API", { promptLength: prompt.length, timeoutMs: timeout });
  const startTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 16000,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices[0]?.message?.content || "";

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.info("OpenAI API returned", { elapsedSec: elapsed, responseLength: content.length });
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Unified interface ───────────────────────────────────────────────────────

/**
 * Send a prompt to the configured AI engine and get a response.
 * @param prompt - The full prompt text
 * @param cwd - Working directory (used by Claude CLI for context)
 * @param timeout - Timeout in ms (default: from config)
 */
export async function askAI(
  prompt: string,
  cwd: string = process.cwd(),
  timeout: number = CONFIG.limits.analysisTimeoutMs
): Promise<string> {
  if (CONFIG.ai.engine === "openai") {
    return runOpenAI(prompt, timeout);
  }
  return runClaude(prompt, cwd, timeout);
}

/**
 * Conversational AI — shorter timeout, optimized for chat responses.
 */
export async function chatAI(prompt: string, cwd: string = process.cwd()): Promise<string> {
  return askAI(prompt, cwd, 120_000); // 2 min timeout for chat
}
