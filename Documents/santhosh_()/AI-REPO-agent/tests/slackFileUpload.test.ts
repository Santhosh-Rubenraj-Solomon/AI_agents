import { describe, expect, it, vi } from "vitest";
import { uploadMdToSlack } from "../src/utils/slackFileUpload.js";

describe("uploadMdToSlack", () => {
  it("uploads via files.uploadV2 into the thread", async () => {
    const client = { files: { uploadV2: vi.fn(async () => ({ ok: true })) } } as any;
    await uploadMdToSlack(client, "C1", "1.2", "plan.md", "# Plan", "Here you go");
    expect(client.files.uploadV2).toHaveBeenCalledWith({
      channel_id: "C1",
      thread_ts: "1.2",
      filename: "plan.md",
      content: "# Plan",
      initial_comment: "Here you go",
    });
  });

  it("defaults the initial comment to the filename", async () => {
    const client = { files: { uploadV2: vi.fn(async () => ({ ok: true })) } } as any;
    await uploadMdToSlack(client, "C1", "1.2", "x.md", "");
    expect(client.files.uploadV2.mock.calls[0][0].initial_comment).toBe("Attached: x.md");
  });

  it("wraps API errors with the filename", async () => {
    const client = { files: { uploadV2: vi.fn(async () => Promise.reject(new Error("not_in_channel"))) } } as any;
    await expect(uploadMdToSlack(client, "C1", "1.2", "x.md", "c")).rejects.toThrow(
      "Slack file upload failed for x.md: not_in_channel",
    );
  });
});
