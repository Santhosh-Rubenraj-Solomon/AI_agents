/**
 * config.ts — Zod-validated environment configuration.
 *
 * All env vars are validated at import time. If any required var is
 * missing or malformed, the process exits immediately with a clear error.
 */

import path from "node:path";
import { z } from "zod";
import "dotenv/config";

const EnvSchema = z.object({
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, "Required — get from @BotFather"),

  // AI Engine
  AI_ENGINE: z.enum(["claude", "openai"]).default("claude"),
  OPENAI_API_KEY: z.string().optional(),

  // GitHub
  GITHUB_TOKEN: z.string().optional(),

  // Paths
  REPOS_BASE_DIR: z.string().default("./repos"),
  DB_PATH: z.string().default("./data/ai-agent.db"),

  // Limits
  ANALYSIS_TIMEOUT_SEC: z.coerce.number().int().min(30).default(300),
  MAX_FILE_SIZE_BYTES: z.coerce.number().int().min(1000).default(500000),

  // Access control
  ALLOWED_USER_IDS: z.string().optional()
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`\nConfiguration validation failed:\n${issues}\n`);
  console.error("Copy .env.example to .env and fill in all required values.\n");
  process.exit(1);
}

const env = parsed.data;

export const CONFIG = {
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN
  },
  ai: {
    engine: env.AI_ENGINE,
    openaiKey: env.OPENAI_API_KEY
  },
  github: {
    token: env.GITHUB_TOKEN
  },
  paths: {
    reposBase: path.resolve(env.REPOS_BASE_DIR),
    db: path.resolve(env.DB_PATH)
  },
  limits: {
    analysisTimeoutMs: env.ANALYSIS_TIMEOUT_SEC * 1000,
    maxFileSizeBytes: env.MAX_FILE_SIZE_BYTES
  },
  allowedUserIds: env.ALLOWED_USER_IDS
    ? env.ALLOWED_USER_IDS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : []
} as const;
