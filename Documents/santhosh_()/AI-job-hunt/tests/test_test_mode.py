from datetime import datetime, timedelta

from src import memory
from src import test_mode as tm
from src.models import Job, JobStatus


def test_mock_jobs_are_well_formed():
    ids = [j["job_id"] for j in tm.MOCK_JOBS]
    assert len(ids) == 10 and len(set(ids)) == 10
    for data in tm.MOCK_JOBS:
        Job(**data)  # validates
        assert 0 <= data["match_score"] <= 100
        assert data["application_url"].startswith("https://")


def test_mock_discovery_returns_sorted_and_persists():
    jobs = tm.mock_discovery(["python"])
    assert len(jobs) == len(tm.MOCK_JOBS)
    scores = [j.match_score for j in jobs]
    assert scores == sorted(scores, reverse=True)
    assert jobs[0].job_id == "razorpay-ai-dev-003"  # highest (95)
    assert all(j.status is JobStatus.DISCOVERED for j in jobs)
    assert {j.job_id for j in memory.get_all_jobs()} == {d["job_id"] for d in tm.MOCK_JOBS}


def test_mock_discovery_dates_within_ten_days():
    now = datetime.now()
    for j in tm.mock_discovery():
        posted = datetime.fromisoformat(j.date_posted)
        assert now - timedelta(days=11) <= posted <= now


def test_mock_discovery_is_idempotent():
    tm.mock_discovery()
    tm.mock_discovery()
    assert len(memory.get_all_jobs()) == len(tm.MOCK_JOBS)


def test_mock_tailoring_ranges(make_job):
    job = make_job(company_name="Acme", role_title="Dev")
    for _ in range(20):
        r = tm.mock_tailoring(job)
        assert r["job_id"] == job.job_id and r["company"] == "Acme" and r["role"] == "Dev"
        assert r["resume_path"] == "./applications/Acme_Dev/resume_v1.pdf"
        assert 45 <= r["keyword_before"] <= 60 < 78 <= r["keyword_after"] <= 95
        assert 40 <= r["ats_before"] <= 55 < 80 <= r["ats_after"] <= 96
        assert 6 <= r["missing_keywords_before"] <= 12
        assert 0 <= r["missing_keywords_after"] <= 3
