import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGitLabReviewers } from "../src/utils/userMapping.js";

type Route = (url: URL) => { ok: boolean; status?: number; body?: unknown } | Error;

function stubFetch(route: Route) {
  const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
    const res = route(new URL(input));
    if (res instanceof Error) throw res;
    return {
      ok: res.ok,
      status: res.status ?? (res.ok ? 200 : 500),
      json: async () => res.body,
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function slackClient(emails: Record<string, string | undefined | Error>) {
  return {
    users: {
      info: vi.fn(async ({ user }: { user: string }) => {
        const e = emails[user];
        if (e instanceof Error) throw e;
        return { ok: true, user: { id: user, profile: { email: e } } };
      }),
    },
  } as any;
}

describe("resolveGitLabReviewers", () => {
  beforeEach(() => {
    delete process.env.SLACK_TO_GITLAB_MAP;
  });
  afterEach(() => {
    delete process.env.SLACK_TO_GITLAB_MAP;
  });

  it("returns [] for no users without any network calls", async () => {
    const f = stubFetch(() => ({ ok: true, body: [] }));
    const client = slackClient({});
    expect(await resolveGitLabReviewers(client, [])).toEqual([]);
    expect(f).not.toHaveBeenCalled();
    expect(client.users.info).not.toHaveBeenCalled();
  });

  it("uses explicit SLACK_TO_GITLAB_MAP username mappings first", async () => {
    process.env.SLACK_TO_GITLAB_MAP = " U1:alice.gl , U2:bob ";
    const f = stubFetch((url) => {
      expect(url.origin).toBe("https://gitlab.example.test");
      expect(url.pathname).toBe("/api/v4/users");
      const username = url.searchParams.get("username");
      return { ok: true, body: username === "alice.gl" ? [{ id: 11, username }] : [{ id: 22, username }] };
    });
    const client = slackClient({});
    expect(await resolveGitLabReviewers(client, ["U1", "U2"])).toEqual([11, 22]);
    expect(client.users.info).not.toHaveBeenCalled();
    expect(f.mock.calls[0][1]).toMatchObject({ headers: { "PRIVATE-TOKEN": "glpat-fake" } });
  });

  it("falls back to email lookup when the mapped username is unknown", async () => {
    process.env.SLACK_TO_GITLAB_MAP = "U1:ghost";
    stubFetch((url) => {
      if (url.searchParams.get("username") === "ghost") return { ok: true, body: [] };
      expect(url.searchParams.get("search")).toBe("Alice@Example.com");
      return { ok: true, body: [{ id: 5, email: "someone@else.com" }, { id: 7, email: "alice@example.com" }] };
    });
    expect(await resolveGitLabReviewers(slackClient({ U1: "Alice@Example.com" }), ["U1"])).toEqual([7]);
  });

  it("drops users when the fuzzy email search has no exact match", async () => {
    stubFetch(() => ({ ok: true, body: [{ id: 1, email: "alice.smith@example.com" }, { id: 2 }] }));
    expect(await resolveGitLabReviewers(slackClient({ U1: "alice@example.com" }), ["U1"])).toEqual([]);
  });

  it("drops users with no Slack email or failing Slack lookups", async () => {
    const f = stubFetch(() => ({ ok: true, body: [] }));
    const client = slackClient({ U1: undefined, U2: new Error("ratelimited") });
    expect(await resolveGitLabReviewers(client, ["U1", "U2"])).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("treats non-OK GitLab responses and network errors as unresolved", async () => {
    process.env.SLACK_TO_GITLAB_MAP = "U1:alice,U2:bob";
    stubFetch((url) => {
      const u = url.searchParams.get("username");
      if (u === "alice") return { ok: false, status: 401 };
      if (u === "bob") return new Error("ECONNRESET");
      return { ok: false, status: 500 };
    });
    expect(await resolveGitLabReviewers(slackClient({ U1: "a@x.com", U2: "b@x.com" }), ["U1", "U2"])).toEqual([]);
  });

  it("ignores malformed mapping entries and keeps resolved order", async () => {
    process.env.SLACK_TO_GITLAB_MAP = "BADENTRY,U9:,:nouser,U2:bob";
    stubFetch((url) => {
      if (url.searchParams.get("username") === "bob") return { ok: true, body: [{ id: 2 }] };
      const email = url.searchParams.get("search");
      return { ok: true, body: email ? [{ id: 100, email }] : [] };
    });
    const client = slackClient({ U1: "one@x.com", U3: undefined });
    expect(await resolveGitLabReviewers(client, ["U1", "U2", "U3"])).toEqual([100, 2]);
  });
});
