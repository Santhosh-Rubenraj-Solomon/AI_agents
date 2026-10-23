import { describe, expect, it, vi } from "vitest";
import { redactDeep, redactSecrets, scrubbedEnv } from "../src/utils/redact.js";
import { createLogger } from "../src/utils/logger.js";
import { createBroadcastSayFn, createSayFn } from "../src/types.js";
import { uploadMdToSlack } from "../src/utils/slackFileUpload.js";
import { createFakeApp } from "./helpers.js";

describe("redactSecrets", () => {
  it("removes the configured Slack / GitLab secrets wherever they appear", () => {
    const text = `bot=xoxb-test-token app=xapp-test-token sig=test-signing-secret gl=glpat-fake`;
    const out = redactSecrets(text);
    expect(out).not.toContain("xoxb-test-token");
    expect(out).not.toContain("xapp-test-token");
    expect(out).not.toContain("test-signing-secret");
    expect(out).not.toContain("glpat-fake");
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  it("removes token-shaped strings that are not our own", () => {
    expect(redactSecrets("token xoxp-1234-5678-abcdef here")).toBe("token [REDACTED] here");
    expect(redactSecrets("glpat-AbCdEf123456789_xyz")).toBe("[REDACTED]");
  });

  it("strips credentials embedded in URLs (e.g. git remote errors)", () => {
    const err = "fatal: unable to access 'https://oauth2:s3cr3tvalue@gitlab.example.com/grp/repo.git/'";
    const out = redactSecrets(err);
    expect(out).not.toContain("s3cr3tvalue");
    expect(out).toContain("https://[REDACTED]@gitlab.example.com/grp/repo.git/");
  });

  it("strips PRIVATE-TOKEN / Authorization header values", () => {
    expect(redactSecrets(`{"PRIVATE-TOKEN": "abc123def456"}`)).not.toContain("abc123def456");
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
  });

  it("leaves ordinary text alone", () => {
    const text = "Pushed fix/receipt to origin. See https://gitlab.example.com/mr/1";
    expect(redactSecrets(text)).toBe(text);
    expect(redactSecrets("")).toBe("");
  });
});

describe("redactDeep", () => {
  it("redacts strings nested in Slack payloads and keeps other values", () => {
    const payload = { text: "xoxb-test-token", blocks: [{ type: "section", text: { text: "glpat-fake" } }], n: 1, ok: true };
    expect(redactDeep(payload)).toEqual({
      text: "[REDACTED]",
      blocks: [{ type: "section", text: { text: "[REDACTED]" } }],
      n: 1,
      ok: true,
    });
  });
});

describe("scrubbedEnv", () => {
  it("drops the bot's credentials but keeps everything else", () => {
    const env = scrubbedEnv({ NX_CACHE_DIRECTORY: "/x" });
    for (const k of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET", "GITLAB_TOKEN"]) {
      expect(env[k]).toBeUndefined();
    }
    expect(env.MONOREPO_ROOT).toBe("/tmp/fake-monorepo");
    expect(env.NX_CACHE_DIRECTORY).toBe("/x");
    // process.env itself is untouched
    expect(process.env.GITLAB_TOKEN).toBe("glpat-fake");
  });
});

describe("secrets never reach logs or Slack", () => {
  it("logger output is redacted", () => {
    const prev = process.env.LOG_LEVEL;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("Test");
    log.error("push failed: https://u:xoxb-test-token@host/repo", { token: "glpat-fake" });
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).toContain("push failed");
    expect(line).not.toContain("xoxb-test-token");
    expect(line).not.toContain("glpat-fake");
    process.env.LOG_LEVEL = prev;
  });

  it("say functions redact text and blocks before posting", async () => {
    const { app, client } = createFakeApp();
    await createSayFn(app, "C", "1")(":x: Finalize failed: remote https://oauth2:glpat-fake@gitlab/x.git");
    await createBroadcastSayFn(app, "C", "1", "D", "2")({ text: "t", blocks: [{ text: "xoxb-test-token" }] });
    const posted = JSON.stringify(client.chat.postMessage.mock.calls);
    expect(posted).not.toContain("glpat-fake");
    expect(posted).not.toContain("xoxb-test-token");
    expect(client.chat.postMessage).toHaveBeenCalledTimes(3);
  });

  it("uploaded .md files are redacted", async () => {
    const { client } = createFakeApp();
    await uploadMdToSlack(client as any, "C", "1", "f.md", "review mentions glpat-fake", "xapp-test-token");
    expect(client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({ content: "review mentions [REDACTED]", initial_comment: "[REDACTED]" }),
    );
  });
});
