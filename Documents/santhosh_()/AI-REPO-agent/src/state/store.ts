/**
 * state/store.ts — SQLite persistence layer for pipeline state.
 *
 * No in-memory maps. All state lives in SQLite. The orchestrator
 * reads/writes through this module, making it crash-safe and
 * recoverable on restart.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { CONFIG } from "../config.js";
import { runMigrations } from "./migrations.js";
import { PipelineStateSchema } from "../schemas.js";
import type { PipelineState, PipelinePhase } from "../types.js";

// ─── Database singleton ───────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    // Ensure the data directory exists
    const dir = path.dirname(CONFIG.db.path);
    fs.mkdirSync(dir, { recursive: true });

    _db = new Database(CONFIG.db.path);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    runMigrations(_db);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ─── Prepared statements (lazy) ───────────────────────────────────────────────

function stmts() {
  const db = getDb();
  return {
    insert: db.prepare(`
      INSERT INTO tasks (task_id, state_json, phase, user_id, channel_id, thread_ts, worktree_path, created_at, updated_at)
      VALUES (@taskId, @stateJson, @phase, @userId, @channelId, @threadTs, @worktreePath, @createdAt, @updatedAt)
    `),
    update: db.prepare(`
      UPDATE tasks
      SET state_json = @stateJson,
          phase = @phase,
          worktree_path = @worktreePath,
          updated_at = @updatedAt
      WHERE task_id = @taskId
    `),
    getById: db.prepare(`SELECT state_json FROM tasks WHERE task_id = ?`),
    getByPhase: db.prepare(`SELECT state_json FROM tasks WHERE phase = ?`),
    getByPhases: db.prepare(`SELECT state_json FROM tasks WHERE phase IN (SELECT value FROM json_each(?))`),
    delete: db.prepare(`DELETE FROM tasks WHERE task_id = ?`),
    getAllActive: db.prepare(`
      SELECT state_json FROM tasks
      WHERE phase NOT IN ('complete', 'failed', 'cancelled')
    `),
    getStale: db.prepare(`
      SELECT state_json FROM tasks
      WHERE phase IN ('awaiting_plan_approval')
        AND updated_at < ?
    `),
    getTerminalOld: db.prepare(`
      SELECT task_id FROM tasks
      WHERE phase IN ('complete', 'failed', 'cancelled')
        AND updated_at < ?
    `),
    markPhase: db.prepare(`
      UPDATE tasks SET phase = @phase, updated_at = @updatedAt WHERE task_id = @taskId
    `),
  };
}

// ─── CRUD operations ──────────────────────────────────────────────────────────

/**
 * Persist a new pipeline state.
 */
export function createTask(state: PipelineState): void {
  const s = stmts();
  s.insert.run({
    taskId: state.taskId,
    stateJson: JSON.stringify(state),
    phase: state.currentPhase,
    userId: state.request.userId,
    channelId: state.request.channelId,
    threadTs: state.request.threadTs,
    worktreePath: state.worktreePath,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  });
}

/**
 * Update an existing pipeline state.
 */
export function updateTask(state: PipelineState): void {
  const now = Date.now();
  state.updatedAt = now;
  const s = stmts();
  s.update.run({
    taskId: state.taskId,
    stateJson: JSON.stringify(state),
    phase: state.currentPhase,
    worktreePath: state.worktreePath,
    updatedAt: now,
  });
}

/**
 * Load a single task by ID. Returns null if not found.
 */
export function getTask(taskId: string): PipelineState | null {
  const s = stmts();
  const row = s.getById.get(taskId) as { state_json: string } | undefined;
  if (!row) return null;
  return PipelineStateSchema.parse(JSON.parse(row.state_json));
}

/**
 * Delete a task by ID.
 */
export function deleteTask(taskId: string): void {
  const s = stmts();
  s.delete.run(taskId);
}

/**
 * Get all tasks in a specific phase.
 */
export function getTasksByPhase(phase: PipelinePhase): PipelineState[] {
  const s = stmts();
  const rows = s.getByPhase.all(phase) as { state_json: string }[];
  return rows.map((r) => PipelineStateSchema.parse(JSON.parse(r.state_json)));
}

/**
 * Get all non-terminal tasks (anything not complete/failed/cancelled).
 */
export function getActiveTasks(): PipelineState[] {
  const s = stmts();
  const rows = s.getAllActive.all() as { state_json: string }[];
  return rows.map((r) => PipelineStateSchema.parse(JSON.parse(r.state_json)));
}

/**
 * Get tasks that have been in an awaiting_* phase too long.
 */
export function getStaleTasks(maxAgeMs: number): PipelineState[] {
  const cutoff = Date.now() - maxAgeMs;
  const s = stmts();
  const rows = s.getStale.all(cutoff) as { state_json: string }[];
  return rows.map((r) => PipelineStateSchema.parse(JSON.parse(r.state_json)));
}

/**
 * Get IDs of terminal tasks older than the given age.
 */
export function getOldTerminalTaskIds(maxAgeMs: number): string[] {
  const cutoff = Date.now() - maxAgeMs;
  const s = stmts();
  const rows = s.getTerminalOld.all(cutoff) as { task_id: string }[];
  return rows.map((r) => r.task_id);
}

/**
 * Mark in-flight tasks as failed on startup recovery.
 * Tasks in executing/reviewing/fixing/creating_mr phases are
 * not safe to resume — mark them failed.
 *
 * Returns an array of { taskId, phase } for tasks that were marked failed,
 * so the caller can log them and suggest `/ecr-resume`.
 */
export function markInFlightTasksFailed(): { taskId: string; phase: string; worktreePath: string | null }[] {
  const db = getDb();
  const inFlightPhases = ["analyzing", "executing", "reviewing", "fixing", "creating_mr"];
  const now = Date.now();
  const marked: { taskId: string; phase: string; worktreePath: string | null }[] = [];

  for (const phase of inFlightPhases) {
    const rows = stmts().getByPhase.all(phase) as { state_json: string }[];
    for (const row of rows) {
      const state = JSON.parse(row.state_json) as PipelineState;
      const originalPhase = state.currentPhase;
      const worktreePath = state.worktreePath;
      state.currentPhase = "failed";
      state.updatedAt = now;
      stmts().update.run({
        taskId: state.taskId,
        stateJson: JSON.stringify(state),
        phase: "failed",
        worktreePath: state.worktreePath,
        updatedAt: now,
      });
      marked.push({ taskId: state.taskId, phase: originalPhase, worktreePath });
    }
  }

  return marked;
}

/**
 * Get a task by ID without Zod validation.
 *
 * This is needed for tasks that may have legacy/unknown phases (e.g.
 * "awaiting_review_approval" which no longer exists in the schema).
 * Returns the raw parsed JSON or null if not found.
 */
export function getTaskRaw(taskId: string): (Record<string, any> & { taskId: string; currentPhase: string; worktreePath: string | null }) | null {
  const s = stmts();
  const row = s.getById.get(taskId) as { state_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.state_json);
}

/**
 * Get all tasks that are potentially resumable.
 *
 * Returns tasks in non-terminal phases (including legacy phases like
 * "awaiting_review_approval") plus tasks in "failed" phase that still
 * have a worktree.
 *
 * Uses raw JSON parsing to avoid Zod rejecting legacy phases.
 */
export function getResumableTasks(): Array<{ taskId: string; phase: string; title: string; worktreePath: string | null; updatedAt: number; reviewIterations: unknown[] }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT state_json, phase, worktree_path FROM tasks
    WHERE phase NOT IN ('complete', 'cancelled')
    ORDER BY updated_at DESC
  `).all() as { state_json: string; phase: string; worktree_path: string | null }[];

  return rows.map((row) => {
    const state = JSON.parse(row.state_json);
    return {
      taskId: state.taskId,
      phase: state.currentPhase ?? row.phase,
      title: state.request?.title ?? "Unknown",
      worktreePath: state.worktreePath ?? row.worktree_path,
      updatedAt: state.updatedAt ?? 0,
      reviewIterations: state.reviewIterations ?? [],
    };
  });
}

/**
 * Force-update the phase of a task in the DB.
 *
 * Works with raw state_json — does not require Zod validation.
 * Used by the resume handler to fix legacy phases before re-entering
 * the normal pipeline flow.
 */
export function forceUpdatePhase(taskId: string, newPhase: PipelinePhase): void {
  const row = stmts().getById.get(taskId) as { state_json: string } | undefined;
  if (!row) return;

  const state = JSON.parse(row.state_json);
  state.currentPhase = newPhase;
  state.updatedAt = Date.now();

  stmts().update.run({
    taskId,
    stateJson: JSON.stringify(state),
    phase: newPhase,
    worktreePath: state.worktreePath ?? null,
    updatedAt: state.updatedAt,
  });
}

/**
 * Atomically move a task from one phase to another.
 *
 * The UPDATE only matches when the task is currently in `from`, so two
 * concurrent callers (e.g. a double-clicked "Approve Plan" button) cannot
 * both win: exactly one gets `true`, every other caller gets `false`.
 */
export function transitionPhase(taskId: string, from: PipelinePhase, to: PipelinePhase): boolean {
  const now = Date.now();
  const result = getDb()
    .prepare(`
      UPDATE tasks
      SET phase = @to,
          state_json = json_set(state_json, '$.currentPhase', @to, '$.updatedAt', @now),
          updated_at = @now
      WHERE task_id = @taskId AND phase = @from
    `)
    .run({ taskId, from, to, now });
  return result.changes === 1;
}

// ─── Pending (non-admin) requests ─────────────────────────────────────────────

export type PendingRequestStatus = "pending" | "approved" | "rejected" | "failed";

export interface PendingRequest {
  requestId: string;
  requesterId: string;
  status: PendingRequestStatus;
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Store a validated request that is waiting for the admin's decision.
 */
export function createPendingRequest(
  requestId: string,
  requesterId: string,
  payload: Record<string, unknown>,
): void {
  const now = Date.now();
  getDb()
    .prepare(`
      INSERT INTO pending_requests (request_id, payload_json, requester_id, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `)
    .run(requestId, JSON.stringify(payload), requesterId, now, now);
}

/**
 * Load a stored request by ID. Returns null if not found.
 */
export function getPendingRequest(requestId: string): PendingRequest | null {
  const row = getDb()
    .prepare(`SELECT * FROM pending_requests WHERE request_id = ?`)
    .get(requestId) as
    | { request_id: string; payload_json: string; requester_id: string; status: PendingRequestStatus; created_at: number; updated_at: number }
    | undefined;
  if (!row) return null;
  return {
    requestId: row.request_id,
    requesterId: row.requester_id,
    status: row.status,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Atomically resolve a pending request. Returns true only for the caller
 * that actually moved it out of "pending" (guards against double clicks).
 */
export function resolvePendingRequest(
  requestId: string,
  status: Exclude<PendingRequestStatus, "pending">,
): boolean {
  const result = getDb()
    .prepare(`
      UPDATE pending_requests SET status = ?, updated_at = ?
      WHERE request_id = ? AND status = 'pending'
    `)
    .run(status, Date.now(), requestId);
  return result.changes === 1;
}

/**
 * Delete stored requests that were resolved more than `resolvedMaxAgeMs`
 * ago, or are still pending after `pendingMaxAgeMs`. Returns rows deleted.
 */
export function pruneOldPendingRequests(resolvedMaxAgeMs: number, pendingMaxAgeMs: number): number {
  const now = Date.now();
  const result = getDb()
    .prepare(`
      DELETE FROM pending_requests
      WHERE (status != 'pending' AND updated_at < ?)
         OR (status = 'pending' AND updated_at < ?)
    `)
    .run(now - resolvedMaxAgeMs, now - pendingMaxAgeMs);
  return result.changes;
}
