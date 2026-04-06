"""LangChain tools wrapping the SQLite memory layer for the LangGraph agent."""

import json
from typing import Optional

from langchain_core.tools import tool

from src.memory import (
    save_job,
    get_job,
    get_jobs_by_status,
    get_all_jobs,
    update_job_status,
    job_exists,
    log_application,
    get_daily_application_count,
    increment_daily_application_count,
    get_today_jobs,
)
from src.models import Job, JobStatus, ApplicationRecord


@tool
def memory_store(job_json: str) -> str:
    """Save or update a job in the memory database.

    Args:
        job_json: JSON string representing a Job object. Must include at
                  minimum: job_id, company_name, role_title.
    """
    try:
        data = json.loads(job_json)
        job = Job(**data)
        save_job(job)
        return f"Stored job: {job.job_id} ({job.company_name} — {job.role_title})"
    except Exception as e:
        return f"Error storing job: {str(e)}"


@tool
def memory_query(
    query_type: str,
    job_id: Optional[str] = None,
    status: Optional[str] = None,
) -> str:
    """Query jobs from the memory database.

    Args:
        query_type: One of 'get', 'exists', 'by_status', 'all', 'today',
                    'daily_count'.
        job_id: Required for 'get' and 'exists' queries.
        status: Required for 'by_status' — one of: discovered, tailored,
                pending_approval, approved, skipped, applied, failed.
    """
    try:
        if query_type == "get":
            if not job_id:
                return "Error: job_id required for 'get' query."
            job = get_job(job_id)
            return job.model_dump_json(indent=2) if job else "Not found."

        elif query_type == "exists":
            if not job_id:
                return "Error: job_id required for 'exists' query."
            return json.dumps({"exists": job_exists(job_id)})

        elif query_type == "by_status":
            if not status:
                return "Error: status required for 'by_status' query."
            jobs = get_jobs_by_status(JobStatus(status))
            return json.dumps([j.model_dump() for j in jobs], indent=2, default=str)

        elif query_type == "all":
            jobs = get_all_jobs()
            return json.dumps([j.model_dump() for j in jobs], indent=2, default=str)

        elif query_type == "today":
            jobs = get_today_jobs()
            return json.dumps([j.model_dump() for j in jobs], indent=2, default=str)

        elif query_type == "daily_count":
            count = get_daily_application_count()
            return json.dumps({"daily_applications": count})

        else:
            return f"Unknown query_type: {query_type}"

    except Exception as e:
        return f"Error querying memory: {str(e)}"


@tool
def memory_update_status(job_id: str, new_status: str, **kwargs) -> str:
    """Update the status of a job in memory.

    Args:
        job_id: The unique job identifier.
        new_status: New status — one of: discovered, tailored,
                    pending_approval, approved, skipped, applied, failed.
    """
    try:
        update_job_status(job_id, JobStatus(new_status), **kwargs)
        return f"Updated {job_id} → {new_status}"
    except Exception as e:
        return f"Error updating status: {str(e)}"


@tool
def memory_log_application(record_json: str) -> str:
    """Log a completed application to the tracker.

    Args:
        record_json: JSON string with keys: job_id, company, role_title,
                     portal, match_score, resume_version, status.
    """
    try:
        data = json.loads(record_json)
        record = ApplicationRecord(**data)
        log_application(record)
        return f"Logged application: {record.job_id}"
    except Exception as e:
        return f"Error logging application: {str(e)}"


@tool
def memory_increment_daily_count() -> str:
    """Increment and return today's application count."""
    count = increment_daily_application_count()
    return json.dumps({"daily_applications": count})
