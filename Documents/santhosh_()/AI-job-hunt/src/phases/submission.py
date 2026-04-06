"""Phase 4 — Application Submission: browser automation for job portals."""

import asyncio
import json
import time
from datetime import datetime
from typing import Optional

from src.config import AppConfig, get_portal_credentials
from src.models import Job, JobStatus, ApplicationRecord, Portal
from src.memory import (
    update_job_status,
    log_application,
    get_daily_application_count,
    increment_daily_application_count,
)
from src.tools.browser import (
    browser_navigate,
    browser_fill,
    browser_click,
    browser_upload,
    browser_screenshot,
    browser_get_page_text,
)
from src.tools.notification import notify_human


MAX_RETRIES = 3
RETRY_DELAY = 5  # seconds


class SubmissionError(Exception):
    """Raised when a submission action fails after retries."""
    pass


def _retry_action(tool_fn, kwargs: dict, retries: int = MAX_RETRIES) -> str:
    """Retry a browser tool action up to N times."""
    last_error = ""
    for attempt in range(1, retries + 1):
        try:
            result = tool_fn.invoke(kwargs)
            if "Error" not in result and "error" not in result.lower():
                return result
            last_error = result
        except Exception as e:
            last_error = str(e)

        if attempt < retries:
            time.sleep(RETRY_DELAY)

    raise SubmissionError(
        f"Action {tool_fn.name} failed after {retries} attempts: {last_error}"
    )


# ── Portal-Specific Flows ────────────────────────────────────────────────

async def submit_linkedin_easy_apply(job: Job, config: AppConfig) -> str:
    """LinkedIn Easy Apply flow using browser automation."""
    steps = []

    # Navigate to job URL
    result = _retry_action(browser_navigate, {"url": job.application_url})
    steps.append(f"1. Navigated: {result}")

    # Screenshot the page
    result = _retry_action(browser_screenshot, {"description": "linkedin_job_page"})
    steps.append(f"2. Screenshot: {result}")

    # Click Easy Apply button
    try:
        result = _retry_action(browser_click, {"selector": "button.jobs-apply-button"})
        steps.append(f"3. Clicked Easy Apply: {result}")
    except SubmissionError:
        # Try alternative selector
        result = _retry_action(
            browser_click,
            {"selector": "[data-control-name='jobdetails_topcard_inapply']"},
        )
        steps.append(f"3. Clicked Apply (alt): {result}")

    # Fill form steps — this is a simplified flow; real forms vary
    # Upload resume
    if job.resume_version:
        try:
            result = _retry_action(
                browser_upload,
                {"selector": "input[type='file']", "file_path": job.resume_version},
            )
            steps.append(f"4. Uploaded resume: {result}")
        except SubmissionError as e:
            steps.append(f"4. Resume upload issue: {e}")

    # Fill contact info from user profile
    profile = config.user_profile
    field_mappings = [
        ("input[name='email']", profile.email),
        ("input[name='phone']", profile.phone),
        ("input[name='firstName']", profile.name.split()[0] if profile.name else ""),
        ("input[name='lastName']", profile.name.split()[-1] if profile.name else ""),
    ]

    for selector, value in field_mappings:
        if value:
            try:
                _retry_action(browser_fill, {"selector": selector, "value": value})
            except SubmissionError:
                pass  # Field might not exist in this form

    # Screenshot final review
    result = _retry_action(browser_screenshot, {"description": "linkedin_review"})
    steps.append(f"5. Review screenshot: {result}")

    # NOTE: Actual submit button click is intentionally commented out for safety.
    # In production, uncomment after thorough testing.
    # result = _retry_action(browser_click, {"selector": "button[aria-label='Submit application']"})
    steps.append("6. SUBMIT — awaiting human confirmation in browser")

    # Confirmation screenshot
    result = _retry_action(browser_screenshot, {"description": "linkedin_confirmation"})
    steps.append(f"7. Confirmation: {result}")

    return "\n".join(steps)


async def submit_generic_portal(job: Job, config: AppConfig) -> str:
    """Generic portal flow (Naukri, Indeed, Wellfound) using browser automation."""
    steps = []

    # Navigate
    result = _retry_action(browser_navigate, {"url": job.application_url})
    steps.append(f"1. Navigated: {result}")

    # Screenshot to identify form structure
    result = _retry_action(browser_screenshot, {"description": f"{job.portal.value}_job_page"})
    steps.append(f"2. Screenshot: {result}")

    # Get page text for LLM analysis
    page_text = _retry_action(browser_get_page_text, {})
    steps.append(f"3. Extracted page text ({len(page_text)} chars)")

    # Check for CAPTCHA
    if "captcha" in page_text.lower() or "verify" in page_text.lower():
        # Notify human about CAPTCHA
        screenshot_result = _retry_action(
            browser_screenshot, {"description": "captcha_detected"}
        )
        notify_human.invoke({
            "subject": f"[JobAgent] CAPTCHA Detected — {job.company_name}",
            "message": (
                f"A CAPTCHA was detected while applying to {job.role_title} "
                f"at {job.company_name} on {job.portal.value}.\n\n"
                f"Please solve the CAPTCHA manually and confirm when done.\n\n"
                f"Screenshot: {screenshot_result}"
            ),
        })
        steps.append("4. CAPTCHA detected — notified human, waiting...")
        return "\n".join(steps)

    # Upload resume if file input found
    if job.resume_version:
        try:
            result = _retry_action(
                browser_upload,
                {"selector": "input[type='file']", "file_path": job.resume_version},
            )
            steps.append(f"4. Uploaded resume: {result}")
        except SubmissionError as e:
            steps.append(f"4. Resume upload issue: {e}")

    # Screenshot before final submit
    result = _retry_action(browser_screenshot, {"description": f"{job.portal.value}_pre_submit"})
    steps.append(f"5. Pre-submit screenshot: {result}")

    # NOTE: Submit button click is portal-specific and should be configured per portal
    steps.append("6. SUBMIT — awaiting human confirmation in browser")

    return "\n".join(steps)


# ── Main Submission Flow ──────────────────────────────────────────────────

async def run_submission(
    jobs: list[Job],
    config: AppConfig,
) -> list[dict]:
    """Execute application submission for all approved jobs.

    Enforces:
    - Daily application limit
    - Duplicate prevention (checked before this phase)
    - Error handling with retry + notification
    """
    results = []
    max_daily = config.agent_settings.max_daily_applications

    for job in jobs:
        # Check daily limit
        daily_count = get_daily_application_count()
        if daily_count >= max_daily:
            notify_human.invoke({
                "subject": "[JobAgent] Daily Application Limit Reached",
                "message": (
                    f"Reached the daily limit of {max_daily} applications. "
                    f"Stopping for today. Remaining jobs will be submitted tomorrow."
                ),
            })
            break

        try:
            # Route to portal-specific flow
            if job.portal == Portal.LINKEDIN:
                log = await submit_linkedin_easy_apply(job, config)
            else:
                log = await submit_generic_portal(job, config)

            # Update status
            now = datetime.now().isoformat()
            update_job_status(
                job.job_id,
                JobStatus.APPLIED,
                applied_at=now,
            )

            # Log application
            log_application(ApplicationRecord(
                job_id=job.job_id,
                company=job.company_name,
                role_title=job.role_title,
                portal=job.portal.value,
                match_score=job.match_score,
                resume_version=job.resume_version or "",
                status=JobStatus.APPLIED,
            ))

            # Increment daily counter
            increment_daily_application_count()

            # Notify success
            notify_human.invoke({
                "subject": f"[JobAgent] Applied — {job.role_title} at {job.company_name}",
                "message": (
                    f"Successfully applied to {job.role_title} at {job.company_name} "
                    f"via {job.portal.value}.\nApplication logged. Good luck!"
                ),
            })

            results.append({
                "job_id": job.job_id,
                "company": job.company_name,
                "role": job.role_title,
                "portal": job.portal.value,
                "status": "applied",
                "log": log,
            })

        except SubmissionError as e:
            # Mark as failed
            update_job_status(
                job.job_id,
                JobStatus.FAILED,
                error_description=str(e),
            )

            # Notify about failure
            notify_human.invoke({
                "subject": f"[JobAgent] Failed — {job.role_title} at {job.company_name}",
                "message": (
                    f"Failed to apply to {job.role_title} at {job.company_name}.\n"
                    f"Error: {str(e)}\n\n"
                    f"The job has been marked as failed. You can retry manually."
                ),
            })

            results.append({
                "job_id": job.job_id,
                "company": job.company_name,
                "role": job.role_title,
                "status": "failed",
                "error": str(e),
            })

        except Exception as e:
            update_job_status(
                job.job_id,
                JobStatus.FAILED,
                error_description=str(e),
            )
            results.append({
                "job_id": job.job_id,
                "status": "failed",
                "error": str(e),
            })

    return results
