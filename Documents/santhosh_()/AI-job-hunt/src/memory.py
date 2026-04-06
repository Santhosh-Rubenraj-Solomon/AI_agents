"""SQLite-backed memory store for jobs, applications, and daily counters."""

import json
import sqlite3
from datetime import datetime, date
from pathlib import Path
from typing import Optional

from src.models import Job, JobStatus, ApplicationRecord


DB_PATH = Path(__file__).resolve().parent.parent / "db" / "jobhunt.db"


def _get_connection(db_path: Optional[str] = None) -> sqlite3.Connection:
    path = db_path or str(DB_PATH)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(db_path: Optional[str] = None) -> None:
    """Create tables if they don't exist."""
    conn = _get_connection(db_path)
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS jobs (
            job_id TEXT PRIMARY KEY,
            company_name TEXT NOT NULL,
            role_title TEXT NOT NULL,
            location TEXT DEFAULT '',
            work_mode TEXT DEFAULT 'unknown',
            date_posted TEXT,
            application_url TEXT DEFAULT '',
            job_description TEXT DEFAULT '',
            portal TEXT DEFAULT 'linkedin',
            match_score INTEGER DEFAULT 0,
            status TEXT DEFAULT 'discovered',
            resume_version TEXT,
            cover_letter_path TEXT,
            keyword_match_before REAL DEFAULT 0.0,
            keyword_match_after REAL DEFAULT 0.0,
            ats_score_before REAL DEFAULT 0.0,
            ats_score_after REAL DEFAULT 0.0,
            discovered_at TEXT,
            applied_at TEXT,
            error_description TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS application_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL,
            company TEXT NOT NULL,
            role_title TEXT NOT NULL,
            portal TEXT NOT NULL,
            match_score INTEGER DEFAULT 0,
            resume_version TEXT DEFAULT '',
            status TEXT DEFAULT 'discovered',
            timestamp TEXT NOT NULL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS daily_counter (
            date TEXT PRIMARY KEY,
            applications_submitted INTEGER DEFAULT 0
        )
    """)

    conn.commit()
    conn.close()


# ── Job CRUD ──────────────────────────────────────────────────────────────

def save_job(job: Job, db_path: Optional[str] = None) -> None:
    conn = _get_connection(db_path)
    cur = conn.cursor()
    cur.execute("""
        INSERT OR REPLACE INTO jobs (
            job_id, company_name, role_title, location, work_mode,
            date_posted, application_url, job_description, portal,
            match_score, status, resume_version, cover_letter_path,
            keyword_match_before, keyword_match_after,
            ats_score_before, ats_score_after,
            discovered_at, applied_at, error_description
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        job.job_id, job.company_name, job.role_title, job.location,
        job.work_mode.value, job.date_posted, job.application_url,
        job.job_description, job.portal.value, job.match_score,
        job.status.value, job.resume_version, job.cover_letter_path,
        job.keyword_match_before, job.keyword_match_after,
        job.ats_score_before, job.ats_score_after,
        job.discovered_at, job.applied_at, job.error_description,
    ))
    conn.commit()
    conn.close()


def get_job(job_id: str, db_path: Optional[str] = None) -> Optional[Job]:
    conn = _get_connection(db_path)
    cur = conn.cursor()
    cur.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,))
    row = cur.fetchone()
    conn.close()
    if row is None:
        return None
    return _row_to_job(row)


def get_jobs_by_status(status: JobStatus, db_path: Optional[str] = None) -> list[Job]:
    conn = _get_connection(db_path)
    cur = conn.cursor()
    cur.execute("SELECT * FROM jobs WHERE status = ? ORDER BY match_score DESC", (status.value,))
    rows = cur.fetchall()
    conn.close()
    return [_row_to_job(r) for r in rows]


def get_all_jobs(db_path: Optional[str] = None) -> list[Job]:
    conn = _get_connection(db_path)
    cur = conn.cursor()
    cur.execute("SELECT * FROM jobs ORDER BY match_score DESC")
    rows = cur.fetchall()
    conn.close()
    return [_row_to_job(r) for r in rows]


def update_job_status(
    job_id: str, status: JobStatus, db_path: Optional[str] = None, **kwargs
) -> None:
    conn = _get_connection(db_path)
    cur = conn.cursor()
    updates = ["status = ?"]
    values: list = [status.value]

    for key, val in kwargs.items():
        updates.append(f"{key} = ?")
        values.append(val)

    values.append(job_id)
    cur.execute(f"UPDATE jobs SET {', '.join(updates)} WHERE job_id = ?", values)
    conn.commit()
    conn.close()


def job_exists(job_id: str, db_path: Optional[str] = None) -> bool:
    return get_job(job_id, db_path) is not None


def get_today_jobs(db_path: Optional[str] = None) -> list[Job]:
    today = date.today().isoformat()
    conn = _get_connection(db_path)
    cur = conn.cursor()
    cur.execute(
        "SELECT * FROM jobs WHERE discovered_at LIKE ? OR applied_at LIKE ?",
        (f"{today}%", f"{today}%"),
    )
    rows = cur.fetchall()
    conn.close()
    return [_row_to_job(r) for r in rows]


# ── Application Log ──────────────────────────────────────────────────────

def log_application(record: ApplicationRecord, db_path: Optional[str] = None) -> None:
    conn = _get_connection(db_path)
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO application_log (
            job_id, company, role_title, portal,
            match_score, resume_version, status, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        record.job_id, record.company, record.role_title, record.portal,
        record.match_score, record.resume_version, record.status.value,
        record.timestamp,
    ))
    conn.commit()
    conn.close()


# ── Daily Counter ─────────────────────────────────────────────────────────

def get_daily_application_count(db_path: Optional[str] = None) -> int:
    today = date.today().isoformat()
    conn = _get_connection(db_path)
    cur = conn.cursor()
    cur.execute("SELECT applications_submitted FROM daily_counter WHERE date = ?", (today,))
    row = cur.fetchone()
    conn.close()
    return row["applications_submitted"] if row else 0


def increment_daily_application_count(db_path: Optional[str] = None) -> int:
    today = date.today().isoformat()
    conn = _get_connection(db_path)
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO daily_counter (date, applications_submitted)
        VALUES (?, 1)
        ON CONFLICT(date) DO UPDATE SET
            applications_submitted = applications_submitted + 1
    """, (today,))
    conn.commit()
    cur.execute("SELECT applications_submitted FROM daily_counter WHERE date = ?", (today,))
    row = cur.fetchone()
    conn.close()
    return row["applications_submitted"]


# ── Helpers ───────────────────────────────────────────────────────────────

def _row_to_job(row: sqlite3.Row) -> Job:
    return Job(
        job_id=row["job_id"],
        company_name=row["company_name"],
        role_title=row["role_title"],
        location=row["location"],
        work_mode=row["work_mode"],
        date_posted=row["date_posted"],
        application_url=row["application_url"],
        job_description=row["job_description"],
        portal=row["portal"],
        match_score=row["match_score"],
        status=row["status"],
        resume_version=row["resume_version"],
        cover_letter_path=row["cover_letter_path"],
        keyword_match_before=row["keyword_match_before"],
        keyword_match_after=row["keyword_match_after"],
        ats_score_before=row["ats_score_before"],
        ats_score_after=row["ats_score_after"],
        discovered_at=row["discovered_at"],
        applied_at=row["applied_at"],
        error_description=row["error_description"],
    )
