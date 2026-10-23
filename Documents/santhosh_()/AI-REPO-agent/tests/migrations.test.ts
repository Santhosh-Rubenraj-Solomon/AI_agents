import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/state/migrations.js";

describe("runMigrations", () => {
  it("creates the tasks table with the expected columns", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string; notnull: number; pk: number }>;
    expect(cols.map((c) => c.name)).toEqual([
      "task_id",
      "state_json",
      "phase",
      "user_id",
      "channel_id",
      "thread_ts",
      "worktree_path",
      "created_at",
      "updated_at",
    ]);
    expect(cols.find((c) => c.name === "task_id")?.pk).toBe(1);
    expect(cols.find((c) => c.name === "worktree_path")?.notnull).toBe(0);
    expect(cols.find((c) => c.name === "state_json")?.notnull).toBe(1);
  });

  it("creates the phase / user_id / updated_at indexes", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const idx = (db.prepare("PRAGMA index_list(tasks)").all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["idx_tasks_phase", "idx_tasks_user_id", "idx_tasks_updated_at"]));
  });

  it("is idempotent and preserves existing rows", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare(
      "INSERT INTO tasks VALUES ('t1','{}','analyzing','U','C','1.1',NULL,1,1)",
    ).run();
    expect(() => runMigrations(db)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
  });

  it("enforces NOT NULL and primary key constraints", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(() =>
      db.prepare("INSERT INTO tasks (task_id, phase, user_id, channel_id, thread_ts, created_at, updated_at) VALUES ('t','p','u','c','t',1,1)").run(),
    ).toThrow(/NOT NULL/);
    db.prepare("INSERT INTO tasks VALUES ('dup','{}','p','u','c','t',NULL,1,1)").run();
    expect(() => db.prepare("INSERT INTO tasks VALUES ('dup','{}','p','u','c','t',NULL,1,1)").run()).toThrow(/UNIQUE/);
  });
});
