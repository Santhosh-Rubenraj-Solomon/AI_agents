import sqlite3
from datetime import date, datetime, timedelta

from src import memory
from src.models import ApplicationRecord, JobStatus, Portal, WorkMode


def test_init_db_creates_tables_and_is_idempotent(isolated_db):
    memory.init_db()  # second call must not fail
    conn = sqlite3.connect(isolated_db)
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    conn.close()
    assert {"jobs", "application_log", "daily_counter"} <= names


def test_init_db_explicit_path_creates_parent_dirs(tmp_path):
    p = tmp_path / "nested" / "dir" / "x.db"
    memory.init_db(str(p))
    assert p.exists()


def test_save_and_get_job_roundtrip(make_job):
    job = make_job(work_mode=WorkMode.REMOTE, portal=Portal.ADZUNA, keyword_match_before=40.5)
    memory.save_job(job)
    got = memory.get_job(job.job_id)
    assert got == job
    assert got.work_mode is WorkMode.REMOTE and got.portal is Portal.ADZUNA


def test_get_job_missing_returns_none():
    assert memory.get_job("nope") is None
    assert memory.job_exists("nope") is False


def test_save_job_upserts(make_job):
    memory.save_job(make_job(match_score=10))
    memory.save_job(make_job(match_score=99))
    assert len(memory.get_all_jobs()) == 1
    assert memory.get_job("job-1").match_score == 99


def test_get_all_jobs_sorted_by_score(make_job):
    for i, s in enumerate([50, 90, 70]):
        memory.save_job(make_job(f"j{i}", match_score=s))
    assert [j.match_score for j in memory.get_all_jobs()] == [90, 70, 50]


def test_get_jobs_by_status(make_job):
    memory.save_job(make_job("a", status=JobStatus.TAILORED, match_score=1))
    memory.save_job(make_job("b", status=JobStatus.TAILORED, match_score=2))
    memory.save_job(make_job("c", status=JobStatus.APPROVED))
    assert [j.job_id for j in memory.get_jobs_by_status(JobStatus.TAILORED)] == ["b", "a"]
    assert memory.get_jobs_by_status(JobStatus.FAILED) == []


def test_update_job_status_with_extra_columns(make_job):
    memory.save_job(make_job())
    memory.update_job_status("job-1", JobStatus.FAILED, error_description="boom", applied_at="2026-01-01")
    j = memory.get_job("job-1")
    assert j.status is JobStatus.FAILED
    assert j.error_description == "boom"
    assert j.applied_at == "2026-01-01"


def test_update_job_status_unknown_id_is_noop(make_job):
    memory.update_job_status("ghost", JobStatus.APPROVED)
    assert memory.get_job("ghost") is None


def test_get_today_jobs(make_job):
    today = datetime.now().isoformat()
    old = (datetime.now() - timedelta(days=3)).isoformat()
    memory.save_job(make_job("new", discovered_at=today))
    memory.save_job(make_job("old", discovered_at=old))
    memory.save_job(make_job("old-applied", discovered_at=old, applied_at=today))
    assert {j.job_id for j in memory.get_today_jobs()} == {"new", "old-applied"}


def test_log_application(isolated_db):
    rec = ApplicationRecord(
        job_id="j", company="c", role_title="r", portal="linkedin",
        match_score=90, resume_version="v1", status=JobStatus.APPLIED,
    )
    memory.log_application(rec)
    conn = sqlite3.connect(isolated_db)
    rows = conn.execute("SELECT job_id, status, match_score FROM application_log").fetchall()
    conn.close()
    assert rows == [("j", "applied", 90)]


def test_daily_counter(isolated_db):
    assert memory.get_daily_application_count() == 0
    assert memory.increment_daily_application_count() == 1
    assert memory.increment_daily_application_count() == 2
    assert memory.get_daily_application_count() == 2
    conn = sqlite3.connect(isolated_db)
    assert conn.execute("SELECT date FROM daily_counter").fetchone()[0] == date.today().isoformat()
    conn.close()


def test_explicit_db_path_is_isolated_from_default(tmp_path, make_job):
    other = str(tmp_path / "other.db")
    memory.init_db(other)
    memory.save_job(make_job("only-other"), db_path=other)
    assert memory.job_exists("only-other", db_path=other)
    assert not memory.job_exists("only-other")
