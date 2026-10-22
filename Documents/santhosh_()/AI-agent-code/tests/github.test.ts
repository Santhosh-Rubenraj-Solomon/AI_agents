import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gitByPath = new Map<string, any>();
function fakeGit() {
  return {
    clone: vi.fn(async () => {}),
    pull: vi.fn(async () => {}),
    branch: vi.fn(async () => ({ current: "develop" })),
    diff: vi.fn(async () => "DIFF"),
    diffSummary: vi.fn(async () => ({ files: [{ file: "a.ts" }, { file: "b/c.ts" }] })),
    log: vi.fn(async () => ({
      all: [
        { hash: "abcdef1234567", date: "2026-01-01", message: "feat: x" },
        { hash: "1234567abcdef", date: "2026-01-02", message: "fix: y" },
      ],
    })),
  };
}
vi.mock("simple-git", () => ({
  simpleGit: vi.fn((p?: string) => {
    const key = p ?? "<root>";
    if (!gitByPath.has(key)) gitByPath.set(key, fakeGit());
    return gitByPath.get(key);
  }),
}));

import { CONFIG } from "../src/config.js";
import {
  cleanupRepo,
  cloneOrPullRepo,
  getChangedFiles,
  getRecentCommits,
  getRecentDiff,
  parseGitHubUrl,
} from "../src/services/github.js";
import { makeTree, rmTree } from "./helpers.js";

beforeEach(() => {
  gitByPath.clear();
  fs.rmSync(CONFIG.paths.reposBase, { recursive: true, force: true });
});

describe("parseGitHubUrl", () => {
  it.each([
    ["https://github.com/expressjs/express", { owner: "expressjs", name: "express" }],
    ["https://github.com/expressjs/express.git", { owner: "expressjs", name: "express" }],
    ["https://github.com/expressjs/express/", { owner: "expressjs", name: "express" }],
    ["http://github.com/a/b?tab=readme#top", { owner: "a", name: "b" }],
    ["https://github.com/a/b/tree/main/src", { owner: "a", name: "b" }],
    ["github.com/a/b", { owner: "a", name: "b" }],
    ["https://github.com/my-org/my_repo-2", { owner: "my-org", name: "my_repo-2" }],
  ])("%s", (url, expected) => {
    expect(parseGitHubUrl(url)).toEqual(expected);
  });

  it.each(["https://gitlab.com/a/b", "https://github.com/onlyowner", "not a url", ""])("rejects %j", (url) => {
    expect(parseGitHubUrl(url)).toBeNull();
  });

  // BUG (src/services/github.ts:26-28): the name group is [^/.]+? so repo names that
  // contain a dot (vercel/next.js, socketio/socket.io, ...) are rejected as invalid URLs.
  it.skip("BUG: accepts repository names containing dots", () => {
    expect(parseGitHubUrl("https://github.com/vercel/next.js")).toEqual({ owner: "vercel", name: "next.js" });
  });
});

describe("cloneOrPullRepo", () => {
  it("throws for invalid URLs", async () => {
    await expect(cloneOrPullRepo("https://example.com/x")).rejects.toThrow("Invalid GitHub URL");
  });

  it("shallow-clones fresh repos under REPOS_BASE_DIR/owner/name", async () => {
    const info = await cloneOrPullRepo("https://github.com/acme/api");
    const localPath = path.join(CONFIG.paths.reposBase, "acme", "api");
    expect(fs.existsSync(CONFIG.paths.reposBase)).toBe(true);
    expect(gitByPath.get("<root>").clone).toHaveBeenCalledWith("https://github.com/acme/api", localPath, ["--depth", "50"]);
    expect(info).toEqual({ owner: "acme", name: "api", url: "https://github.com/acme/api", localPath, defaultBranch: "develop" });
  });

  it("pulls when the repo already exists", async () => {
    const localPath = path.join(CONFIG.paths.reposBase, "acme", "api");
    fs.mkdirSync(path.join(localPath, ".git"), { recursive: true });
    const info = await cloneOrPullRepo("https://github.com/acme/api.git");
    const g = gitByPath.get(localPath);
    expect(g.pull).toHaveBeenCalled();
    expect(gitByPath.get("<root>").clone).not.toHaveBeenCalled();
    expect(info.defaultBranch).toBe("develop");
  });

  it("keeps the existing checkout (branch 'main') when pull fails", async () => {
    const localPath = path.join(CONFIG.paths.reposBase, "acme", "api");
    fs.mkdirSync(path.join(localPath, ".git"), { recursive: true });
    const g = fakeGit();
    g.pull.mockRejectedValue(new Error("network"));
    gitByPath.set(localPath, g);
    const info = await cloneOrPullRepo("https://github.com/acme/api");
    expect(info.defaultBranch).toBe("main");
  });

  it("propagates clone failures", async () => {
    const g = fakeGit();
    g.clone.mockRejectedValue(new Error("Repository not found"));
    gitByPath.set("<root>", g);
    await expect(cloneOrPullRepo("https://github.com/acme/missing")).rejects.toThrow("Repository not found");
  });

  // BUG (src/services/github.ts:79-83): parseGitHubUrl accepts deep links like
  // ".../owner/repo/tree/main" but the *raw* URL is passed to `git clone`, which fails.
  it.skip("BUG: clones the canonical repo URL for deep links", async () => {
    await cloneOrPullRepo("https://github.com/acme/api/tree/main/src");
    const cloneUrl = gitByPath.get("<root>").clone.mock.calls[0][0];
    expect(cloneUrl).not.toContain("/tree/");
  });
});

describe("cloneOrPullRepo with GITHUB_TOKEN", () => {
  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    vi.resetModules();
  });

  it("injects the token into the clone URL", async () => {
    process.env.GITHUB_TOKEN = "ghp_fake";
    vi.resetModules();
    const mod = await import("../src/services/github.js");
    await mod.cloneOrPullRepo("http://github.com/acme/private");
    expect(gitByPath.get("<root>").clone.mock.calls[0][0]).toBe("https://ghp_fake@github.com/acme/private");
  });
});

describe("git history helpers", () => {
  it("getRecentDiff diffs HEAD~n..HEAD and falls back gracefully", async () => {
    expect(await getRecentDiff("/r1", 3)).toBe("DIFF");
    expect(gitByPath.get("/r1").diff).toHaveBeenCalledWith(["HEAD~3", "HEAD"]);

    const g = fakeGit();
    g.diff.mockRejectedValueOnce(new Error("shallow")).mockResolvedValueOnce("WORKTREE");
    gitByPath.set("/r2", g);
    expect(await getRecentDiff("/r2")).toBe("WORKTREE");
    expect((g.diff.mock.calls[0] as unknown[])[0]).toEqual(["HEAD~1", "HEAD"]);

    const g3 = fakeGit();
    g3.diff.mockRejectedValue(new Error("not a repo"));
    gitByPath.set("/r3", g3);
    expect(await getRecentDiff("/r3")).toBe("");
  });

  it("getRecentCommits formats short hash, date and message", async () => {
    expect(await getRecentCommits("/r", 2)).toBe("abcdef1 2026-01-01 feat: x\n1234567 2026-01-02 fix: y");
    expect(gitByPath.get("/r").log).toHaveBeenCalledWith({ maxCount: 2 });
    const g = fakeGit();
    g.log.mockRejectedValue(new Error("x"));
    gitByPath.set("/bad", g);
    expect(await getRecentCommits("/bad")).toBe("(no commits available)");
  });

  it("getChangedFiles lists files or [] on error", async () => {
    expect(await getChangedFiles("/r", 4)).toEqual(["a.ts", "b/c.ts"]);
    expect(gitByPath.get("/r").diffSummary).toHaveBeenCalledWith(["HEAD~4", "HEAD"]);
    const g = fakeGit();
    g.diffSummary.mockRejectedValue(new Error("x"));
    gitByPath.set("/bad", g);
    expect(await getChangedFiles("/bad")).toEqual([]);
  });
});

describe("cleanupRepo", () => {
  it("removes the directory and ignores missing paths", () => {
    const dir = makeTree({ "a/b.txt": "x" });
    cleanupRepo(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => cleanupRepo(dir)).not.toThrow();
    rmTree(dir);
  });
});
