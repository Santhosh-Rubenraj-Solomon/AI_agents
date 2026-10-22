/**
 * Global test setup — runs before every test file (before src/config.ts is imported).
 *
 * src/config.ts validates process.env at import time and calls process.exit(1)
 * on failure, so every required variable gets a fake, non-secret value here.
 * Nothing in the suite talks to Slack, GitLab, git or the Claude CLI.
 */
import { beforeEach, vi } from "vitest";

const TEST_ENV: Record<string, string> = {
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_SIGNING_SECRET: "test-signing-secret",
  SLACK_APP_TOKEN: "xapp-test-token",
  MONOREPO_ROOT: "/tmp/fake-monorepo",
  MY_SERVICE: "ecr-service",
  MY_SERVICE_PATH: "apps/ecr",
  ALLOWED_SERVICE_PATHS: "apps/ecr,libs/shared",
  GITLAB_PROJECT_ID: "123",
  GITLAB_HOST: "https://gitlab.example.test",
  GITLAB_TOKEN: "glpat-fake",
  ADMIN_USER_ID: "UADMIN",
  WORKTREE_BASE_DIR: "/tmp/fake-worktrees",
  // In-memory SQLite: closeDb() between tests gives every test a fresh DB.
  DB_PATH: ":memory:",
  LOG_LEVEL: "error",
};

for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v;
delete process.env.REVIEWER_USER_IDS;
delete process.env.SLACK_TO_GITLAB_MAP;

beforeEach(() => {
  // Keep test output readable — the app logs heavily.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});
