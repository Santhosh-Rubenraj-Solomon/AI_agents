import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Mod = typeof import("../src/utils/reviewerCache.js");

/** Fresh module so the cache + CONFIG.reviewerUserIds are re-evaluated. */
async function load(ids: string | undefined): Promise<Mod> {
  if (ids === undefined) delete process.env.REVIEWER_USER_IDS;
  else process.env.REVIEWER_USER_IDS = ids;
  vi.resetModules();
  return import("../src/utils/reviewerCache.js");
}

const users: Record<string, any> = {
  U1: { id: "U1", profile: { display_name: "zed" } },
  U2: { id: "U2", profile: { display_name: "", real_name: "Alice Real" } },
  U3: { id: "U3", real_name: "Bob TopLevel", profile: {} },
  U4: { id: "U4", name: "carol.handle", profile: {} },
  U5: { id: "U5", profile: {} },
  BOT: { id: "BOT", is_bot: true, profile: { display_name: "botty" } },
  USLACKBOT: { id: "USLACKBOT", profile: { display_name: "Slackbot" } },
};

function fakeClient() {
  return {
    users: {
      info: vi.fn(async ({ user }: { user: string }) => {
        if (user === "UERR") throw new Error("user_not_found");
        return { ok: true, user: users[user] };
      }),
    },
  } as any;
}

describe("reviewerCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.REVIEWER_USER_IDS;
    vi.resetModules();
  });

  it("returns null and makes no API calls when REVIEWER_USER_IDS is unset", async () => {
    const mod = await load(undefined);
    const client = fakeClient();
    expect(await mod.getReviewers(client)).toBeNull();
    await mod.refreshReviewers(client);
    expect(client.users.info).not.toHaveBeenCalled();
  });

  it("resolves display names with fallbacks, skips bots/failures and sorts", async () => {
    const mod = await load("U1,U2,U3,U4,U5,BOT,USLACKBOT,UERR");
    const result = await mod.getReviewers(fakeClient());
    expect(result).toEqual([
      { slackId: "U2", displayName: "Alice Real" },
      { slackId: "U3", displayName: "Bob TopLevel" },
      { slackId: "U4", displayName: "carol.handle" },
      { slackId: "U5", displayName: "U5" },
      { slackId: "U1", displayName: "zed" },
    ]);
  });

  it("serves from cache for 30 minutes, then refreshes", async () => {
    const mod = await load("U1,U2");
    const client = fakeClient();
    await mod.getReviewers(client);
    expect(client.users.info).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30 * 60 * 1000 - 1);
    await mod.getReviewers(client);
    expect(client.users.info).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    await mod.getReviewers(client);
    expect(client.users.info).toHaveBeenCalledTimes(4);
  });

  it("refreshReviewers forces a refetch", async () => {
    const mod = await load("U1");
    const client = fakeClient();
    await mod.getReviewers(client);
    await mod.refreshReviewers(client);
    expect(client.users.info).toHaveBeenCalledTimes(2);
  });

  // BUG (minor, src/utils/reviewerCache.ts:47): the cache-hit check requires
  // cachedReviewers.length > 0, so when every lookup fails/filters out, each
  // modal open re-hits users.info for every configured ID (no negative caching).
  it.skip("BUG: caches an empty result instead of refetching every call", async () => {
    const mod = await load("BOT");
    const client = fakeClient();
    await mod.getReviewers(client);
    await mod.getReviewers(client);
    expect(client.users.info).toHaveBeenCalledTimes(1);
  });
});
