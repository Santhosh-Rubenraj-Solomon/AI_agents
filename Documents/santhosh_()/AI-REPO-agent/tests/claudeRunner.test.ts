/**
 * runWithStdin against a real child process (the current node binary), to
 * prove the no-shell / stdin / timeout / env-scrubbing behaviour end to end.
 */
import { describe, expect, it } from "vitest";
import { runWithStdin } from "../src/services/claudeAgent.js";

const node = process.execPath;
const opts = { cwd: process.cwd(), timeout: 10_000 };

describe("runWithStdin (real process)", () => {
  it("delivers the input verbatim on stdin — shell metacharacters are inert", async () => {
    const input = `"; rm -rf / #\n$(whoami) \`id\` $HOME 'quoted'`;
    const out = await runWithStdin(node, ["-e", "process.stdin.pipe(process.stdout)"], input, opts);
    expect(out).toBe(input);
  });

  it("does not expose the bot's credentials to the child by default", async () => {
    const out = await runWithStdin(
      node,
      ["-e", "process.stdout.write(JSON.stringify([process.env.GITLAB_TOKEN, process.env.SLACK_BOT_TOKEN, process.env.MONOREPO_ROOT]))"],
      "",
      opts,
    );
    expect(JSON.parse(out)).toEqual([null, null, "/tmp/fake-monorepo"]);
  });

  it("kills the child and rejects on timeout", async () => {
    const started = Date.now();
    await expect(
      runWithStdin(node, ["-e", "setTimeout(() => {}, 60_000)"], "", { ...opts, timeout: 300 }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("rejects with the exit code and stderr tail on failure", async () => {
    await expect(
      runWithStdin(node, ["-e", "console.error('boom'); process.exit(3)"], "", opts),
    ).rejects.toThrow(/exited with code 3: boom/);
  });

  it("rejects when the command does not exist", async () => {
    await expect(runWithStdin("definitely-not-a-real-binary-xyz", [], "", opts)).rejects.toThrow(/Failed to spawn/);
  });

  it("rejects when output exceeds maxBuffer", async () => {
    await expect(
      runWithStdin(node, ["-e", "process.stdout.write('x'.repeat(5000))"], "", { ...opts, maxBuffer: 100 }),
    ).rejects.toThrow(/exceeded 100 bytes/);
  });
});
