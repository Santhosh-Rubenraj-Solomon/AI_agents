/**
 * Global test setup — runs before each test file, before src/config.ts is imported.
 *
 * src/config.ts validates env at import time (process.exit(1) on failure), so fake
 * values are provided here. DB and repo clone dirs point into a per-file temp dir.
 * No test talks to Telegram, GitHub, OpenAI or the Claude CLI.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, vi } from "vitest";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-agent-code-test-"));

process.env.TELEGRAM_BOT_TOKEN = "123456:fake-telegram-token";
process.env.AI_ENGINE = "claude";
process.env.REPOS_BASE_DIR = path.join(tmpRoot, "repos");
process.env.DB_PATH = path.join(tmpRoot, "data", "test.db");
delete process.env.OPENAI_API_KEY;
delete process.env.GITHUB_TOKEN;
delete process.env.ALLOWED_USER_IDS;
delete process.env.ANALYSIS_TIMEOUT_SEC;
delete process.env.MAX_FILE_SIZE_BYTES;

(globalThis as any).__TEST_TMP_ROOT__ = tmpRoot;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
