"""Phase 3 — Human Approval Gate: notify user and wait for approval."""

import json
import time
from typing import Optional

from src.config import AppConfig
from src.models import Job, JobStatus
from src.memory import get_jobs_by_status, update_job_status
from src.tools.notification import notify_human, format_approval_message


async def send_approval_requests(
    jobs: list[Job],
    config: AppConfig,
) -> list[dict]:
    """Send approval notifications for all tailored jobs.

    Returns a list of notification results.
    """
    results = []

    for job in jobs:
        subject, body = format_approval_message(
            role_title=job.role_title,
            company_name=job.company_name,
            portal=job.portal.value,
            location=job.location,
            match_score=job.match_score,
            application_url=job.application_url,
            resume_version_path=job.resume_version or "N/A",
            cover_letter_path=job.cover_letter_path or "N/A",
            before_score=job.keyword_match_before,
            after_score=job.keyword_match_after,
            job_id=job.job_id,
        )

        # Send notification
        channel = config.agent_settings.notification_channel
        result = notify_human.invoke({
            "subject": subject,
            "message": body,
            "channel": channel,
        })

        # Update status to pending_approval
        update_job_status(job.job_id, JobStatus.PENDING_APPROVAL)

        results.append({
            "job_id": job.job_id,
            "company": job.company_name,
            "role": job.role_title,
            "notification_result": result,
        })

    return results


def process_approval_response(response: str) -> list[dict]:
    """Parse user approval responses and update job statuses.

    Supported commands:
        APPROVE <job_id>  — approve a specific job
        SKIP <job_id>     — skip a specific job
        STOP              — skip all pending jobs

    Returns a list of status updates applied.
    """
    updates = []
    lines = response.strip().split("\n")

    for line in lines:
        line = line.strip().upper()

        if line == "STOP":
            # Mark all pending_approval jobs as skipped
            pending = get_jobs_by_status(JobStatus.PENDING_APPROVAL)
            for job in pending:
                update_job_status(job.job_id, JobStatus.SKIPPED)
                updates.append({
                    "job_id": job.job_id,
                    "action": "skipped (STOP command)",
                })
            break

        parts = line.split(maxsplit=1)
        if len(parts) != 2:
            continue

        command, job_id = parts[0], parts[1].strip()

        if command == "APPROVE":
            update_job_status(job_id, JobStatus.APPROVED)
            updates.append({"job_id": job_id, "action": "approved"})
        elif command == "SKIP":
            update_job_status(job_id, JobStatus.SKIPPED)
            updates.append({"job_id": job_id, "action": "skipped"})

    return updates


def get_approved_jobs() -> list[Job]:
    """Return all jobs that have been approved for submission."""
    return get_jobs_by_status(JobStatus.APPROVED)


def get_pending_jobs() -> list[Job]:
    """Return all jobs awaiting human approval."""
    return get_jobs_by_status(JobStatus.PENDING_APPROVAL)


def format_approval_summary(results: list[dict]) -> str:
    """Format approval notification results as markdown."""
    if not results:
        return "No jobs to send for approval."

    lines = [
        "## Approval Notifications Sent\n",
        "| Job ID | Company | Role | Status |",
        "|--------|---------|------|--------|",
    ]
    for r in results:
        lines.append(
            f"| {r['job_id']} | {r['company']} | {r['role']} "
            f"| {r['notification_result'][:60]} |"
        )
    return "\n".join(lines)
