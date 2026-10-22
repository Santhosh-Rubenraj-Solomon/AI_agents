import { vi } from "vitest";
import type { App } from "@slack/bolt";
import type { PipelineState, TaskAnalysis } from "../src/types.js";

export function makeAnalysis(overrides: Partial<TaskAnalysis> = {}): TaskAnalysis {
  return {
    reasoning: "Because the receipt is reprinted twice",
    approach: ["Find the bug", "Fix the bug"],
    filesToChange: ["apps/ecr/src/receipt.service.ts"],
    filesToCreate: [],
    affectedServices: ["ecr-service"],
    proposedChanges: "Guard against double print",
    estimatedComplexity: "low",
    branchName: "fix/receipt-reprint",
    risks: [],
    needsLibChanges: false,
    ...overrides,
  };
}

let counter = 0;

export function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  counter += 1;
  const now = Date.now();
  const { request, ...rest } = overrides;
  return {
    taskId: `task${counter}`,
    request: {
      type: "bugfix",
      title: "Fix receipt reprint",
      priority: "medium",
      description: "Problem: double print\n\nProposed Solution: guard",
      problemDescription: "double print",
      proposedSolution: "guard",
      userId: "UADMIN",
      channelId: "DADMIN",
      threadTs: "111.222",
      ...(request ?? {}),
    },
    requesterId: null,
    requesterChannelId: null,
    requesterThreadTs: null,
    reviewerGitLabIds: null,
    analysis: null,
    branchName: null,
    worktreePath: null,
    commitHash: null,
    reviewIterations: [],
    currentPhase: "analyzing",
    mrUrl: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}

type Handler = (args: any) => Promise<unknown> | unknown;

/** A fake Bolt App that records registered handlers and stubs the Web API client. */
export function createFakeApp() {
  const commands = new Map<string, Handler>();
  const views = new Map<string, Handler>();
  const events = new Map<string, Handler>();
  const actions: Array<{ id: string | RegExp; fn: Handler }> = [];

  let tsCounter = 0;
  const client = {
    chat: {
      postMessage: vi.fn(async (_args: any) => ({ ok: true, ts: `9000.${++tsCounter}` })),
      postEphemeral: vi.fn(async (_args: any) => ({ ok: true })),
    },
    conversations: {
      open: vi.fn(async ({ users }: { users: string }) => ({ ok: true, channel: { id: `D_${users}` } })),
    },
    files: { uploadV2: vi.fn(async (_args: any) => ({ ok: true })) },
    views: {
      open: vi.fn(async (_args: any) => ({ ok: true })),
      publish: vi.fn(async (_args: any) => ({ ok: true })),
    },
    users: { info: vi.fn(async (_args: any) => ({ ok: true, user: undefined as any })) },
  };

  const app = {
    client,
    command: (name: string, fn: Handler) => commands.set(name, fn),
    view: (id: string, fn: Handler) => views.set(id, fn),
    event: (name: string, fn: Handler) => events.set(name, fn),
    action: (id: string | RegExp, fn: Handler) => actions.push({ id, fn }),
  };

  function getAction(actionId: string): Handler {
    const found = actions.find((a) => (typeof a.id === "string" ? a.id === actionId : a.id.test(actionId)));
    if (!found) throw new Error(`No action handler for ${actionId}`);
    return found.fn;
  }

  function get(map: Map<string, Handler>, key: string): Handler {
    const fn = map.get(key);
    if (!fn) throw new Error(`No handler registered for ${key}`);
    return fn;
  }

  return {
    app: app as unknown as App,
    client,
    getCommand: (n: string) => get(commands, n),
    getView: (n: string) => get(views, n),
    getEvent: (n: string) => get(events, n),
    getAction,
  };
}

/** Collect every text posted via chat.postMessage (including block text). */
export function postedTexts(client: ReturnType<typeof createFakeApp>["client"]): string[] {
  return client.chat.postMessage.mock.calls.map(([a]: any[]) => JSON.stringify(a));
}

/** Let fire-and-forget promises settle. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}
