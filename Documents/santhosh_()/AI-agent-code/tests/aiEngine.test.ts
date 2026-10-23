import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";

type ExecCb = (err: Error | null, res?: { stdout: string; stderr: string }) => void;
let lastPromptSeen: string | null = null;

function execSucceeds(stdout: string) {
  vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: ExecCb) => {
    const tmp = /cat "([^"]+)"/.exec(args[1])![1];
    lastPromptSeen = fs.readFileSync(tmp, "utf-8");
    cb(null, { stdout, stderr: "" });
  }) as any);
}

beforeEach(() => {
  lastPromptSeen = null;
  vi.mocked(execFile).mockReset();
});

describe("askAI / chatAI via Claude CLI", () => {
  it("pipes the prompt through a temp file into `claude -p` and cleans up", async () => {
    const { askAI } = await import("../src/services/aiEngine.js");
    execSucceeds("the answer");
    expect(await askAI("my prompt $(rm -rf /)", "/repo")).toBe("the answer");

    const [cmd, args, opts] = vi.mocked(execFile).mock.calls[0] as any[];
    expect(cmd).toBe("/bin/bash");
    expect(args[0]).toBe("-c");
    expect(args[1]).toMatch(/^cat ".+ai-agent-\d+-[a-z0-9]+\.txt" \| claude -p --allowedTools ""$/);
    expect(opts).toMatchObject({ cwd: "/repo", timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });
    expect(lastPromptSeen).toBe("my prompt $(rm -rf /)");
    const tmp = /cat "([^"]+)"/.exec(args[1])![1];
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it("chatAI uses a 2 minute timeout", async () => {
    const { chatAI } = await import("../src/services/aiEngine.js");
    execSucceeds("ok");
    await chatAI("hi", "/r");
    expect((vi.mocked(execFile).mock.calls[0] as any[])[2].timeout).toBe(120_000);
  });

  it("propagates CLI errors and still deletes the temp file", async () => {
    const { askAI } = await import("../src/services/aiEngine.js");
    let tmp = "";
    vi.mocked(execFile).mockImplementation(((_c: string, args: string[], _o: unknown, cb: ExecCb) => {
      tmp = /cat "([^"]+)"/.exec(args[1])![1];
      cb(new Error("claude: command not found"));
    }) as any);
    await expect(askAI("p", "/r", 1000)).rejects.toThrow("claude: command not found");
    expect(fs.existsSync(tmp)).toBe(false);
  });
});

describe("askAI via OpenAI", () => {
  async function loadOpenAI(key: string | undefined) {
    process.env.AI_ENGINE = "openai";
    if (key) process.env.OPENAI_API_KEY = key;
    else delete process.env.OPENAI_API_KEY;
    vi.resetModules();
    return import("../src/services/aiEngine.js");
  }
  afterEach(() => {
    process.env.AI_ENGINE = "claude";
    delete process.env.OPENAI_API_KEY;
    vi.useRealTimers();
    vi.resetModules();
  });

  it("calls the chat completions API with the key and returns the content", async () => {
    const { askAI } = await loadOpenAI("sk-fake");
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "hello" } }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await askAI("question")).toBe("hello");
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-fake");
    expect(JSON.parse(init.body)).toMatchObject({ model: "gpt-4o", messages: [{ role: "user", content: "question" }] });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("returns empty string when no choices are returned", async () => {
    const { askAI } = await loadOpenAI("sk-fake");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ choices: [] }) })));
    expect(await askAI("q")).toBe("");
  });

  it("throws on non-OK responses including status and body", async () => {
    const { askAI } = await loadOpenAI("sk-fake");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, text: async () => "rate limited" })));
    await expect(askAI("q")).rejects.toThrow("OpenAI API error 429: rate limited");
  });

  it("throws if the API key is missing", async () => {
    const { askAI } = await loadOpenAI(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(askAI("q")).rejects.toThrow("OPENAI_API_KEY not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts the request after the timeout", async () => {
    const { askAI } = await loadOpenAI("sk-fake");
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))),
      ),
    );
    const p = askAI("q", "/r", 5_000);
    const assertion = expect(p).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });
});
