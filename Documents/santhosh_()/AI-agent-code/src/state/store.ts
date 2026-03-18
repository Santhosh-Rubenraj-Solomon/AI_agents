/**
 * state/store.ts — SQLite-backed session persistence.
 *
 * Each Telegram chat gets its own session. Sessions track:
 * - Which repo is being analyzed
 * - Current phase in the pipeline
 * - Cached tech profile and analysis results
 * - Conversation history for context
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Store");
let db: Database.Database | null = null;

// ─── Initialize ──────────────────────────────────────────────────────────────

export function getDb(): Database.Database {
  if (db) return db;

  const dbDir = path.dirname(CONFIG.paths.db);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(CONFIG.paths.db);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      repo_url TEXT,
      repo_local_path TEXT,
      current_phase TEXT NOT NULL DEFAULT 'idle',
      task_type TEXT,
      profile_json TEXT,
      analysis_json TEXT,
      conversation_history TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_chat_id ON sessions(chat_id);
  `);

  log.info("SQLite initialized", { path: CONFIG.paths.db });
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── Session CRUD ────────────────────────────────────────────────────────────

export interface SessionRow {
  session_id: string;
  chat_id: number;
  user_id: number;
  repo_url: string | null;
  repo_local_path: string | null;
  current_phase: string;
  task_type: string | null;
  profile_json: string | null;
  analysis_json: string | null;
  conversation_history: string;
  created_at: number;
  updated_at: number;
}

export function getSession(chatId: number): SessionRow | null {
  const d = getDb();
  return d.prepare("SELECT * FROM sessions WHERE chat_id = ? ORDER BY updated_at DESC LIMIT 1").get(chatId) as SessionRow | null;
}

export function getSessionById(sessionId: string): SessionRow | null {
  const d = getDb();
  return d.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as SessionRow | null;
}

export function createSession(session: SessionRow): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO sessions (session_id, chat_id, user_id, repo_url, repo_local_path, current_phase, task_type, profile_json, analysis_json, conversation_history, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.session_id,
    session.chat_id,
    session.user_id,
    session.repo_url,
    session.repo_local_path,
    session.current_phase,
    session.task_type,
    session.profile_json,
    session.analysis_json,
    session.conversation_history,
    session.created_at,
    session.updated_at,
  );
}

export function updateSession(session: Partial<SessionRow> & { session_id: string }): void {
  const d = getDb();
  const existing = getSessionById(session.session_id);
  if (!existing) return;

  const merged = { ...existing, ...session, updated_at: Date.now() };
  d.prepare(`
    UPDATE sessions SET
      repo_url = ?, repo_local_path = ?, current_phase = ?, task_type = ?,
      profile_json = ?, analysis_json = ?, conversation_history = ?, updated_at = ?
    WHERE session_id = ?
  `).run(
    merged.repo_url,
    merged.repo_local_path,
    merged.current_phase,
    merged.task_type,
    merged.profile_json,
    merged.analysis_json,
    merged.conversation_history,
    merged.updated_at,
    merged.session_id,
  );
}

export function deleteSession(sessionId: string): void {
  const d = getDb();
  d.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
}

export function listSessions(): SessionRow[] {
  const d = getDb();
  return d.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 20").all() as SessionRow[];
}
