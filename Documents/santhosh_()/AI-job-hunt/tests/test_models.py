from datetime import datetime

import pytest
from pydantic import ValidationError

from src.models import (
    ApplicationRecord,
    DailyReport,
    JDAnalysis,
    Job,
    JobStatus,
    MatchScoreBreakdown,
    Portal,
    ResumeAnalysis,
    WorkMode,
)


def test_enum_values_match_db_strings():
    assert JobStatus.PENDING_APPROVAL.value == "pending_approval"
    assert WorkMode.ONSITE.value == "on-site"
    assert {p.value for p in Portal} == {"linkedin", "naukri", "indeed", "wellfound", "adzuna"}
    assert JobStatus("applied") is JobStatus.APPLIED


def test_job_defaults():
    job = Job(job_id="j1", company_name="Acme", role_title="Dev")
    assert job.work_mode is WorkMode.UNKNOWN
    assert job.portal is Portal.LINKEDIN
    assert job.status is JobStatus.DISCOVERED
    assert job.match_score == 0
    assert job.date_posted is None and job.applied_at is None
    datetime.fromisoformat(job.discovered_at)  # auto-populated ISO timestamp


def test_job_coerces_enum_strings():
    job = Job(job_id="j", company_name="c", role_title="r", work_mode="remote", portal="adzuna", status="tailored")
    assert job.work_mode is WorkMode.REMOTE
    assert job.portal is Portal.ADZUNA
    assert job.status is JobStatus.TAILORED


@pytest.mark.parametrize("field,value", [("portal", "monster"), ("work_mode", "space"), ("status", "nope")])
def test_job_rejects_invalid_enum_values(field, value):
    with pytest.raises(ValidationError):
        Job(job_id="j", company_name="c", role_title="r", **{field: value})


def test_job_requires_core_fields():
    with pytest.raises(ValidationError):
        Job(company_name="c", role_title="r")


def test_list_defaults_are_not_shared():
    a, b = JDAnalysis(), JDAnalysis()
    a.hard_skills.append("python")
    assert b.hard_skills == []
    assert JDAnalysis().seniority_level == "mid"
    assert ResumeAnalysis().keyword_match_pct == 0.0


def test_match_score_breakdown_defaults_zero():
    b = MatchScoreBreakdown()
    assert (b.skills_match, b.role_title_match, b.location_match, b.recency, b.company_pref, b.total) == (0,) * 6


def test_application_record_and_daily_report(make_job):
    rec = ApplicationRecord(
        job_id="j", company="c", role_title="r", portal="linkedin",
        match_score=90, resume_version="v1", status="applied",
    )
    assert rec.status is JobStatus.APPLIED
    datetime.fromisoformat(rec.timestamp)

    rep = DailyReport(date="2026-01-01", applied_jobs=[make_job()])
    assert rep.jobs_discovered == 0
    assert rep.applied_jobs[0].job_id == "job-1"
