import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG, assertPathsInScope, assertValidBranchName, isPathInScope } from "../src/config.js";

describe("CONFIG", () => {
  it("parses env into the config object with defaults", () => {
    expect(CONFIG.slack.botToken).toBe("xoxb-test-token");
    expect(CONFIG.service.name).toBe("ecr-service");
    expect(CONFIG.service.fullPath).toBe(path.join("/tmp/fake-monorepo", "apps/ecr"));
    expect(CONFIG.allowedServicePaths).toEqual(["apps/ecr", "libs/shared"]);
    expect(CONFIG.repo.remote).toBe("origin");
    expect(CONFIG.repo.baseBranch).toBe("main");
    expect(CONFIG.pipeline).toMatchObject({
      maxReviewIterations: 3,
      taskTtlMinutes: 60,
      rateLimitSeconds: 30,
    });
    expect(CONFIG.reviewerUserIds).toEqual([]);
    expect(CONFIG.adminUserId).toBe("UADMIN");
  });
});

describe("config env validation (fresh import)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    vi.resetModules();
  });

  async function freshImport(env: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
    return import("../src/config.js");
  }

  function mockExit() {
    return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  }

  it("exits with code 1 when the bot token has the wrong prefix", async () => {
    const exit = mockExit();
    await expect(freshImport({ SLACK_BOT_TOKEN: "not-a-bot-token" })).rejects.toThrow("process.exit(1)");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits when a required variable is missing", async () => {
    const exit = mockExit();
    await expect(freshImport({ ADMIN_USER_ID: undefined })).rejects.toThrow("process.exit(1)");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits when GITLAB_HOST is not a URL", async () => {
    mockExit();
    await expect(freshImport({ GITLAB_HOST: "gitlab" })).rejects.toThrow("process.exit(1)");
  });

  it("rejects MAX_REVIEW_ITERATIONS out of range and coerces numeric strings", async () => {
    mockExit();
    await expect(freshImport({ MAX_REVIEW_ITERATIONS: "11" })).rejects.toThrow("process.exit(1)");
    const mod = await freshImport({ MAX_REVIEW_ITERATIONS: "5", RATE_LIMIT_SECONDS: "45" });
    expect(mod.CONFIG.pipeline.maxReviewIterations).toBe(5);
    expect(mod.CONFIG.pipeline.rateLimitSeconds).toBe(45);
  });

  it("defaults allowedServicePaths to MY_SERVICE_PATH and trims comma lists", async () => {
    let mod = await freshImport({ ALLOWED_SERVICE_PATHS: undefined });
    expect(mod.CONFIG.allowedServicePaths).toEqual(["apps/ecr"]);
    mod = await freshImport({ ALLOWED_SERVICE_PATHS: " apps/a , ,libs/b ", REVIEWER_USER_IDS: "U1, U2,," });
    expect(mod.CONFIG.allowedServicePaths).toEqual(["apps/a", "libs/b"]);
    expect(mod.CONFIG.reviewerUserIds).toEqual(["U1", "U2"]);
  });
});

describe("assertPathsInScope", () => {
  it("accepts files inside any allowed path (with or without a leading slash)", () => {
    expect(() =>
      assertPathsInScope(["apps/ecr/src/a.ts", "/apps/ecr/b.ts", "libs/shared/index.ts"]),
    ).not.toThrow();
  });

  it("accepts an empty list", () => {
    expect(() => assertPathsInScope([])).not.toThrow();
  });

  it("throws a SCOPE VIOLATION for out-of-scope files", () => {
    expect(() => assertPathsInScope(["apps/ecr/ok.ts", "apps/other/x.ts"])).toThrow(
      /SCOPE VIOLATION: "apps\/other\/x.ts"/,
    );
  });

  // Previously a BUG: the scope check was a raw string prefix match, so a sibling
  // directory sharing the prefix ("apps/ecr-evil") and "../" traversal both passed.
  it("rejects sibling directories that merely share the prefix", () => {
    expect(() => assertPathsInScope(["apps/ecr-evil/x.ts"])).toThrow(/SCOPE VIOLATION/);
    expect(() => assertPathsInScope(["libs/shared-other/index.ts"])).toThrow(/SCOPE VIOLATION/);
  });

  it("rejects path traversal out of the allowed directory", () => {
    expect(() => assertPathsInScope(["apps/ecr/../../etc/passwd"])).toThrow(/SCOPE VIOLATION/);
    expect(() => assertPathsInScope(["apps/ecr/../other/x.ts"])).toThrow(/SCOPE VIOLATION/);
    expect(() => assertPathsInScope(["../apps/ecr/x.ts"])).toThrow(/SCOPE VIOLATION/);
  });

  it("accepts traversal that stays inside the allowed directory", () => {
    expect(() => assertPathsInScope(["apps/ecr/src/../test/a.ts", "./apps/ecr/x.ts"])).not.toThrow();
  });

  it.each([
    "/etc/passwd",
    "//apps/ecr/x.ts",
    "C:/apps/ecr/x.ts",
    "apps\\ecr\\x.ts",
    "apps/ecr\0/x.ts",
    "",
  ])("rejects absolute / malformed path %j", (file) => {
    expect(() => assertPathsInScope([file])).toThrow(/SCOPE VIOLATION/);
  });

  it("accepts absolute paths that point inside MONOREPO_ROOT", () => {
    expect(() => assertPathsInScope(["/tmp/fake-monorepo/apps/ecr/x.ts"])).not.toThrow();
    expect(() => assertPathsInScope(["/tmp/fake-monorepo/apps/other/x.ts"])).toThrow(/SCOPE VIOLATION/);
  });
});

describe("isPathInScope", () => {
  it("matches the allowed directory itself and anything below it", () => {
    expect(isPathInScope("apps/ecr", ["apps/ecr"])).toBe(true);
    expect(isPathInScope("apps/ecr/", ["apps/ecr/"])).toBe(true);
    expect(isPathInScope("apps/ecr/deep/a.ts", ["apps/ecr"])).toBe(true);
    expect(isPathInScope("apps/ecrx", ["apps/ecr"])).toBe(false);
    expect(isPathInScope("apps", ["apps/ecr"])).toBe(false);
  });

  it("never treats an empty or '.' allowed path as 'everything'", () => {
    expect(isPathInScope("apps/x.ts", ["."])).toBe(false);
    expect(isPathInScope("apps/x.ts", [""])).toBe(false);
  });
});

describe("assertValidBranchName", () => {
  it.each(["fix/receipt", "feat/a_b-c", "main", "a/b/c"])("accepts %s", (name) => {
    expect(() => assertValidBranchName(name)).not.toThrow();
  });

  it.each(["has space", "semi;colon", "dots..", "$(rm -rf)", "", "--mirror", "-b", "fix/-x", "/fix", "fix/", "a//b", "HEAD"])("rejects %j", (name) => {
    expect(() => assertValidBranchName(name)).toThrow(/Invalid branch name/);
  });
});
