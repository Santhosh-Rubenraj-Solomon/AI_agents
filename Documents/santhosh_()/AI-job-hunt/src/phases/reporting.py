"""Phase 5 — Tracking & Reporting: daily summary and status reports."""

from datetime import date, datetime
from typing import Optional

from src.models import Job, JobStatus, DailyReport
from src.memory import get_today_jobs, get_jobs_by_status, get_all_jobs
from src.tools.notification import notify_human


def build_daily_report() -> DailyReport:
    """Aggregate today's job data into a DailyReport."""
    today_str = date.today().isoformat()
    all_today = get_today_jobs()

    discovered = [j for j in all_today if j.status == JobStatus.DISCOVERED]
    tailored = [j for j in all_today if j.status == JobStatus.TAILORED]
    applied = [j for j in all_today if j.status == JobStatus.APPLIED]
    pending = get_jobs_by_status(JobStatus.PENDING_APPROVAL)
    failed = [j for j in all_today if j.status == JobStatus.FAILED]

    # Compute average keyword scores
    kw_before = [j.keyword_match_before for j in all_today if j.keyword_match_before > 0]
    kw_after = [j.keyword_match_after for j in all_today if j.keyword_match_after > 0]

    return DailyReport(
        date=today_str,
        jobs_discovered=len(discovered),
        resumes_tailored=len(tailored),
        applications_submitted=len(applied),
        pending_approval=len(pending),
        failed_submissions=len(failed),
        avg_keyword_before=sum(kw_before) / len(kw_before) if kw_before else 0.0,
        avg_keyword_after=sum(kw_after) / len(kw_after) if kw_after else 0.0,
        applied_jobs=applied,
        pending_jobs=pending,
        failed_jobs=failed,
    )


def format_daily_report(report: DailyReport) -> str:
    """Format the daily report as markdown."""
    lines = [
        f"# Job Application Report — {report.date}",
        "",
        "## Summary",
        f"- Jobs discovered today:   {report.jobs_discovered}",
        f"- Resumes tailored:        {report.resumes_tailored}",
        f"- Applications submitted:  {report.applications_submitted}",
        f"- Pending approval:        {report.pending_approval}",
        f"- Failed submissions:      {report.failed_submissions}",
        "",
    ]

    # Applied today
    lines.append("## Applied Today")
    if report.applied_jobs:
        lines.append("| Company | Role | Portal | Match Score | Status | Time |")
        lines.append("|---------|------|--------|-------------|--------|------|")
        for j in report.applied_jobs:
            applied_time = j.applied_at[:16] if j.applied_at else "N/A"
            lines.append(
                f"| {j.company_name} | {j.role_title} | {j.portal.value} "
                f"| {j.match_score}/100 | {j.status.value} | {applied_time} |"
            )
    else:
        lines.append("_No applications submitted today._")
    lines.append("")

    # Pending approval
    lines.append("## Pending Your Approval")
    if report.pending_jobs:
        lines.append("| Company | Role | Portal | Match Score | Approve? |")
        lines.append("|---------|------|--------|-------------|----------|")
        for j in report.pending_jobs:
            lines.append(
                f"| {j.company_name} | {j.role_title} | {j.portal.value} "
                f"| {j.match_score}/100 | APPROVE {j.job_id} |"
            )
    else:
        lines.append("_No jobs pending approval._")
    lines.append("")

    # Failed
    lines.append("## Failed / Needs Attention")
    if report.failed_jobs:
        lines.append("| Company | Role | Error Description | Action Needed |")
        lines.append("|---------|------|-------------------|---------------|")
        for j in report.failed_jobs:
            err = (j.error_description or "Unknown")[:60]
            lines.append(
                f"| {j.company_name} | {j.role_title} | {err} | Retry or skip |"
            )
    else:
        lines.append("_No failures today._")
    lines.append("")

    # Keyword performance
    lines.append("## Keyword Performance (Avg across today's tailored resumes)")
    lines.append(f"- Avg keyword match before tailoring: {report.avg_keyword_before:.0f}%")
    lines.append(f"- Avg keyword match after tailoring:  {report.avg_keyword_after:.0f}%")
    lines.append("")
    lines.append("---")
    lines.append("Next scheduled discovery run: tomorrow 9:00 AM IST")

    return "\n".join(lines)


async def send_daily_report(config=None) -> str:
    """Build and send the daily summary report to the user."""
    report = build_daily_report()
    report_text = format_daily_report(report)

    result = notify_human.invoke({
        "subject": f"[JobAgent] Daily Report — {report.date}",
        "message": report_text,
    })

    return report_text


def get_full_status_report() -> str:
    """Generate a comprehensive status report of all jobs in the system."""
    all_jobs = get_all_jobs()

    if not all_jobs:
        return "No jobs in the system yet."

    status_counts: dict[str, int] = {}
    for j in all_jobs:
        status_counts[j.status.value] = status_counts.get(j.status.value, 0) + 1

    lines = [
        "# Full Application Status Report",
        "",
        "## Status Breakdown",
    ]
    for status, count in sorted(status_counts.items()):
        lines.append(f"- **{status}**: {count}")
    lines.append(f"- **Total**: {len(all_jobs)}")
    lines.append("")

    lines.append("## All Jobs")
    lines.append("| # | Company | Role | Portal | Score | Status |")
    lines.append("|---|---------|------|--------|-------|--------|")
    for i, j in enumerate(all_jobs, 1):
        lines.append(
            f"| {i} | {j.company_name} | {j.role_title} | {j.portal.value} "
            f"| {j.match_score} | {j.status.value} |"
        )

    return "\n".join(lines)
