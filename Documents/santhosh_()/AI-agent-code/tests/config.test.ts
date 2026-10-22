import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "../src/config.js";

describe("CONFIG", () => {
  it("applies defaults and resolves paths to absolute", () => {
    expect(CONFIG.ai.engine).toBe("claude");
    expect(CONFIG.limits).toEqual({ analysisTimeoutMs: 300_000, maxFileSizeBytes: 500_000 });
    expect(path.isAbsolute(CONFIG.paths.db)).toBe(true);
    expect(path.isAbsolute(CONFIG.paths.reposBase)).toBe(true);
    expect(CONFIG.allowedUserIds).toEqual([]);
    expect(CONFIG.github.token).toBeUndefined();
  });
});

describe("config env validation (fresh import)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    vi.resetModules();
  });

  async function fresh(env: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
    return import("../src/config.js");
  }
  const mockExit = () =>
    vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      throw new Error(`process.exit(${c})`);
    }) as never);

  it("exits when TELEGRAM_BOT_TOKEN is missing or empty", async () => {
    const exit = mockExit();
    await expect(fresh({ TELEGRAM_BOT_TOKEN: undefined })).rejects.toThrow("process.exit(1)");
    await expect(fresh({ TELEGRAM_BOT_TOKEN: "" })).rejects.toThrow("process.exit(1)");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("validates AI_ENGINE and numeric limits", async () => {
    mockExit();
    await expect(fresh({ AI_ENGINE: "gemini" })).rejects.toThrow("process.exit(1)");
    await expect(fresh({ AI_ENGINE: "claude", ANALYSIS_TIMEOUT_SEC: "29" })).rejects.toThrow("process.exit(1)");
    await expect(fresh({ ANALYSIS_TIMEOUT_SEC: "60", MAX_FILE_SIZE_BYTES: "999" })).rejects.toThrow("process.exit(1)");
    const mod = await fresh({ ANALYSIS_TIMEOUT_SEC: "30", MAX_FILE_SIZE_BYTES: "1000", AI_ENGINE: "openai" });
    expect(mod.CONFIG.limits).toEqual({ analysisTimeoutMs: 30_000, maxFileSizeBytes: 1000 });
    expect(mod.CONFIG.ai.engine).toBe("openai");
  });

  it("parses ALLOWED_USER_IDS into trimmed strings", async () => {
    const mod = await fresh({ ALLOWED_USER_IDS: " 1, 2 ,,3 " });
    expect(mod.CONFIG.allowedUserIds).toEqual(["1", "2", "3"]);
  });
});
