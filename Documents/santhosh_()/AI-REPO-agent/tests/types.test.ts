import { describe, expect, it } from "vitest";
import { createBroadcastSayFn, createSayFn } from "../src/types.js";
import { createFakeApp } from "./helpers.js";

describe("createSayFn", () => {
  it("posts strings and objects into the stored thread", async () => {
    const { app, client } = createFakeApp();
    const say = createSayFn(app, "C1", "1.1");
    await say("hello");
    await say({ text: "t", blocks: [{ type: "divider" }] });
    expect(client.chat.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { channel: "C1", thread_ts: "1.1", text: "hello" },
      { channel: "C1", thread_ts: "1.1", text: "t", blocks: [{ type: "divider" }] },
    ]);
  });
});

describe("createBroadcastSayFn", () => {
  it("posts only to the admin thread when requester coordinates are null", async () => {
    const { app, client } = createFakeApp();
    await createBroadcastSayFn(app, "CA", "1.1", null, null)("hi");
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("requires both requester channel and thread to mirror", async () => {
    const { app, client } = createFakeApp();
    await createBroadcastSayFn(app, "CA", "1.1", "DR", null)("hi");
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("mirrors to the requester DM thread", async () => {
    const { app, client } = createFakeApp();
    await createBroadcastSayFn(app, "CA", "1.1", "DR", "2.2")({ text: "x" });
    expect(client.chat.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { channel: "CA", thread_ts: "1.1", text: "x" },
      { channel: "DR", thread_ts: "2.2", text: "x" },
    ]);
  });

  it("swallows requester failures but propagates admin failures", async () => {
    const { app, client } = createFakeApp();
    client.chat.postMessage
      .mockResolvedValueOnce({ ok: true, ts: "1" })
      .mockRejectedValueOnce(new Error("requester DM closed"));
    await expect(createBroadcastSayFn(app, "CA", "1.1", "DR", "2.2")("x")).resolves.toBeUndefined();

    client.chat.postMessage.mockRejectedValueOnce(new Error("admin failed"));
    await expect(createBroadcastSayFn(app, "CA", "1.1", "DR", "2.2")("x")).rejects.toThrow("admin failed");
  });
});
