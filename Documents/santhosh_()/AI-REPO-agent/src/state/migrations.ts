/**
 * state/migrations.ts — SQLite schema creation.
 *
 * Called once at startup. Uses IF NOT EXISTS so it is safe to run
 * on every boot without data loss.
 */

import Database from "better-sqlite3";

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id       TEXT PRIMARY KEY,
      state_json    TEXT NOT NULL,
      phase         TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      channel_id    TEXT NOT NULL,
      thread_ts     TEXT NOT NULL,
      worktree_path TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_phase
      ON tasks (phase);

    CREATE INDEX IF NOT EXISTS idx_tasks_user_id
      ON tasks (user_id);

    CREATE INDEX IF NOT EXISTS idx_tasks_updated_at
      ON tasks (updated_at);

    -- Non-admin requests awaiting the admin's approve/reject decision.
    -- The full (validated) request lives here; the Slack button only
    -- carries request_id (Slack caps button values at 2000 chars).
    CREATE TABLE IF NOT EXISTS pending_requests (
      request_id    TEXT PRIMARY KEY,
      payload_json  TEXT NOT NULL,
      requester_id  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pending_requests_status_updated
      ON pending_requests (status, updated_at);
  `);
}
