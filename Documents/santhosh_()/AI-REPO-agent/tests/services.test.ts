/**
 * Service-layer security tests: every child process is started without a
 * shell (argument arrays only), never inherits the bot's credentials when it
 * runs LLM-written code, and git/glab never see option-like user input.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { execFile, spawn } from "node:child_process";
import { claudeAgent, buildClaudeArgs, getSharedImports } from "../src/services/claudeAgent.js";
import { buildGlabArgs, createMergeRequest } from "../src/services/gitlabService.js";
import { runNxChecks } from "../src/services/nxService.js";
import { runReview } from "../src/services/reviewerService.js";
import { cleanupOnFailure, commitAndPush, isWorktreePath } from "../src/services/gitService.js";

type ExecCall = { cmd: string; args: string[]; opts: any };
const execCalls: ExecCall[] = [];

/** execFile fake: `respond` decides the result for each call. */
function mockExecFile(respond: (c: ExecCall) => { stdout?: string; error?: any } = () => ({ stdout: "" })) {
  vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], opts: any, cb: any) => {
    const call = { cmd, args, opts };
    execCalls.push(call);
    const r = respond(call);
    if (r.error) cb(r.error);
    else cb(null, { stdout: r.stdout ?? "", stderr: "" });
  }) as any);
}

/** spawn fake returning a controllable child process. */
function fakeChild(stdout = "", code = 0) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdinData = "";
  child.stdin = Object.assign(new EventEmitter(), {
    end: (data: string) => {
      child.stdinData = data;
      setImmediate(() => {
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        child.emit("close", code, null);
      });
    },
  });
  child.kill = vi.fn();
  return child;
}

const SECRET_KEYS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET", "GITLAB_TOKEN"];

beforeEach(() => {
  execCalls.length = 0;
  vi.mocked(execFile).mockReset();
  vi.mocked(spawn).mockReset();
});

describe("claudeAgent CLI invocation", () => {
  it("spawns `claude` directly (no shell) and sends the prompt on stdin", async () => {
    const child = fakeChild('{"ok":true}');
    vi.mocked(spawn).mockReturnValue(child);
    const prompt = `Fix "$(rm -rf /)" and \`whoami\`; echo $HOME`;

    const out = await claudeAgent.analyze(prompt, "/repo");

    expect(out).toBe('{"ok":true}');
    const [cmd, args, opts] = vi.mocked(spawn).mock.calls[0] as any[];
    expect(cmd).toBe("claude");
    expect(args).toEqual(["-p", "--allowedTools", "", "--disallowedTools", "Bash,Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch"]);
    expect(opts.shell).toBeFalsy();
    expect(opts.cwd).toBe("/repo");
    expect(child.stdinData).toBe(prompt);
    expect(args.join(" ")).not.toContain(prompt);
  });

  it("does not pass the bot's Slack/GitLab credentials to the Claude CLI", async () => {
    vi.mocked(spawn).mockReturnValue(fakeChild("ok"));
    await claudeAgent.execute("p", "/wt", ["apps/ecr"]);
    const env = (vi.mocked(spawn).mock.calls[0] as any[])[2].env;
    for (const k of SECRET_KEYS) expect(env[k]).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("scopes write-mode tools to the allowed paths", () => {
    expect(buildClaudeArgs(true, ["apps/ecr", "libs/shared"])).toEqual([
      "-p",
      "--allowedTools",
      "Edit,Write,Read,Bash(find:apps/ecr),Bash(find:libs/shared),Bash(cat:apps/ecr),Bash(cat:libs/shared)",
    ]);
    expect(buildClaudeArgs(true, []).slice(0, 3)).toEqual(["-p", "--allowedTools", ""]);
    expect(buildClaudeArgs(false, ["apps/ecr"])).toContain("--disallowedTools");
  });

  it("rejects with stderr when the CLI exits non-zero", async () => {
    const child = fakeChild("", 2);
    child.stdin.end = (data: string) => {
      child.stdinData = data;
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from("auth failed"));
        child.emit("close", 2, null);
      });
    };
    vi.mocked(spawn).mockReturnValue(child);
    await expect(claudeAgent.analyze("p", "/repo")).rejects.toThrow(/claude exited with code 2: auth failed/);
  });

  it("getSharedImports uses grep with an argument array, sorted and de-duplicated", async () => {
    mockExecFile(() => ({ stdout: "import { B } from '@b';\nimport { A } from '@a';\nimport { B } from '@b';\n" }));
    const out = await getSharedImports("/repo");
    expect(out).toBe("import { A } from '@a';\nimport { B } from '@b';\n");
    expect(execCalls[0].cmd).toBe("grep");
    expect(execCalls[0].args).toEqual(["-rh", "--include=*.ts", "-e", "from '@", "--", "apps/ecr/src", "libs/shared/src"]);
  });

  it("getSharedImports keeps partial output when grep exits non-zero", async () => {
    mockExecFile(() => ({ error: Object.assign(new Error("exit 2"), { stdout: "import x from '@x';\n" }) }));
    expect(await getSharedImports("/repo")).toBe("import x from '@x';\n");
    mockExecFile(() => ({ error: new Error("exit 1") }));
    expect(await getSharedImports("/repo")).toBe("None");
  });
});

describe("gitlabService", () => {
  const input = { branchName: "fix/x", title: "--fix(ecr): thing", description: "Line 1\n$(cat /etc/passwd)", reviewerIds: [7, 8] };

  it("passes the description verbatim and binds every value to its flag", () => {
    const args = buildGlabArgs(input);
    expect(args).toEqual([
      "mr",
      "create",
      "--source-branch=fix/x",
      "--target-branch=main",
      "--title=--fix(ecr): thing",
      "--description=Line 1\n$(cat /etc/passwd)",
      "--no-editor",
      "--yes",
      "--reviewer-id=7",
      "--reviewer-id=8",
    ]);
    expect(args.join(" ")).not.toContain('$(cat "');
  });

  it("truncates huge descriptions to stay under the argv limit", () => {
    const args = buildGlabArgs({ ...input, description: "x".repeat(300_000) });
    expect(args.find((a) => a.startsWith("--description="))!.length).toBeLessThan(100_100);
  });

  it("creates the MR via glab and parses the URL", async () => {
    mockExecFile(() => ({ stdout: "Creating merge request...\n!42 https://gitlab.example.test/g/r/-/merge_requests/42\n" }));
    const res = await createMergeRequest(input);
    expect(res).toEqual({ url: "https://gitlab.example.test/g/r/-/merge_requests/42", iid: 42 });
    expect(execCalls[0].cmd).toBe("glab");
    expect(execCalls[0].opts.env.GITLAB_TOKEN).toBe("glpat-fake");
  });

  it("falls back to the REST API with a timeout, and redacts API errors", async () => {
    mockExecFile(() => ({ error: Object.assign(new Error("Command failed: glab ..."), { code: 1, stderr: "401 token glpat-fake invalid" }) }));
    const fetchMock = vi.fn(async () => new Response("bad token glpat-fake", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createMergeRequest(input)).rejects.toThrow(/GitLab API returned 401: bad token \[REDACTED\]/);
    const [, init] = fetchMock.mock.calls[0] as any[];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers["PRIVATE-TOKEN"]).toBe("glpat-fake");
  });

  it("refuses option-like branch names before calling glab", async () => {
    mockExecFile();
    await expect(createMergeRequest({ ...input, branchName: "--mirror" })).rejects.toThrow(/Invalid branch name/);
    expect(execCalls).toHaveLength(0);
  });
});

describe("nxService", () => {
  it("runs lint/test without the bot's credentials and with a per-worktree cache", async () => {
    mockExecFile(() => ({ stdout: "ok" }));
    const res = await runNxChecks("/wt/1");
    expect(res.passed).toBe(true);
    expect(execCalls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["npx", "nx", "lint", "ecr-service"],
      ["npx", "nx", "test", "ecr-service", "--passWithNoTests"],
    ]);
    for (const c of execCalls) {
      for (const k of SECRET_KEYS) expect(c.opts.env[k]).toBeUndefined();
      expect(c.opts.env.NX_CACHE_DIRECTORY).toBe("/wt/1/.nx-cache");
      expect(c.opts.timeout).toBeGreaterThan(0);
      expect(c.opts.killSignal).toBe("SIGKILL");
    }
  });
});

describe("reviewerService", () => {
  it("spawns the review CLI without a shell or the bot's credentials", async () => {
    vi.mocked(spawn).mockReturnValue(fakeChild("No changes found to review"));
    const p = runReview("/wt/1", { title: "t", problem: "p", solution: "s" });
    // runReview does not write stdin; trigger the fake's completion manually
    const child = vi.mocked(spawn).mock.results[0].value;
    child.stdin.end("");
    const res = await p;
    expect(res.hasIssues).toBe(false);
    const [cmd, , opts] = vi.mocked(spawn).mock.calls[0] as any[];
    expect(cmd).toBe("review");
    expect(opts.shell).toBeFalsy();
    for (const k of SECRET_KEYS) expect(opts.env[k]).toBeUndefined();
  });
});

describe("gitService", () => {
  it("isWorktreePath is segment-aware", () => {
    expect(isWorktreePath("/tmp/fake-worktrees/abc")).toBe(true);
    expect(isWorktreePath("/tmp/fake-worktrees-evil/abc")).toBe(false);
    expect(isWorktreePath("/tmp/fake-worktrees")).toBe(false);
    expect(isWorktreePath("/tmp/fake-monorepo")).toBe(false);
  });

  it("commitAndPush unstages files in sibling directories that share an allowed prefix", async () => {
    mockExecFile(({ args }) => {
      const a = args.slice(args.indexOf("core.hooksPath=/dev/null") + 1);
      if (a[0] === "diff" && a.includes("--name-only")) {
        return { stdout: "apps/ecr/ok.ts\napps/ecr-evil/x.ts\nlibs/shared/a.ts\n" };
      }
      if (a[0] === "diff" && a.includes("--quiet")) return { error: new Error("exit 1") }; // has changes
      if (a[0] === "rev-parse") return { stdout: "abc123\n" };
      return { stdout: "" };
    });

    const hash = await commitAndPush("/tmp/fake-worktrees/t1", "fix/x", "Fix it", "bugfix");

    expect(hash).toBe("abc123");
    const gitArgs = execCalls.map((c) => c.args.slice(2)); // drop "-c core.hooksPath=/dev/null"
    expect(gitArgs).toContainEqual(["reset", "HEAD", "--", "apps/ecr-evil/x.ts"]);
    expect(gitArgs).not.toContainEqual(["reset", "HEAD", "--", "apps/ecr/ok.ts"]);
    expect(gitArgs).toContainEqual(["add", "--", "apps/ecr/"]);
    expect(gitArgs).toContainEqual(["push", "origin", "fix/x"]);
    expect(execCalls.every((c) => c.cmd === "git" && c.opts.timeout > 0)).toBe(true);
  });

  it("commitAndPush refuses option-like branch names", async () => {
    mockExecFile();
    await expect(commitAndPush("/tmp/fake-worktrees/t1", "--mirror", "t")).rejects.toThrow(/Invalid branch name/);
    expect(execCalls).toHaveLength(0);
  });

  it("cleanupOnFailure never passes an invalid branch name to `git branch -D`", async () => {
    mockExecFile();
    await cleanupOnFailure(null, "--force");
    expect(execCalls.some((c) => c.args.includes("branch"))).toBe(false);
    await cleanupOnFailure(null, "fix/ok");
    expect(execCalls.some((c) => c.args.join(" ") === "branch -D fix/ok")).toBe(true);
  });
});
