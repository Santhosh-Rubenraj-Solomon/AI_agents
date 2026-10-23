from unittest.mock import MagicMock

import pytest

from src import memory
from src.models import JobStatus
from src.phases import approval, reporting
from src.tools import notification


@pytest.fixture
def notify(monkeypatch):
    """Capture notify_human calls instead of sending email/Slack/WhatsApp."""
    m = MagicMock()
    m.invoke.return_value = "sent ok"
    monkeypatch.setattr(approval, "notify_human", m)
    monkeypatch.setattr(reporting, "notify_human", m)
    return m


# ── approval ───────────────────────────────────────────────────────────────

async def test_send_approval_requests(config, make_job, notify):
    job = make_job("j1", status=JobStatus.TAILORED, keyword_match_before=40, keyword_match_after=85)
    memory.save_job(job)
    results = await approval.send_approval_requests([job], config)
    assert results == [{"job_id": "j1", "company": "Acme", "role": "Backend Developer", "notification_result": "sent ok"}]
    payload = notify.invoke.call_args.args[0]
    assert payload["channel"] == "email"
    assert "APPROVE j1" in payload["message"] and "40% → 85%" in payload["message"]
    assert memory.get_job("j1").status is JobStatus.PENDING_APPROVAL


def test_process_approval_skip_and_stop(make_job):
    for jid in ("A1", "B2", "C3"):
        memory.save_job(make_job(jid, status=JobStatus.PENDING_APPROVAL))
    updates = approval.process_approval_response("approve A1\n\nSKIP B2\ngarbage\nHOLD C3")
    assert updates == [{"job_id": "A1", "action": "approved"}, {"job_id": "B2", "action": "skipped"}]
    assert memory.get_job("A1").status is JobStatus.APPROVED
    assert memory.get_job("B2").status is JobStatus.SKIPPED
    assert memory.get_job("C3").status is JobStatus.PENDING_APPROVAL

    updates = approval.process_approval_response("stop")
    assert updates == [{"job_id": "C3", "action": "skipped (STOP command)"}]
    assert approval.get_pending_jobs() == []
    assert [j.job_id for j in approval.get_approved_jobs()] == ["A1"]


# BUG: src/phases/approval.py:73 upper-cases the WHOLE line, including the job
# id, so "APPROVE adzuna-123" updates job "ADZUNA-123". SQLite '=' is
# case-sensitive, so the UPDATE matches nothing, yet the function still reports
# {"action": "approved"}. Every real id in the system is lower-case
# (adzuna-<id>, mock ids like "google-backend-swe-001"), so the README's
# `--phase approve --response "APPROVE <job_id>"` never approves anything.
@pytest.mark.xfail(reason="approval.py:73 upper-cases job ids; approvals silently no-op", strict=True)
def test_process_approval_preserves_job_id_case(make_job):
    memory.save_job(make_job("adzuna-123", status=JobStatus.PENDING_APPROVAL))
    updates = approval.process_approval_response("APPROVE adzuna-123")
    assert updates == [{"job_id": "adzuna-123", "action": "approved"}]
    assert memory.get_job("adzuna-123").status is JobStatus.APPROVED


def test_format_approval_summary():
    assert approval.format_approval_summary([]) == "No jobs to send for approval."
    out = approval.format_approval_summary([{"job_id": "j", "company": "c", "role": "r", "notification_result": "x" * 100}])
    assert out.splitlines()[-1] == f"| j | c | r | {'x' * 60} |"


# ── notification formatting / channel routing (no network) ─────────────────

def test_format_approval_message():
    subject, body = notification.format_approval_message(
        "Dev", "Acme", "linkedin", "Chennai", 88, "https://x", "r.pdf", "c.txt", 40.4, 90.6, "job-9",
    )
    assert subject == "[JobAgent] Ready to Apply — Dev at Acme"
    assert "Match Score:  88/100" in body and "40% → 91%" in body
    assert "APPROVE job-9" in body and "SKIP job-9" in body


@pytest.mark.parametrize("channel,expect", [
    ("email", "Email not configured"),
    ("slack", "Slack not configured"),
    ("pigeon", "Unknown notification channel: pigeon"),
])
def test_notify_human_unconfigured_channels(monkeypatch, channel, expect):
    for v in ("SMTP_USER", "SMTP_PASSWORD", "NOTIFY_EMAIL_TO", "SLACK_WEBHOOK_URL"):
        monkeypatch.delenv(v, raising=False)
    out = notification.notify_human.invoke({"subject": "s", "message": "m", "channel": channel})
    assert out.startswith(expect)


def test_notify_human_slack_posts_webhook(monkeypatch):
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.example/abc")
    import httpx
    post = MagicMock(return_value=MagicMock(status_code=200))
    monkeypatch.setattr(httpx, "post", post)
    out = notification.notify_human.invoke({"subject": "Hi", "message": "body", "channel": "slack"})
    assert out == "Slack notification sent: Hi"
    assert post.call_args.kwargs["json"] == {"text": "*Hi*\n\nbody"}


def test_notify_human_wraps_exceptions(monkeypatch):
    monkeypatch.setattr(notification, "_send_email", MagicMock(side_effect=OSError("smtp down")))
    out = notification.notify_human.invoke({"subject": "s", "message": "m", "channel": "email"})
    assert out == "Notification failed (email): smtp down"


# ── reporting ──────────────────────────────────────────────────────────────

def test_build_and_format_daily_report(make_job):
    memory.save_job(make_job("d", status=JobStatus.DISCOVERED))
    memory.save_job(make_job("t", status=JobStatus.TAILORED, keyword_match_before=40, keyword_match_after=80))
    memory.save_job(make_job("t2", status=JobStatus.TAILORED, keyword_match_before=60, keyword_match_after=90))
    memory.save_job(make_job("p", status=JobStatus.PENDING_APPROVAL))
    memory.save_job(make_job("f", status=JobStatus.FAILED, error_description="captcha"))
    memory.save_job(make_job("a", status=JobStatus.APPLIED, applied_at="2026-10-22T10:30:00"))

    rep = reporting.build_daily_report()
    assert (rep.jobs_discovered, rep.resumes_tailored, rep.applications_submitted,
            rep.pending_approval, rep.failed_submissions) == (1, 2, 1, 1, 1)
    assert rep.avg_keyword_before == 50 and rep.avg_keyword_after == 85

    text = reporting.format_daily_report(rep)
    assert "APPROVE p" in text
    assert "captcha" in text
    assert "2026-10-22T10:30" in text
    assert "Avg keyword match after tailoring:  85%" in text


def test_format_daily_report_empty():
    text = reporting.format_daily_report(reporting.build_daily_report())
    for s in ("_No applications submitted today._", "_No jobs pending approval._", "_No failures today._"):
        assert s in text


async def test_send_daily_report(notify):
    text = await reporting.send_daily_report()
    assert text.startswith("# Job Application Report")
    assert notify.invoke.call_args.args[0]["subject"].startswith("[JobAgent] Daily Report")


def test_full_status_report(make_job):
    assert reporting.get_full_status_report() == "No jobs in the system yet."
    memory.save_job(make_job("x", status=JobStatus.APPLIED))
    memory.save_job(make_job("y", status=JobStatus.APPLIED))
    memory.save_job(make_job("z", status=JobStatus.SKIPPED))
    out = reporting.get_full_status_report()
    assert "- **applied**: 2" in out and "- **skipped**: 1" in out and "- **Total**: 3" in out
