import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "../src/config.js";
import {
  closeDb,
  createSession,
  deleteSession,
  getDb,
  getSession,
  getSessionById,
  listSessions,
  updateSession,
} from "../src/state/store.js";
import { makeSessionRow } from "./helpers.js";

beforeEach(() => {
  getDb().exec("DELETE FROM sessions");
  vi.useRealTimers();
});
afterAll(() => closeDb());

describe("getDb", () => {
  it("creates the DB file (and parent dir) with the sessions table and index", () => {
    expect(fs.existsSync(CONFIG.paths.db)).toBe(true);
    expect(path.basename(CONFIG.paths.db)).toBe("test.db");
    const db = getDb();
    expect(getDb()).toBe(db);
    const idx = db.prepare("PRAGMA index_list(sessions)").all() as { name: string }[];
    expect(idx.map((i) => i.name)).toContain("idx_sessions_chat_id");
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("closeDb then getDb reopens the same persisted data", () => {
    const row = makeSessionRow();
    createSession(row);
    closeDb();
    expect(getSessionById(row.session_id)).toEqual(row);
  });
});

describe("session CRUD", () => {
  it("round-trips a session", () => {
    const row = makeSessionRow({ task_type: "bugfix", conversation_history: '[{"role":"user","content":"hi"}]' });
    createSession(row);
    expect(getSessionById(row.session_id)).toEqual(row);
    expect(getSession(row.chat_id)).toEqual(row);
  });

  it("returns a falsy value for unknown ids/chats", () => {
    expect(getSession(999)).toBeFalsy();
    expect(getSessionById("nope")).toBeFalsy();
  });

  it("getSession returns the most recently updated session for the chat", () => {
    createSession(makeSessionRow({ session_id: "old", chat_id: 5, updated_at: 100 }));
    createSession(makeSessionRow({ session_id: "new", chat_id: 5, updated_at: 200 }));
    createSession(makeSessionRow({ session_id: "other", chat_id: 6, updated_at: 300 }));
    expect(getSession(5)?.session_id).toBe("new");
  });

  it("updateSession merges partial fields and bumps updated_at", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const row = makeSessionRow({ updated_at: 1, created_at: 1 });
    createSession(row);
    updateSession({ session_id: row.session_id, current_phase: "awaiting_input", task_type: "feature", analysis_json: null });
    const after = getSessionById(row.session_id)!;
    expect(after).toEqual({
      ...row,
      current_phase: "awaiting_input",
      task_type: "feature",
      analysis_json: null,
      updated_at: 5_000,
    });
  });

  it("updateSession does not change immutable columns (chat_id, user_id, created_at)", () => {
    const row = makeSessionRow();
    createSession(row);
    updateSession({ session_id: row.session_id, chat_id: 777, user_id: 888, created_at: 0 });
    expect(getSessionById(row.session_id)).toMatchObject({ chat_id: row.chat_id, user_id: row.user_id, created_at: row.created_at });
  });

  it("updateSession is a no-op for unknown sessions", () => {
    updateSession({ session_id: "ghost", current_phase: "failed" });
    expect(getSessionById("ghost")).toBeFalsy();
  });

  it("deleteSession removes the row", () => {
    const row = makeSessionRow();
    createSession(row);
    deleteSession(row.session_id);
    expect(getSessionById(row.session_id)).toBeFalsy();
  });

  it("listSessions returns at most 20, newest first", () => {
    for (let i = 0; i < 25; i++) createSession(makeSessionRow({ session_id: `s${i}`, updated_at: i }));
    const list = listSessions();
    expect(list).toHaveLength(20);
    expect(list[0].session_id).toBe("s24");
    expect(list.at(-1)?.session_id).toBe("s5");
  });
});
