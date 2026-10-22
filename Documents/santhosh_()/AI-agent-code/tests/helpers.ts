import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { Telegraf } from "telegraf";
import type { AnalysisResult, TechProfile } from "../src/schemas.js";
import type { SessionRow } from "../src/state/store.js";

/** Create a temp directory tree from a { "rel/path": content } map. */
export function makeTree(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-agent-fixture-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

export function rmTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function makeProfile(overrides: Partial<TechProfile> = {}): TechProfile {
  return {
    languages: [{ name: "TypeScript", percentage: 100, fileCount: 3 }],
    frameworks: ["Express"],
    buildTools: ["TypeScript Compiler"],
    databases: ["PostgreSQL"],
    architecture: "Layered (Routes + Middleware)",
    packageManager: "npm",
    testFrameworks: ["Vitest"],
    linters: ["ESLint"],
    ciCd: ["GitHub Actions"],
    entryPoints: ["src/index.ts"],
    totalFiles: 3,
    totalLinesEstimate: 120,
    dependencies: { express: "^4" },
    devDependencies: {},
    ...overrides,
  };
}

export function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    summary: "An HTTP API",
    architecture: "Routes call services",
    keyComponents: [{ name: "UserService", path: "src/user.ts", purpose: "users", type: "service" }],
    dataModels: [{ name: "User", path: "src/user.ts", fields: ["id: string"], relationships: [] }],
    apiEndpoints: [{ method: "GET", path: "/users", handler: "UserController.list", description: "list users" }],
    concerns: ["no tests"],
    strengths: ["typed"],
    ...overrides,
  };
}

let sid = 0;
export function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  sid += 1;
  const now = Date.now();
  return {
    session_id: `sess${sid}`,
    chat_id: 1,
    user_id: 10,
    repo_url: "https://github.com/acme/api",
    repo_local_path: "/tmp/repos/acme/api",
    current_phase: "idle",
    task_type: null,
    profile_json: JSON.stringify(makeProfile()),
    analysis_json: JSON.stringify(makeAnalysis()),
    conversation_history: "[]",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

type Handler = (ctx: any) => unknown;

/** Fake Telegraf bot capturing registered handlers. */
export function createFakeBot() {
  const commands = new Map<string, Handler>();
  const on = new Map<string, Handler>();
  let startFn: Handler | undefined;
  let helpFn: Handler | undefined;
  const bot = {
    start: (fn: Handler) => (startFn = fn),
    help: (fn: Handler) => (helpFn = fn),
    command: (name: string, fn: Handler) => commands.set(name, fn),
    on: (ev: string, fn: Handler) => on.set(ev, fn),
  };
  return {
    bot: bot as unknown as Telegraf,
    command: (n: string) => {
      const fn = commands.get(n);
      if (!fn) throw new Error(`no command ${n}`);
      return fn;
    },
    commandNames: () => [...commands.keys()],
    start: () => startFn!,
    help: () => helpFn!,
    on: (ev: string) => on.get(ev)!,
  };
}

export function makeCtx(text = "", opts: { chatId?: number; userId?: number; noChat?: boolean } = {}) {
  return {
    from: { id: opts.userId ?? 10 },
    chat: opts.noChat ? undefined : { id: opts.chatId ?? 1 },
    message: { text },
    reply: vi.fn(async (_text: string, _extra?: unknown) => ({})),
    sendChatAction: vi.fn(async () => true),
  };
}

export const replies = (ctx: ReturnType<typeof makeCtx>) => ctx.reply.mock.calls.map((c) => c[0] as string);
